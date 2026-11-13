/**
 * The recorded mainnet run that `pnpm demo --dry-run` replays (G9).
 *
 * A recording holds only data that is public once used: 1Click quotes with
 * their signed wire responses, 1Click status reads, the signed withdrawal
 * intents and the burner's signed transactions. No key, seed, passphrase
 * or token. It does tie the owner's NEAR account to the burner and the
 * payee, so publishing it gives up the privacy of that demo run.
 *
 * The replay makes no network call. Everything it calls verified is
 * checked offline from the recording itself:
 * - every quote's ed25519 signature against the 1Click manager key;
 * - every signed intent's NEP-413 signature against the signer's key, and
 *   that it pays the quote's deposit address from the owner's account;
 * - every burner transaction: its hash is the keccak of the signed bytes,
 *   its sender recovers to the burner, and it does exactly the recorded
 *   transfer on Base;
 * - every Shelter Connect session: each dapp transaction and sweep transfer
 *   is signed by the dapp's own address and does what was recorded, each
 *   message or typed-data signature recovers to that address, each sweep
 *   quote is signed by 1Click, and each blocked request is blocked again by
 *   the linkage check run on the recorded request.
 */

import type { BurnerJob, FundingLeg, SignedTx } from "@shelter/burner";
import { BURNER_ASSETS, BASE_CHAIN_ID } from "@shelter/burner";
import { formatBaseUnits, verifyNep413, verifyQuoteSignature, type Quote, type StatusResult } from "@shelter/intents";
import { base64 } from "@scure/base";
import { blocks, buildIdentity, inspect, parseRequest, type ConnectAccount } from "@shelter/connect";
import { decodeFunctionData, erc20Abi, getAddress, keccak256, parseTransaction, recoverTransactionAddress, verifyMessage, verifyTypedData, type Hex } from "viem";

export const RECORDING_FORMAT = "shelter-demo-recording";

export interface DepositRecord {
  quote: Quote;
  txHash?: string;
  statuses: { at: string; status: StatusResult }[];
}

export interface DemoRecording {
  format: typeof RECORDING_FORMAT;
  v: 1;
  recordedAt: string;
  network: "mainnet";
  owner: string;
  deposits: DepositRecord[];
  burners: BurnerJob[];
  /** Shelter Connect sessions; their funding jobs are in `burners`. Optional, so older recordings still parse. */
  connect?: ConnectRecording[];
}

export interface ConnectRecording {
  account: ConnectAccount;
  /**
   * The linked identities that blocked requests named, and only those, so the
   * replay can run the linkage check again. Address or NEAR id, and its label.
   */
  linked: { id: string; label: string }[];
}

export function buildRecording(
  owner: string,
  deposits: DepositRecord[],
  burners: BurnerJob[],
  now = new Date(),
  connect: ConnectRecording[] = [],
): DemoRecording {
  return {
    format: RECORDING_FORMAT,
    v: 1,
    recordedAt: now.toISOString(),
    network: "mainnet",
    owner,
    deposits,
    burners: burners.map(({ lease: _lease, ...j }) => j as BurnerJob),
    ...(connect.length ? { connect } : {}),
  };
}

/** The linked identities a Connect account's blocked requests name (nothing else from the linked list is recorded). */
export function namedByBlocks(account: ConnectAccount, linked: { id: string; label: string }[]): { id: string; label: string }[] {
  const text = account.requests
    .filter((r) => r.decision === "blocked")
    .flatMap((r) => r.findings.filter((f) => f.level === "block").map((f) => f.message.toLowerCase()))
    .join("\n");
  return linked.filter((l) => text.includes(l.id.toLowerCase()));
}

export function parseRecording(raw: unknown): DemoRecording {
  const r = raw as Partial<DemoRecording> | null;
  if (
    !r ||
    r.format !== RECORDING_FORMAT ||
    r.v !== 1 ||
    !Array.isArray(r.deposits) ||
    !Array.isArray(r.burners) ||
    (r.connect !== undefined && !Array.isArray(r.connect))
  ) {
    throw new Error("not a shelter demo recording (format v1)");
  }
  return r as DemoRecording;
}

/**
 * The quote's signature covers its wire response; the replay reads the mapped
 * fields next to it, so they must be the ones that were signed.
 */
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

const scan = (hash: string) => `https://basescan.org/tx/${hash}`;

interface Report {
  ok: number;
  failed: string[];
}

function check(rep: Report, label: string, pass: boolean, indent = "     ") {
  console.log(`${indent}[${pass ? "PASS" : "FAIL"}] ${label}`);
  if (pass) rep.ok++;
  else rep.failed.push(label);
}

function fmt(assetId: string, amount: string): string {
  const a = Object.values(BURNER_ASSETS).find((x) => x.assetId === assetId);
  return a ? `${formatBaseUnits(amount, a.decimals)} ${a.symbol}` : `${amount} ${assetId}`;
}

function timeline(statuses: { at: string; status: StatusResult }[]): string {
  if (!statuses.length) return "no status recorded";
  const t0 = Date.parse(statuses[0]!.at);
  return statuses.map((s) => `${s.status.status} (+${Math.round((Date.parse(s.at) - t0) / 1000)} s)`).join(" -> ");
}

async function checkTx(rep: Report, tx: SignedTx, burner: `0x${string}`, expect: { token: `0x${string}`; to: string; amount: bigint }) {
  console.log(`     tx ${tx.hash}`);
  console.log(`        ${scan(tx.hash)}`);
  check(rep, "hash is the keccak-256 of the signed bytes", keccak256(tx.raw) === tx.hash, "        ");
  let sender: string | undefined;
  try {
    sender = await recoverTransactionAddress({ serializedTransaction: tx.raw as Hex & `0x02${string}` });
  } catch {
    /* reported below */
  }
  check(rep, `signed by the burner ${burner}`, sender !== undefined && getAddress(sender) === getAddress(burner), "        ");
  let ok = false;
  try {
    const p = parseTransaction(tx.raw);
    const d = decodeFunctionData({ abi: erc20Abi, data: p.data! });
    ok =
      p.chainId === BASE_CHAIN_ID &&
      getAddress(p.to!) === getAddress(expect.token) &&
      d.functionName === "transfer" &&
      getAddress(d.args[0] as string) === getAddress(expect.to) &&
      (d.args[1] as bigint) === expect.amount;
  } catch {
    ok = false;
  }
  check(rep, `on Base, transfers ${formatBaseUnits(expect.amount.toString(), 6)} USDC to ${expect.to}`, ok, "        ");
  if (tx.receipt) console.log(`        mined in block ${tx.receipt.blockNumber}, ${tx.receipt.status}, fee ${formatBaseUnits(tx.receipt.feeWei, 18)} ETH`);
}

function checkLeg(rep: Report, job: BurnerJob, leg: FundingLeg, which: string) {
  const asset = BURNER_ASSETS[leg.asset];
  const pay = BURNER_ASSETS[leg.payWith ?? leg.asset];
  const into = job.action.kind === "fund" ? "the dapp address" : job.action.kind === "hold" ? "the payout address" : "the burner";
  console.log(`   ${which}: ${formatBaseUnits(leg.amount, asset.decimals)} ${asset.symbol} into ${into}, paid in ${pay.symbol} from the confidential balance`);
  leg.attempts.forEach((a, i) => {
    const q = a.quote;
    console.log(`     attempt ${i + 1}: pays ${fmt(q.request.originAssetId, q.amountIn)} for ${fmt(q.request.destinationAssetId, q.amountOut)}, outcome ${a.outcome ?? "unfinished"}`);
    check(rep, `1Click quote ${q.quoteId} signature, and the fields used are the signed ones`, verifyQuoteSignature(q.wire) && quoteMatchesWire(q));
    check(rep, `confidentiality ${q.confidentiality}`, q.confidentiality === "advanced");
    if (a.prepared) {
      const sd = a.prepared.signedData;
      let sigOk = false;
      try {
        sigOk = verifyNep413(
          { message: sd.payload.message, nonce: base64.decode(sd.payload.nonce), recipient: sd.payload.recipient },
          sd.public_key,
          sd.signature,
        );
      } catch {
        // A malformed nonce, key or signature is a failed check, not a crash.
        sigOk = false;
      }
      check(rep, `withdrawal intent signed by ${job.owner} (${sd.public_key}) on ${sd.payload.recipient}`, sigOk);
      let shapeOk = false;
      try {
        const m = JSON.parse(sd.payload.message) as { signer_id: string; intents: { intent: string; receiver_id: string }[] };
        shapeOk = m.signer_id === job.owner && m.intents.every((t) => t.intent === "transfer" && t.receiver_id === q.depositAddress);
      } catch {
        shapeOk = false;
      }
      check(rep, "intent only transfers to the quote's deposit address", shapeOk);
    }
    if (a.submitted?.intentHash) console.log(`     intent hash ${a.submitted.intentHash}`);
  });
  if (leg.confirmedBalance) console.log(`     burner balance confirmed on chain: ${formatBaseUnits(leg.confirmedBalance, asset.decimals)} ${asset.symbol}`);
}

/** Prints the replay and returns the number of failed checks. */
export async function replay(rec: DemoRecording): Promise<number> {
  const rep: Report = { ok: 0, failed: [] };
  console.log(`Shelter demo replay: a mainnet run recorded ${rec.recordedAt} by ${rec.owner}.`);
  console.log("No network, keys or funds are used; every check below runs on the recorded data.\n");

  rec.deposits.forEach((d, i) => {
    const q = d.quote;
    console.log(`${i + 1}. Private deposit into the confidential balance of ${q.request.recipient}`);
    console.log(`   send ${fmt(q.request.originAssetId, q.amountIn)} on Base to 1Click deposit address ${q.depositAddress}`);
    check(rep, `1Click quote ${q.quoteId} signature, and the fields used are the signed ones`, verifyQuoteSignature(q.wire) && quoteMatchesWire(q), "   ");
    check(rep, `confidentiality ${q.confidentiality}, refunds to the confidential balance`, q.confidentiality === "advanced" && q.request.refundType === "CONFIDENTIAL_INTENTS", "   ");
    if (d.txHash) console.log(`   deposit tx ${scan(d.txHash)}`);
    console.log(`   status ${timeline(d.statuses)}`);
    const last = d.statuses.at(-1)?.status;
    for (const t of last?.originChainTxs ?? []) console.log(`   origin tx ${t.explorerUrl || t.hash}`);
    console.log("");
  });

  for (const [k, job] of rec.burners.entries()) {
    const n = rec.deposits.length + k + 1;
    const asset = BURNER_ASSETS[job.action.asset];
    const amount = `${formatBaseUnits(job.action.amount, asset.decimals)} ${asset.symbol}`;
    const act = job.action;
    // Payouts and Connect top-ups fund an address that is kept; only a burner acts and is retired.
    const hold = act.kind !== "erc20_transfer";
    console.log(
      act.kind === "hold"
        ? `${n}. Private payout ${job.id}: a fresh address receives ${amount} plus gas from the confidential balance`
        : act.kind === "fund"
          ? `${n}. Connect funding ${job.id}: a dapp address receives ${amount} and ${formatBaseUnits(act.gasWei, 18)} ETH for gas from the confidential balance`
          : `${n}. Burner action ${job.id}: send ${amount} to ${act.to}`,
    );
    console.log(`   ${act.kind === "erc20_transfer" ? "burner" : act.kind === "fund" ? "dapp address" : "payout address"} ${job.burner?.address ?? "(not allocated)"}, final state ${job.status}/${job.step}`);
    job.gas.forEach((leg, i) => checkLeg(rep, job, leg, i === 0 ? "gas" : `gas top-up ${i}`));
    if (job.asset) checkLeg(rep, job, job.asset, "asset");
    if (job.act?.tx && job.burner && job.action.kind === "erc20_transfer") {
      console.log(`   action (${job.act.outcome ?? "unconfirmed"})`);
      await checkTx(rep, job.act.tx, job.burner.address, { token: asset.token!, to: job.action.to, amount: BigInt(job.action.amount) });
    }
    const sw = job.sweep;
    if (sw) {
      console.log(`   after the action: ${formatBaseUnits(sw.assetLeft ?? "0", asset.decimals)} ${asset.symbol} and ${formatBaseUnits(sw.ethLeft ?? "0", 18)} ETH left; ${sw.decision}`);
      if (sw.tx && job.burner && sw.quote?.depositAddress) {
        await checkTx(rep, sw.tx, job.burner.address, { token: asset.token!, to: sw.quote.depositAddress, amount: BigInt(sw.quote.amountIn) });
      }
    }
    if (act.kind === "fund") {
      console.log(`   dapp address kept for its dapp until the account is closed\n`);
    } else if (hold) {
      console.log(`   payout address kept for later use; it has never sent a transaction\n`);
    } else {
      const retired = job.events.some((e) => e.message.endsWith("retired"));
      console.log(`   burner ${retired ? "retired: never used again" : "not retired yet"}\n`);
    }
  }

  for (const [k, c] of (rec.connect ?? []).entries()) {
    await replayConnect(rep, rec, c, rec.deposits.length + rec.burners.length + k + 1);
  }

  console.log(`${rep.ok} checks passed, ${rep.failed.length} failed.`);
  for (const f of rep.failed) console.log(`  FAILED: ${f}`);
  return rep.failed.length;
}

/** Checks a transaction the dapp address signed: hash, sender, chain, and (when given) what it does. */
async function checkSignedTx(
  rep: Report,
  tx: SignedTx,
  from: `0x${string}`,
  expect: { to?: string; value?: bigint; data?: string; erc20?: { token: `0x${string}`; to: string; amount: bigint } },
  indent: string,
) {
  console.log(`${indent}tx ${scan(tx.hash)}`);
  check(rep, "hash is the keccak-256 of the signed bytes", keccak256(tx.raw) === tx.hash, `${indent}  `);
  let sender: string | undefined;
  try {
    sender = await recoverTransactionAddress({ serializedTransaction: tx.raw as Hex & `0x02${string}` });
  } catch {
    /* reported below */
  }
  check(rep, `signed by the dapp address ${from}`, sender !== undefined && getAddress(sender) === getAddress(from), `${indent}  `);
  let p: ReturnType<typeof parseTransaction> | undefined;
  try {
    p = parseTransaction(tx.raw);
  } catch {
    p = undefined;
  }
  check(rep, "on Base", p?.chainId === BASE_CHAIN_ID, `${indent}  `);
  if (!p) return;
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
    check(rep, `transfers ${expect.erc20.amount} base units of ${expect.erc20.token} to ${expect.erc20.to}`, ok, `${indent}  `);
  }
  if (expect.to !== undefined) {
    const same =
      p.to !== undefined &&
      p.to !== null &&
      getAddress(p.to) === getAddress(expect.to) &&
      (expect.value === undefined || (p.value ?? 0n) === expect.value) &&
      (expect.data === undefined || (p.data ?? "0x").toLowerCase() === expect.data.toLowerCase());
    check(rep, `does exactly what was asked: to ${expect.to}${expect.value !== undefined ? `, value ${expect.value} wei` : ""}${expect.data !== undefined ? ", same calldata" : ""}`, same, `${indent}  `);
  }
  if (tx.receipt) console.log(`${indent}  mined in block ${tx.receipt.blockNumber}, ${tx.receipt.status}, fee ${formatBaseUnits(tx.receipt.feeWei, 18)} ETH`);
}

const hexValue = (v: unknown): bigint | undefined => {
  if (v === undefined || v === null) return 0n;
  try {
    return BigInt(v as string);
  } catch {
    return undefined;
  }
};

async function replayConnect(rep: Report, rec: DemoRecording, c: ConnectRecording, n: number) {
  const a = c.account;
  const self = a.address.address;
  console.log(`${n}. Shelter Connect session ${a.id} with ${a.dapp.name ? `${a.dapp.name} (${a.dapp.origin})` : a.dapp.origin}`);
  console.log(`   dapp address ${self}: derived from the local seed, used only by this dapp, final state ${a.status}`);
  const budget = BURNER_ASSETS[a.budget.asset];
  console.log(`   budget ${formatBaseUnits(a.budget.amount, budget.decimals)} ${budget.symbol}, from the confidential balance of ${a.owner}`);
  for (const f of a.fundings) {
    const job = rec.burners.find((j) => j.id === f.jobId);
    console.log(`   funding (${f.reason}) by burner job ${f.jobId}${job ? `, replayed above (${job.status})` : ", NOT in this recording"}`);
    check(rep, `funding job ${f.jobId} is in the recording and funds this address`, !!job && job.action.kind === "fund" && getAddress(job.action.target.address) === getAddress(self), "     ");
  }

  const identity = buildIdentity({
    evm: c.linked.filter((l) => l.id.startsWith("0x")).map((l) => [l.id, l.label] as [string, string]),
    near: [...c.linked.filter((l) => !l.id.startsWith("0x")).map((l) => l.id), a.owner],
  });

  for (const r of a.requests) {
    console.log(`   request ${r.seq} ${r.method}: ${r.decision ?? "unanswered"}: ${r.summary}`);
    for (const f of r.findings) console.log(`     ${f.level} ${f.code}: ${f.message}`);
    const params = r.params as unknown[] | undefined;
    if (r.tx) {
      const t = (params?.[0] ?? undefined) as { to?: string; value?: unknown; data?: string; input?: string } | undefined;
      await checkSignedTx(
        rep,
        r.tx,
        self,
        t?.to ? { to: t.to, value: hexValue(t.value), data: t.data ?? t.input ?? "0x" } : {},
        "     ",
      );
      if (!t) console.log("       (recorded before request params were kept: what the dapp asked is shown from the summary only)");
    }
    if (r.signature && r.method === "personal_sign") {
      if (params) {
        const msg = params[0] as string;
        const ok = await verifyMessage({ address: self, message: /^0x[0-9a-f]*$/i.test(msg) ? { raw: msg as Hex } : msg, signature: r.signature as Hex }).catch(() => false);
        check(rep, "message signature recovers to the dapp address", ok, "     ");
      } else console.log("     (signature recorded; the message was not kept before 2026-11-12, so it is not re-checked)");
    }
    if (r.signature && r.method === "eth_signTypedData_v4") {
      if (params) {
        const raw = params[1];
        const td = (typeof raw === "string" ? JSON.parse(raw) : raw) as Parameters<typeof verifyTypedData>[0];
        const ok = await verifyTypedData({ ...td, address: self, signature: r.signature as Hex }).catch(() => false);
        check(rep, "typed-data signature recovers to the dapp address", ok, "     ");
      } else console.log("     (signature recorded; the typed data was not kept before 2026-11-12, so it is not re-checked)");
    }
    if (r.decision === "blocked") {
      check(rep, "nothing was signed for it", !r.tx && !r.signature, "     ");
      if (params) {
        let again: string[] = [];
        try {
          again = blocks(inspect(parseRequest(r.method, params), { self, identity, origin: a.dapp.origin })).map((f) => f.code);
        } catch {
          again = [];
        }
        const before = r.findings.filter((f) => f.level === "block" && !f.code.startsWith("origin") && !f.code.startsWith("dapp_")).map((f) => f.code);
        check(rep, `the linkage check blocks it again (${before.join(", ") || "none"})`, before.length > 0 && before.every((x) => again.includes(x)), "     ");
      } else console.log("     (blocked before request params were kept, so the block is shown, not re-run)");
    }
  }

  const sw = a.sweep;
  if (sw) {
    console.log("   close: swept back into the confidential balance");
    for (const it of sw.items) {
      console.log(`     ${formatBaseUnits(it.balance, it.decimals)} ${it.symbol}: ${it.decision}${it.outcome ? `, ${it.outcome}` : ""}${it.note ? ` (${it.note})` : ""}`);
      if (!it.quote) continue;
      const q = it.quote;
      check(rep, `1Click quote ${q.quoteId} signature, and the fields used are the signed ones`, verifyQuoteSignature(q.wire) && quoteMatchesWire(q), "       ");
      check(
        rep,
        `deposits into the confidential balance of ${a.owner}`,
        q.request.recipient === a.owner && q.request.recipientType === "CONFIDENTIAL_INTENTS" && q.confidentiality === "advanced",
        "       ",
      );
      if (it.tx && q.depositAddress) {
        await checkSignedTx(
          rep,
          it.tx,
          self,
          it.token
            ? { erc20: { token: it.token, to: q.depositAddress, amount: BigInt(q.amountIn) } }
            : { to: q.depositAddress, value: BigInt(q.amountIn), data: "0x" },
          "       ",
        );
      }
    }
  }
  const retired = a.events.some((e) => e.message.includes("retired"));
  console.log(`   ${a.status === "closed" && retired ? "address retired: never used again" : `account ${a.status}`}\n`);
}
