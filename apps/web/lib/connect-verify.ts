/**
 * Offline verification of a recorded Connect session, for the verified panel.
 *
 * Every check is computed from the recording data, the same way
 * `demo replay` checks a real run (apps/cli/src/demo/recording.ts):
 * - 1Click quote signatures against the recorded signer key, and the mapped
 *   fields against the signed wire response;
 * - NEP-413 withdrawal signatures, and that each intent only pays the
 *   quote's deposit address from the owner's account;
 * - dapp transactions: hash is the keccak of the signed bytes, the sender
 *   recovers to the dapp address, and the transaction does what was asked;
 * - blocked requests still block under the linkage check;
 * - sweeps: deposit quotes into the confidential balance and transfers
 *   signed by the dapp address.
 */

import { base64 } from "@scure/base";
import {
  CONFIDENTIAL_INTENTS_CONTRACT,
  confidentialTokenId,
  verifyNep413,
  verifyQuoteSignature,
  type Quote,
} from "@shelter/intents";
import {
  blocks,
  buildIdentity,
  inspect,
  parseRequest,
  type ConnectAccount,
  type RequestRecord,
} from "@shelter/connect";
import type { BurnerJob, FundingAttempt, SignedTx } from "@shelter/burner";
import {
  decodeFunctionData,
  erc20Abi,
  getAddress,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  verifyMessage,
  verifyTypedData,
  type Hex,
} from "viem";
import type { ConnectAccountView } from "./connect-source";
import { BASESCAN_TX, formatToken, shortHash } from "./connect-format";
import { BURNER_ASSETS } from "@shelter/burner";

export interface VerifyCheck {
  id: string;
  label: string;
  status: "pass" | "fail";
  detail?: string;
  /** Basescan transaction link when the check is about a mined transaction. */
  link?: string;
  /** Raw tx hash for the copyable-hash control. */
  hash?: string;
}

const check = (id: string, label: string, pass: boolean, extra?: Partial<VerifyCheck>): VerifyCheck => ({
  id,
  label,
  status: pass ? "pass" : "fail",
  ...extra,
});

/** The mapped quote fields must be the ones the wire signature covers. */
function quoteMatchesWire(q: Quote): boolean {
  const w = q.wire;
  if (!w?.quote || !w.quoteRequest) return false;
  return (
    q.amountIn === w.quote.amountIn &&
    q.amountOut === w.quote.amountOut &&
    (q.depositAddress ?? undefined) === (w.quote.depositAddress ?? undefined) &&
    q.request.recipient === w.quoteRequest.recipient &&
    q.request.recipientType === w.quoteRequest.recipientType &&
    q.request.refundType === w.quoteRequest.refundType &&
    q.request.originAssetId === w.quoteRequest.originAsset &&
    q.request.destinationAssetId === w.quoteRequest.destinationAsset &&
    q.confidentiality === w.quoteRequest.confidentiality
  );
}

function quoteCheck(id: string, label: string, q: Quote): VerifyCheck {
  return check(
    id,
    label,
    verifyQuoteSignature(q.wire, q.provenance.signerPublicKey) && quoteMatchesWire(q),
    { detail: `quote ${q.quoteId}` },
  );
}

function intentChecks(id: string, label: string, attempt: FundingAttempt, owner: string): VerifyCheck[] {
  const out: VerifyCheck[] = [];
  const sd = attempt.prepared?.signedData;
  if (!sd) return out;
  let sigOk = false;
  try {
    sigOk = verifyNep413(
      {
        message: sd.payload.message,
        nonce: base64.decode(sd.payload.nonce),
        recipient: sd.payload.recipient,
      },
      sd.public_key,
      sd.signature,
    );
  } catch {
    sigOk = false;
  }
  out.push(check(`${id}-sig`, `${label}: NEP-413 signature by ${owner}`, sigOk));

  let shapeOk = false;
  try {
    const m = JSON.parse(sd.payload.message) as {
      signer_id?: string;
      intents?: { intent?: string; receiver_id?: string; tokens?: Record<string, string> }[];
    };
    const q = attempt.quote;
    const origin = confidentialTokenId(q.request.originAssetId);
    shapeOk =
      m.signer_id === owner &&
      sd.payload.recipient === CONFIDENTIAL_INTENTS_CONTRACT &&
      (m.intents ?? []).every(
        (i) =>
          i.intent === "transfer" &&
          i.receiver_id === q.depositAddress &&
          Object.keys(i.tokens ?? {}).every((t) => t === origin),
      );
  } catch {
    shapeOk = false;
  }
  out.push(
    check(`${id}-shape`, `${label}: intent only pays the quote deposit address`, shapeOk),
  );
  return out;
}

const hexValue = (v: unknown): bigint | undefined => {
  if (v === undefined || v === null) return 0n;
  try {
    return BigInt(v as string);
  } catch {
    return undefined;
  }
};

async function txChecks(
  id: string,
  label: string,
  tx: SignedTx,
  self: `0x${string}`,
  expect: { to?: string; value?: bigint; data?: string; erc20?: { token: `0x${string}`; to: string; amount: bigint } },
): Promise<VerifyCheck[]> {
  const out: VerifyCheck[] = [];
  const link = { link: BASESCAN_TX(tx.hash), hash: tx.hash };
  out.push(check(`${id}-hash`, `${label}: hash matches signed bytes`, keccak256(tx.raw) === tx.hash, link));
  let sender: string | undefined;
  try {
    sender = await recoverTransactionAddress({ serializedTransaction: tx.raw as Hex & `0x02${string}` });
  } catch {
    sender = undefined;
  }
  out.push(
    check(`${id}-sender`, `${label}: signed by the dapp address`, sender !== undefined && getAddress(sender) === getAddress(self), link),
  );
  let p: ReturnType<typeof parseTransaction> | undefined;
  try {
    p = parseTransaction(tx.raw);
  } catch {
    p = undefined;
  }
  out.push(check(`${id}-chain`, `${label}: on Base`, p?.chainId === 8453, link));
  if (!p) return out;
  if (expect.erc20) {
    let ok = false;
    try {
      const d = decodeFunctionData({ abi: erc20Abi, data: p.data! });
      ok =
        getAddress(p.to!) === getAddress(expect.erc20.token) &&
        d.functionName === "transfer" &&
        getAddress(d.args[0] as string) === getAddress(expect.erc20.to) &&
        (d.args[1] as bigint) === expect.erc20.amount;
    } catch {
      ok = false;
    }
    out.push(
      check(
        `${id}-does`,
        `${label}: transfers ${expect.erc20.amount} base units to ${shortHash(expect.erc20.to)}`,
        ok,
        link,
      ),
    );
  } else if (expect.to !== undefined) {
    const same =
      p.to !== undefined &&
      p.to !== null &&
      getAddress(p.to) === getAddress(expect.to) &&
      (expect.value === undefined || (p.value ?? 0n) === expect.value) &&
      (expect.data === undefined || (p.data ?? "0x").toLowerCase() === expect.data.toLowerCase());
    out.push(check(`${id}-does`, `${label}: does what was asked`, same, link));
  }
  return out;
}

async function requestChecks(account: ConnectAccount, linked: { id: string; label: string }[]): Promise<VerifyCheck[]> {
  const out: VerifyCheck[] = [];
  const self = account.address.address;
  const identity = buildIdentity({
    evm: linked.filter((l) => l.id.startsWith("0x")).map((l) => [l.id, l.label] as [string, string]),
    near: [...linked.filter((l) => !l.id.startsWith("0x")).map((l) => l.id), account.owner],
  });
  for (const r of account.requests) {
    const tag = `request ${r.seq}`;
    if (r.tx) {
      const t = (r.params as unknown[] | undefined)?.[0] as
        | { to?: string; value?: unknown; data?: string; input?: string }
        | undefined;
      out.push(
        ...(await txChecks(`${r.seq}-tx`, `${tag} transaction ${shortHash(r.tx.hash)}`, r.tx, self, {
          ...(t?.to ? { to: t.to, value: hexValue(t.value), data: t.data ?? t.input ?? "0x" } : {}),
        })),
      );
    }
    if (r.signature && r.method === "personal_sign") {
      const params = r.params as unknown[] | undefined;
      if (params) {
        const msg = params[0] as string;
        const ok = await verifyMessage({
          address: self,
          message: /^0x[0-9a-f]*$/i.test(msg) ? { raw: msg as Hex } : msg,
          signature: r.signature as Hex,
        }).catch(() => false);
        out.push(check(`${r.seq}-sig`, `${tag}: message signature recovers to the dapp address`, ok));
      }
    }
    if (r.signature && r.method === "eth_signTypedData_v4") {
      const params = r.params as unknown[] | undefined;
      if (params) {
        const raw = params[1];
        const td = (typeof raw === "string" ? JSON.parse(raw) : raw) as Parameters<typeof verifyTypedData>[0];
        const ok = await verifyTypedData({ ...td, address: self, signature: r.signature as Hex }).catch(() => false);
        out.push(check(`${r.seq}-sig`, `${tag}: typed-data signature recovers to the dapp address`, ok));
      }
    }
    if (r.decision === "blocked") {
      const params = r.params as unknown[] | undefined;
      let again: string[] = [];
      if (params) {
        try {
          again = blocks(inspect(parseRequest(r.method, params), { self, identity, origin: account.dapp.origin })).map(
            (f) => f.code,
          );
        } catch {
          again = [];
        }
      }
      const before = r.findings
        .filter((f) => f.level === "block" && !f.code.startsWith("origin") && !f.code.startsWith("dapp_"))
        .map((f) => f.code);
      out.push(
        check(
          `${r.seq}-block`,
          `${tag}: linkage check blocks it again (${before.join(", ") || "recorded"})`,
          before.length > 0 && before.every((x) => again.includes(x)),
        ),
      );
    }
  }
  return out;
}

async function legChecks(job: BurnerJob, account: ConnectAccount): Promise<VerifyCheck[]> {
  const out: VerifyCheck[] = [];
  const all: { which: string; leg: import("@shelter/burner").FundingLeg }[] = [
    ...(job.gas ?? []).map((leg, i) => ({ which: i === 0 ? "gas" : `gas top-up ${i}`, leg })),
    ...(job.asset ? [{ which: "asset", leg: job.asset }] : []),
  ];
  for (const { which, leg } of all) {
    const asset = BURNER_ASSETS[leg.asset];
    const pay = BURNER_ASSETS[leg.payWith ?? leg.asset];
    const label = `funding ${which}: ${formatToken(leg.amount, asset.decimals, asset.symbol)} paid in ${pay.symbol}`;
    for (const [i, a] of leg.attempts.entries()) {
      out.push(quoteCheck(`${job.id}-${which}-${i}-q`, `${label}, attempt ${i + 1}: 1Click quote signature`, a.quote));
      out.push(...intentChecks(`${job.id}-${which}-${i}`, `${label}, attempt ${i + 1}`, a, account.owner));
    }
  }
  return out;
}

async function sweepChecks(account: ConnectAccount): Promise<VerifyCheck[]> {
  const out: VerifyCheck[] = [];
  const sw = account.sweep;
  if (!sw) return out;
  const self = account.address.address;
  for (const [i, item] of sw.items.entries()) {
    const label = `sweep ${item.symbol}`;
    if (!item.quote) continue;
    out.push(quoteCheck(`sweep-${i}-q`, `${label}: 1Click quote signature`, item.quote));
    const q = item.quote;
    const depositOk =
      q.request.recipient === account.owner &&
      q.request.recipientType === "CONFIDENTIAL_INTENTS" &&
      q.confidentiality === "advanced";
    out.push(check(`sweep-${i}-to`, `${label}: deposits into the confidential balance of ${account.owner}`, depositOk));
    if (item.tx && q.depositAddress) {
      out.push(
        ...(await txChecks(`sweep-${i}-tx`, label, item.tx, self, item.token
          ? { erc20: { token: item.token, to: q.depositAddress, amount: BigInt(q.amountIn) } }
          : { to: q.depositAddress, value: BigInt(q.amountIn), data: "0x" })),
      );
    }
  }
  return out;
}

/** All offline checks for one recorded session. Pass/fail comes from the data, never hardcoded. */
export async function verifySession(view: ConnectAccountView): Promise<VerifyCheck[]> {
  const { account, fundingJobs, linked } = view;
  const out: VerifyCheck[] = [];
  for (const job of fundingJobs) out.push(...(await legChecks(job, account)));
  out.push(...(await requestChecks(account, linked)));
  out.push(...(await sweepChecks(account)));
  return out;
}
