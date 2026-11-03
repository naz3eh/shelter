/** Exposure engine, planner, and address book. */

import type { ExposureReport } from "./exposure/engine.js";

export type ChainId = "base" | "ethereum" | "near" | (string & {});

export interface WalletRef {
  chain: ChainId;
  address: string;
  label?: string;
}

export interface PlanStep {
  action: "fund-burner" | "deposit" | "withdraw" | "wait";
  description: string;
}

export interface RemediationPlan {
  wallet: WalletRef;
  steps: PlanStep[];
}

export function planRemediation(_report: ExposureReport): RemediationPlan {
  throw new Error("not implemented");
}

export interface AddressBook {
  list(): WalletRef[];
  add(wallet: WalletRef): void;
  remove(address: string): void;
}

export function createAddressBook(): AddressBook {
  const entries = new Map<string, WalletRef>();
  return {
    list: () => [...entries.values()],
    add: (w) => void entries.set(w.address.toLowerCase(), w),
    remove: (a) => void entries.delete(a.toLowerCase()),
  };
}

export {
  bandForScore,
  CHECK_CONFIDENCE,
  CHECKS,
  scanWallets,
} from "./exposure/engine.js";
export type {
  CheckId,
  ExposureBand,
  ExposureFinding,
  ExposureReport,
  FindingEvidence,
  ScanOptions,
  ScanReport,
  ScanWarning,
} from "./exposure/engine.js";
export { buildLinkGraph } from "./graph/index.js";
export type {
  GraphEdge,
  GraphNode,
  GraphWalletData,
  LinkGraph,
} from "./graph/index.js";
export { createLabelStore } from "./labels/index.js";
export type { LabelStore } from "./labels/index.js";
export {
  BlockscoutClient,
  createChainReader,
  FixtureReader,
} from "./reader/index.js";
export type {
  ApprovalRecord,
  ChainReader,
  ChainReaderConfig,
  FixtureAccount,
  FixtureProfile,
  NearAccountInfo,
  TokenTransferRecord,
  TxRecord,
} from "./reader/index.js";
