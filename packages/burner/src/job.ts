/**
 * A burner job: one public action from a one-time address, as a persisted
 * state machine.
 *
 *   allocate -> fund_gas -> fund_asset -> act -> sweep -> retire -> done   (erc20_transfer)
 *   allocate -> fund_gas -> fund_asset -> done                            (hold: a kept payout address)
 *   allocate -> [fund_gas] -> [fund_asset] -> done                        (fund: top up a held address)
 *
 * Everything needed to resume is in the job, and every outside effect is
 * recorded before it happens in a form that is safe to repeat:
 * - a withdrawal is persisted as the signed intent before it is submitted
 *   (intents.near accepts each nonce once, so a re-submit cannot pay twice);
 * - an on-chain transaction is persisted signed, with its hash, before it is
 *   broadcast (a re-broadcast of the same bytes is the same transaction).
 * A job holds no secret: quotes, signed intents and signed transactions are
 * all public once used. It does link the burner to the action, so it stays
 * on the user's device like the address book.
 */

import type { IntentStatus, PreparedIntent, Quote, SubmittedIntent } from "@shelter/intents";
import type { Hex } from "viem";
import type { BurnerAssetKey } from "./assets.js";
import { BurnerError } from "./errors.js";

export const JOB_FORMAT_VERSION = 1;

/** The one public action. Only a plain ERC-20 transfer in this build. */
export interface Erc20TransferAction {
  kind: "erc20_transfer";
  asset: Exclude<BurnerAssetKey, "eth">;
  to: `0x${string}`;
  /** Base units. */
  amount: string;
}
/**
 * Private-move payout: fund a fresh address with an exact amount plus gas for
 * one later transfer, and keep it (not retired). The planner's "withdraw" step.
 */
export interface HoldAction {
  kind: "hold";
  asset: Exclude<BurnerAssetKey, "eth">;
  /** Base units. */
  amount: string;
}
/**
 * Top up an address the user already holds (a Connect dapp address): the
 * asset, gas, or both, from the confidential balance. No action, no sweep,
 * never retired by the job. The address must be in the address book and
 * still active; unlike a burner it may already have history.
 */
export interface FundAction {
  kind: "fund";
  target: { index: number; address: `0x${string}` };
  /** What the address receives besides gas. */
  asset: BurnerAssetKey;
  /** Base units of `asset`; "0" for a gas-only top-up. */
  amount: string;
  /** Native ETH for gas, in wei; "0" for none. Merged into the asset leg when `asset` is ETH. */
  gasWei: string;
  /** Confidential balance asset that pays for every leg. */
  payWith: BurnerAssetKey;
}
export type BurnerAction = Erc20TransferAction | HoldAction | FundAction;

export type JobStep = "allocate" | "fund_gas" | "fund_asset" | "act" | "sweep" | "retire" | "done";
export type JobStatus = "active" | "done" | "cancelled" | "needs_attention";

/** One quote-sign-submit attempt of a confidential withdrawal into the burner. */
export interface FundingAttempt {
  quote: Quote;
  prepared?: PreparedIntent;
  submitted?: SubmittedIntent & { at: string };
  /** Last submit error, kept for the record; the status read decides what happened. */
  submitError?: string;
  status?: IntentStatus;
  statusAt?: string;
  outcome?: "delivered" | "refunded" | "failed" | "expired";
}

/** A confidential withdrawal of an exact amount into the burner. */
export interface FundingLeg {
  /** What the burner receives. */
  asset: BurnerAssetKey;
  /** What the confidential balance pays with; absent means the same asset. */
  payWith?: BurnerAssetKey;
  /** Exact amount the burner must receive, base units. */
  amount: string;
  /** Burner balance of this asset just before the leg, to check the delivery against. */
  balanceBefore?: string;
  attempts: FundingAttempt[];
  /** Burner balance after delivery, read from the chain. */
  confirmedBalance?: string;
}

/** A transaction the burner signs. Persisted before broadcast. */
export interface SignedTx {
  raw: Hex;
  hash: Hex;
  nonce: number;
  gas: string;
  maxFeePerGas: string;
  to: `0x${string}`;
  description: string;
  signedAt: string;
  broadcastAt?: string;
  receipt?: { status: "success" | "reverted"; blockNumber: string; gasUsed: string; feeWei: string };
}

export interface SweepState {
  /** Balances read after the action. */
  assetLeft?: string;
  ethLeft?: string;
  decision?: "nothing_left" | "deposit" | "dust" | "no_gas";
  quote?: Quote;
  tx?: SignedTx;
  depositNotified?: boolean;
  status?: IntentStatus;
  outcome?: "returned" | "refunded" | "failed";
}

export interface JobEvent {
  at: string;
  step: JobStep;
  message: string;
}

export interface BurnerJob {
  v: typeof JOB_FORMAT_VERSION;
  id: string;
  createdAt: string;
  updatedAt: string;
  status: JobStatus;
  step: JobStep;
  /** NEAR account that owns the confidential balance; funds and refunds come from and go back to it. */
  owner: string;
  chain: "base";
  action: BurnerAction;
  /** Do not start before this time (planner delays). Checked only before anything is allocated. */
  notBefore?: string;
  /** Plan step this job executes, when it came from the planner. */
  planRef?: string;
  burner?: { index: number; address: `0x${string}` };
  /** Gas funding; a top-up adds a leg. */
  gas: FundingLeg[];
  asset?: FundingLeg;
  act?: { tx?: SignedTx; outcome?: "success" | "reverted" };
  sweep?: SweepState;
  /** Why the job stopped for a person to look at it. */
  attention?: string;
  events: JobEvent[];
  /** Who is running it now, so a second runner backs off. */
  lease?: { holder: string; until: string };
}

export interface StoredJob {
  job: BurnerJob;
  /** Increases on every write; writes must name the revision they read. */
  rev: number;
}

export interface JobStore {
  get(id: string): Promise<StoredJob | null>;
  list(): Promise<StoredJob[]>;
  /** Fails with `busy` if the id exists. */
  create(job: BurnerJob): Promise<StoredJob>;
  /** Compare-and-swap: fails with `busy` unless the stored revision is `rev`. */
  update(job: BurnerJob, rev: number): Promise<StoredJob>;
  close?(): void;
}

/** Process-local store. Not durable; for tests and one-off runs. */
export function createMemoryJobStore(): JobStore {
  const rows = new Map<string, { json: string; rev: number }>();
  const read = (r: { json: string; rev: number }): StoredJob => ({ job: parseJob(JSON.parse(r.json)), rev: r.rev });
  return {
    async get(id) {
      const r = rows.get(id);
      return r ? read(r) : null;
    },
    async list() {
      return [...rows.values()].map(read).sort((a, b) => a.job.createdAt.localeCompare(b.job.createdAt));
    },
    async create(job) {
      if (rows.has(job.id)) throw new BurnerError("busy", `job ${job.id} already exists`);
      rows.set(job.id, { json: JSON.stringify(job), rev: 1 });
      return { job: structuredClone(job), rev: 1 };
    },
    async update(job, rev) {
      const r = rows.get(job.id);
      if (!r) throw new BurnerError("not_found", `job ${job.id} does not exist`);
      if (r.rev !== rev) throw new BurnerError("busy", `job ${job.id} was changed by another runner`);
      rows.set(job.id, { json: JSON.stringify(job), rev: rev + 1 });
      return { job: structuredClone(job), rev: rev + 1 };
    },
  };
}

/** Minimal structural check of a stored job; refuses unknown versions. */
export function parseJob(raw: unknown): BurnerJob {
  const j = raw as Partial<BurnerJob> | null;
  if (!j || typeof j !== "object") throw new BurnerError("storage", "stored job is not an object");
  if (j.v !== JOB_FORMAT_VERSION) throw new BurnerError("storage", `stored job has unsupported format version ${String(j.v)}`);
  if (typeof j.id !== "string" || typeof j.step !== "string" || typeof j.status !== "string" || !j.action || !Array.isArray(j.gas)) {
    throw new BurnerError("storage", "stored job is missing required fields");
  }
  return j as BurnerJob;
}
