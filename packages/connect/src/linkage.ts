/**
 * Linkage check: refuses any request that would tie a dapp address to the
 * user's other identities.
 *
 * The identity set is every address and account the user wants kept apart
 * from this dapp: their public wallets and NEAR accounts (configured by the
 * user), the NEAR account that owns the confidential balance, and every
 * other address Shelter derived (other dapps, payout addresses, burners).
 * A request is blocked when any of them appears in it, in any form a chain
 * or a dapp can read back:
 * - as the transaction's recipient, or anywhere in its calldata (aligned
 *   ABI words and packed encodings such as swap paths alike: the check is a
 *   substring match on the hex, which a 160-bit address cannot hit by
 *   chance), or a NEAR account id as UTF-8 in the calldata (a bridge memo);
 * - anywhere in a message or typed data to sign, with or without 0x, in any
 *   letter case.
 *
 * Warnings do not block; the approval prompt shows them.
 *
 * What this cannot see: the timing and amounts of funding and use, which an
 * observer can still correlate, and links made off chain (the dapp's own
 * logs, IP addresses). See docs/backend/CONNECT.md.
 */

import { bytesToHex, getAddress, isAddress, isHex, maxUint160, stringToBytes } from "viem";
import { BASE_CHAIN_ID, decodeErc20, messageText, type DappRequest } from "./requests.js";

export interface Identity {
  /** Lower-case EVM address → what it is (shown when it blocks). */
  evm: Map<string, string>;
  /** NEAR account ids, lower-case. */
  near: string[];
}

export type FindingCode =
  /** Set by the engine: the request did not come from the origin the address is bound to. */
  | "origin_mismatch"
  /** Set by the engine from WalletConnect Verify. */
  | "dapp_scam"
  | "dapp_unverified"
  | "wrong_account"
  | "wrong_chain"
  | "contract_creation"
  | "recipient_linked"
  | "calldata_linked"
  | "message_linked"
  | "typed_data_linked"
  | "siwe_domain"
  | "siwe_chain"
  | "typed_data_chain"
  | "unlimited_approval";

export interface Finding {
  level: "block" | "warn";
  code: FindingCode;
  message: string;
}

export interface InspectContext {
  /** This dapp's address. */
  self: `0x${string}`;
  identity: Identity;
  /** The dapp's origin, e.g. https://app.uniswap.org. */
  origin: string;
}

const block = (code: FindingCode, message: string): Finding => ({ level: "block", code, message });
const warn = (code: FindingCode, message: string): Finding => ({ level: "warn", code, message });

/** Identity entries found in a hex blob (calldata or a raw message). */
function inHex(hex: string, id: Identity): string[] {
  const h = hex.toLowerCase();
  const hits: string[] = [];
  for (const [a, label] of id.evm) if (h.includes(a.slice(2))) hits.push(`${label} (${getAddress(a)})`);
  for (const n of id.near) if (n.length >= 2 && h.includes(bytesToHex(stringToBytes(n)).slice(2))) hits.push(`NEAR account ${n}`);
  return hits;
}

/**
 * A NEAR account id as a whole name. A sub-account (alice.carol.near) still
 * names its parent publicly, so a dot before the id counts as a match; a
 * different name that only ends the same way (alice-carol.near) does not.
 */
const nearPattern = (n: string) => new RegExp(`(^|[^a-z0-9_-])${n.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}($|[^a-z0-9_-])`, "i");

/** Identity entries found in text. */
function inText(text: string, id: Identity): string[] {
  const t = text.toLowerCase();
  const hits: string[] = [];
  for (const [a, label] of id.evm) if (t.includes(a.slice(2))) hits.push(`${label} (${getAddress(a)})`);
  for (const n of id.near) if (nearPattern(n).test(t)) hits.push(`NEAR account ${n}`);
  return hits;
}

function walk(v: unknown, visit: (s: string) => void, depth = 0) {
  if (depth > 32) return;
  if (typeof v === "string") visit(v);
  else if (typeof v === "number" || typeof v === "bigint") visit(String(v));
  else if (Array.isArray(v)) for (const x of v) walk(x, visit, depth + 1);
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) {
    visit(k);
    walk(x, visit, depth + 1);
  }
}

const SIWE = /^(\S+) wants you to sign in with your Ethereum account:\n(0x[0-9a-fA-F]{40})/;

function hostOf(origin: string): string {
  try {
    return new URL(origin).host.toLowerCase();
  } catch {
    return origin.toLowerCase();
  }
}

export function inspect(req: DappRequest, ctx: InspectContext): Finding[] {
  const out: Finding[] = [];
  const self = ctx.self.toLowerCase();
  const id: Identity = {
    evm: new Map([...ctx.identity.evm].filter(([a]) => a !== self)),
    near: ctx.identity.near.map((n) => n.toLowerCase()),
  };

  switch (req.method) {
    case "eth_sendTransaction": {
      const t = req.tx;
      if (t.from && t.from.toLowerCase() !== self) out.push(block("wrong_account", `the dapp asked to send from ${t.from}, not this dapp's address`));
      if (t.chainId !== undefined && t.chainId !== BASE_CHAIN_ID) out.push(block("wrong_chain", `the transaction is for chain ${t.chainId}, not Base`));
      if (!t.to) {
        out.push(block("contract_creation", "contract creation is not supported"));
        break;
      }
      const toLabel = id.evm.get(t.to.toLowerCase());
      if (toLabel) out.push(block("recipient_linked", `it sends to ${toLabel} (${t.to})`));
      const hits = t.data ? inHex(t.data, id) : [];
      if (hits.length) out.push(block("calldata_linked", `its data names ${hits.join(", ")}`));
      const e = decodeErc20(t.data);
      if (e?.fn === "approve" && e.amount >= maxUint160) out.push(warn("unlimited_approval", `unlimited token approval for ${e.spender}`));
      break;
    }
    case "personal_sign": {
      if (req.address.toLowerCase() !== self) out.push(block("wrong_account", `the dapp asked ${req.address} to sign, not this dapp's address`));
      const text = messageText(req.message);
      // Readable text is checked as text; a binary message (not UTF-8) is checked as hex.
      const binary = isHex(req.message) && text === req.message;
      const hits = [...new Set([...inText(text, id), ...(binary ? inHex(req.message, id) : [])])];
      if (hits.length) out.push(block("message_linked", `the message names ${hits.join(", ")}`));
      const siwe = SIWE.exec(text);
      if (siwe) {
        const host = hostOf(ctx.origin);
        if (siwe[1]!.toLowerCase() !== host) out.push(block("siwe_domain", `sign-in is for ${siwe[1]}, but the request comes from ${host}`));
        const chain = /\nChain ID: (\d+)/.exec(text)?.[1];
        if (chain && Number(chain) !== BASE_CHAIN_ID) out.push(warn("siwe_chain", `sign-in names chain ${chain}, not Base`));
      }
      break;
    }
    case "eth_signTypedData_v4": {
      if (req.address.toLowerCase() !== self) out.push(block("wrong_account", `the dapp asked ${req.address} to sign, not this dapp's address`));
      const hits = new Set<string>();
      walk({ domain: req.typedData.domain, message: req.typedData.message }, (s) => {
        if (isAddress(s, { strict: false })) {
          const label = id.evm.get(s.toLowerCase());
          if (label) hits.add(`${label} (${getAddress(s)})`);
        }
        for (const h of inText(s, id)) hits.add(h);
      });
      if (hits.size) out.push(block("typed_data_linked", `the data to sign names ${[...hits].join(", ")}`));
      const chain = (req.typedData.domain as { chainId?: unknown } | undefined)?.chainId;
      if (chain !== undefined && Number(chain) !== BASE_CHAIN_ID) out.push(warn("typed_data_chain", `the signature is for chain ${String(chain)}, not Base`));
      const m = req.typedData.message as Record<string, unknown>;
      const amounts = [m.value, (m.details as Record<string, unknown> | undefined)?.amount, (m.permitted as Record<string, unknown> | undefined)?.amount];
      if (amounts.some((v) => (typeof v === "string" || typeof v === "number") && /^[0-9]+$/.test(String(v)) && BigInt(v) >= maxUint160)) {
        out.push(warn("unlimited_approval", "the signature grants an unlimited token allowance"));
      }
      break;
    }
    default:
      break;
  }
  return out;
}

export const blocks = (f: Finding[]) => f.filter((x) => x.level === "block");

/** Normalizes user-configured identities: checksummed addresses, lower-case NEAR ids. */
export function buildIdentity(input: { evm?: Iterable<[string, string]>; near?: Iterable<string> }): Identity {
  const evm = new Map<string, string>();
  for (const [a, label] of input.evm ?? []) {
    if (!isAddress(a, { strict: false })) throw new Error(`not an EVM address: ${a}`);
    evm.set(a.toLowerCase(), label);
  }
  const near = [...new Set([...(input.near ?? [])].map((n) => n.trim().toLowerCase()).filter(Boolean))];
  return { evm, near };
}

