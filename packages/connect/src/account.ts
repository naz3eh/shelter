/**
 * A Connect account: one derived address bound to one dapp origin, funded
 * from the confidential balance, used only by that dapp, swept back and
 * retired when the user closes it.
 *
 *   open -> (requests, top-ups) -> closing -> closed
 *
 * Like a burner job it is persisted and resumable, and every outside effect
 * is recorded first in a form that is safe to repeat: a signed transaction
 * (with its hash) before it is broadcast, a sweep quote and its signed
 * transfer before they are sent. It holds no secret, but it ties the dapp to
 * the address, so it stays on the user's device.
 */

import type { BurnerAssetKey, SignedTx } from "@shelter/burner";
import type { IntentStatus, Quote } from "@shelter/intents";
import { ConnectError } from "./errors.js";
import type { Finding } from "./linkage.js";

export const ACCOUNT_FORMAT_VERSION = 1;

export type AccountStatus = "open" | "closing" | "closed";

export interface DappInfo {
  /** Origin the account is bound to, e.g. https://app.uniswap.org (scheme + host, lower-case). */
  origin: string;
  name?: string;
  url?: string;
}

export interface Budget {
  /** What the address receives to spend in the dapp. */
  asset: BurnerAssetKey;
  /** Base units. */
  amount: string;
  /** Confidential balance asset that pays for it and for gas. */
  payWith: BurnerAssetKey;
}

export interface Funding {
  /** Burner engine job (kind "fund") that delivers it. */
  jobId: string;
  at: string;
  reason: "open" | "gas" | "value" | "sweep_gas" | "manual";
}

export type RequestDecision = "signed" | "sent" | "blocked" | "rejected" | "failed" | "not_sent";

export interface RequestRecord {
  /** Monotonic within the account. */
  seq: number;
  at: string;
  /** Dapp's JSON-RPC id, as text. */
  rpcId?: string;
  method: string;
  /** Origin the request came from, as the transport reported it. */
  origin: string;
  summary: string;
  /**
   * The request's params exactly as the dapp sent them (for a demo replay to
   * re-check the signature or the block offline). Absent on records made
   * before 2026-11-12.
   */
  params?: unknown;
  findings: Finding[];
  decision?: RequestDecision;
  /** Persisted signed before it is broadcast. */
  tx?: SignedTx & { value: string };
  /** Signature returned for personal_sign and typed data. */
  signature?: string;
  error?: string;
}

export interface SweepItem {
  /** 1Click asset id. */
  assetId: string;
  symbol: string;
  decimals: number;
  /** ERC-20 contract; absent for native ETH. */
  token?: `0x${string}`;
  /** Balance read when the sweep was planned, base units. */
  balance: string;
  decision: "deposit" | "dust" | "no_gas";
  note?: string;
  quote?: Quote;
  tx?: SignedTx & { value: string };
  depositNotified?: boolean;
  status?: IntentStatus;
  outcome?: "returned" | "refunded";
}

export interface SweepState {
  startedAt: string;
  /** Set once the balances were read and the plan approved. */
  planned?: boolean;
  items: SweepItem[];
  /** Tokens 1Click cannot take back; they stay on the retired address, recoverable from the seed. */
  unsupported?: string[];
}

export interface AccountEvent {
  at: string;
  message: string;
}

export interface ConnectAccount {
  v: typeof ACCOUNT_FORMAT_VERSION;
  id: string;
  createdAt: string;
  updatedAt: string;
  status: AccountStatus;
  /** NEAR account that owns the confidential balance. */
  owner: string;
  chain: "base";
  dapp: DappInfo;
  address: { index: number; address: `0x${string}` };
  budget: Budget;
  fundings: Funding[];
  requests: RequestRecord[];
  sweep?: SweepState;
  attention?: string;
  events: AccountEvent[];
}

export interface StoredAccount {
  account: ConnectAccount;
  rev: number;
}

export interface AccountStore {
  get(id: string): Promise<StoredAccount | null>;
  list(): Promise<StoredAccount[]>;
  /** Fails with `busy` if the id exists. */
  create(account: ConnectAccount): Promise<StoredAccount>;
  /** Compare-and-swap on the revision. */
  update(account: ConnectAccount, rev: number): Promise<StoredAccount>;
  close?(): void;
}

export function createMemoryAccountStore(): AccountStore {
  const rows = new Map<string, { json: string; rev: number }>();
  const read = (r: { json: string; rev: number }): StoredAccount => ({ account: parseAccount(JSON.parse(r.json)), rev: r.rev });
  return {
    async get(id) {
      const r = rows.get(id);
      return r ? read(r) : null;
    },
    async list() {
      return [...rows.values()].map(read).sort((a, b) => a.account.createdAt.localeCompare(b.account.createdAt));
    },
    async create(a) {
      if (rows.has(a.id)) throw new ConnectError("busy", `account ${a.id} already exists`);
      rows.set(a.id, { json: JSON.stringify(a), rev: 1 });
      return { account: structuredClone(a), rev: 1 };
    },
    async update(a, rev) {
      const r = rows.get(a.id);
      if (!r) throw new ConnectError("not_found", `account ${a.id} does not exist`);
      if (r.rev !== rev) throw new ConnectError("busy", `account ${a.id} was changed elsewhere`);
      rows.set(a.id, { json: JSON.stringify(a), rev: rev + 1 });
      return { account: structuredClone(a), rev: rev + 1 };
    },
  };
}

export function parseAccount(raw: unknown): ConnectAccount {
  const a = raw as Partial<ConnectAccount> | null;
  if (!a || typeof a !== "object") throw new ConnectError("storage", "stored account is not an object");
  if (a.v !== ACCOUNT_FORMAT_VERSION) throw new ConnectError("storage", `stored account has unsupported format version ${String(a.v)}`);
  if (typeof a.id !== "string" || typeof a.status !== "string" || !a.dapp || !a.address || !Array.isArray(a.requests) || !Array.isArray(a.fundings)) {
    throw new ConnectError("storage", "stored account is missing required fields");
  }
  return a as ConnectAccount;
}

/** Normalizes a dapp URL to the origin an account binds to. */
export function originOf(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new ConnectError("validation", `dapp origin ${JSON.stringify(url)} is not a URL`);
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) throw new ConnectError("validation", `dapp origin ${u.origin} is not https`);
  return u.origin.toLowerCase();
}
