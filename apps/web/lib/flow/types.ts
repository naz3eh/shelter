/**
 * Shared types for the G8 sample-data flow.
 *
 * Everything in this module is client-side demo state: fictional profiles,
 * UI-only plan drafts, and simulated move/burner progress. Nothing here signs
 * transactions, connects a wallet, or moves real funds.
 */

import type { FixtureProfile, ScanReport } from "@shelter/core";

export type SampleId = "exposed" | "medium" | "clean";

export const SAMPLE_IDS: SampleId[] = ["exposed", "medium", "clean"];

export type ScanStatus = "idle" | "loading" | "done" | "error";

export interface ScanSlice {
  status: ScanStatus;
  profileId: SampleId | null;
  report: ScanReport | null;
  /** The recorded fixture profile the report was computed from. */
  profile: FixtureProfile | null;
  scannedAt: string | null;
  error: string | null;
}

export type StepStatus =
  | "pending"
  | "active"
  | "completed"
  | "failed"
  | "refunded"
  | "skipped"
  | "cancelled";

export type SimStepKind =
  | "deposit"
  | "settle"
  | "wait"
  | "withdraw"
  | "create"
  | "fund"
  | "action"
  | "retire"
  | "sweep";

export interface SimStep {
  id: string;
  kind: SimStepKind;
  title: string;
  description: string;
  status: StepStatus;
  asset?: "USDC" | "ETH";
  /** Human-readable decimal amount, e.g. "25" or "0.01". */
  amount?: string;
  /** Integer base units (USDC 6dp, ETH 18dp), decimal string. */
  amountBase?: string;
  chunkIndex?: number;
  /** Fictional counterparty address involved in the step, if any. */
  counterparty?: string;
}

export type SimRunStatus = "idle" | "running" | "done" | "failed" | "cancelled";

export interface SimEvent {
  at: string;
  text: string;
}

export type MoveScenario = "happy" | "partial-funding" | "deposit-refund";
export type DemoPace = "relaxed" | "brisk";

export interface MoveSettings {
  scenario: MoveScenario;
  pace: DemoPace;
}

export interface MoveChunkResult {
  index: number;
  destination: string;
  usdc: string;
  usdcBase: string;
  eth: string;
  ethWei: string;
  depositAddress: string;
  usdcWithdrawn: boolean;
  ethWithdrawn: boolean;
}

export type MoveOutcome = "running" | "completed" | "partial" | "cancelled";

export interface MoveSimSnapshot {
  status: SimRunStatus;
  outcome: MoveOutcome;
  planHash: string;
  scenario: MoveScenario;
  pace: DemoPace;
  steps: SimStep[];
  chunks: MoveChunkResult[];
  events: SimEvent[];
  startedAt: string | null;
  finishedAt: string | null;
  message: string | null;
}

export interface PlanDraft {
  /** Number of chunks, integer string 1-4. */
  chunkCount: string;
  /** USDC per chunk, decimal string. */
  usdcPerChunk: string;
  /** ETH (gas money) per chunk, decimal string. */
  ethPerChunk: string;
  /** Demo minutes until the first private withdrawal. */
  startDelayMin: string;
  /** Demo minutes between private withdrawals. */
  spreadMin: string;
}

export interface PlanChunk {
  index: number;
  usdc: string;
  usdcBase: string;
  eth: string;
  ethWei: string;
  /** Fresh fictional destination on Base. */
  destination: string;
  /** Simulated 1Click deposit address the old wallet pays into. */
  depositAddress: string;
}

/** Immutable snapshot stored when the user approves the plan. */
export interface ApprovedPlan {
  hash: string;
  profileId: SampleId;
  approvedAt: string;
  chunks: PlanChunk[];
  timing: { firstWithdrawalDelayMin: number; spacingMin: number };
  totals: {
    usdc: string;
    usdcBase: string;
    eth: string;
    ethWei: string;
  };
  simulatedFeeUsdc: string;
}

export interface PlanApproval {
  plan: ApprovedPlan;
  approvedAt: string;
}

export interface BurnerDraft {
  /** Fictional payment recipient (0x address). */
  recipient: string;
  /** One-time USDC payment amount, decimal string. */
  amountUsdc: string;
}

/** Immutable burner plan stored on approval. */
export interface BurnerPlan {
  hash: string;
  profileId: SampleId;
  /** Hash of the approved private-move plan this burner draws from. */
  movePlanHash: string;
  approvedAt: string;
  /** Fictional one-time address — no key material exists for it. */
  burnerAddress: string;
  fundingUsdc: string;
  fundingUsdcBase: string;
  /** ETH delivered for gas through the private path. */
  fundingEth: string;
  fundingEthWei: string;
  /** Simulated gas the single action needs. */
  requiredGasEth: string;
  payment: {
    recipient: string;
    amountUsdc: string;
    amountUsdcBase: string;
  };
}

export interface BurnerApproval {
  plan: BurnerPlan;
  approvedAt: string;
}

export type BurnerScenario =
  | "happy"
  | "insufficient-gas"
  | "funding-failed"
  | "payment-failed";

export interface BurnerSettings {
  scenario: BurnerScenario;
  pace: DemoPace;
}

export interface BurnerSimSnapshot {
  status: SimRunStatus;
  planHash: string;
  scenario: BurnerScenario;
  pace: DemoPace;
  burnerAddress: string;
  fundingUsdc: string;
  fundingEth: string;
  requiredGasEth: string;
  paymentRecipient: string;
  paymentAmountUsdc: string;
  steps: SimStep[];
  /** ETH left on the burner after retirement, decimal string. */
  dustEth: string | null;
  events: SimEvent[];
  startedAt: string | null;
  finishedAt: string | null;
  message: string | null;
}

export type RescanStatus = "idle" | "running" | "done" | "error";

export interface RescanSlice {
  status: RescanStatus;
  /** Identifies which run produced afterReport (plan+move+burner signature). */
  key: string | null;
  afterReport: ScanReport | null;
  /** The generated fictional post-move fixture, kept for export/provenance. */
  afterProfile: FixtureProfile | null;
  /** Dataset-limit notes from the after-fixture builder. */
  notes: string[];
  fundedChunks: number;
  totalChunks: number;
  burnerIncluded: boolean;
  computedAt: string | null;
  error: string | null;
}

export interface FlowState {
  profileId: SampleId | null;
  scan: ScanSlice;
  planDraft: PlanDraft | null;
  planApproval: PlanApproval | null;
  moveSettings: MoveSettings;
  moveSim: MoveSimSnapshot | null;
  burnerDraft: BurnerDraft | null;
  burnerApproval: BurnerApproval | null;
  burnerSettings: BurnerSettings;
  burnerSim: BurnerSimSnapshot | null;
  rescan: RescanSlice;
}
