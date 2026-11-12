/**
 * @shelter/burner: one public action from a one-time address (G6).
 *
 * The engine (`createBurnerEngine`) runs a persisted, resumable job:
 * allocate a fresh derived address, fund its gas and the exact action amount
 * from the confidential balance, sign the one action, sweep anything left
 * back, retire the address. See ./engine.ts and ./job.ts.
 *
 * Node-only SQLite job store: `@shelter/burner/sqlite`.
 */

import type { AddressBook } from "@shelter/keys";

export { BASE_CHAIN_ID, BURNER_ASSETS, ETH_BASE, USDC_BASE } from "./assets.js";
export type { BurnerAsset, BurnerAssetKey } from "./assets.js";
export { createBaseChain } from "./chain.js";
export type { BaseChainOptions, ChainClient, Fees, Receipt, TxRequest } from "./chain.js";
export { createBurnerEngine } from "./engine.js";
export type { ApprovalRequest, BurnerEngine, BurnerEngineDeps, EngineOptions, Preview } from "./engine.js";
export { BurnerError, isBurnerError } from "./errors.js";
export { schedulePlan } from "./plan.js";
export type { MoveStep, ScheduledPlan } from "./plan.js";
export type { BurnerErrorKind } from "./errors.js";
export { createMemoryJobStore, JOB_FORMAT_VERSION, parseJob } from "./job.js";
export type {
  BurnerAction,
  BurnerJob,
  Erc20TransferAction,
  HoldAction,
  FundingAttempt,
  FundingLeg,
  JobEvent,
  JobStatus,
  JobStep,
  JobStore,
  SignedTx,
  StoredJob,
  SweepState,
} from "./job.js";

// Low-level helpers under the original entry-point names. The engine uses
// the address book directly; these are for callers that manage the steps
// themselves.

export type BurnerState = "created" | "funded" | "used" | "retired";

export interface Burner {
  id: string;
  chain: string;
  address: `0x${string}`;
  index: number;
  state: BurnerState;
  createdAt: string;
}

/** Allocates a fresh burner address from the address book. Requires an unlocked vault. */
export async function createBurner(book: AddressBook, chain = "base"): Promise<Burner> {
  const r = await book.allocate({ purpose: "burner", chain });
  return { id: `burner-${r.index}`, chain, address: r.address, index: r.index, state: "created", createdAt: r.createdAt };
}

/** Records locally that the burner has signed its one action. */
export function markUsed(burner: Burner): Burner {
  return { ...burner, state: "used" };
}

/** Retires the address permanently: the book never hands it out again. */
export async function retireBurner(book: AddressBook, burner: Burner): Promise<Burner> {
  await book.retire(burner.address);
  return { ...burner, state: "retired" };
}
