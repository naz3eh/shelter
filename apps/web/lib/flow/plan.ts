/**
 * UI-only remediation plan preview. This is NOT packages/core's
 * planRemediation (which is a stub owned by the backend lane) — it is a
 * clearly labeled demo draft that the simulated move consumes. Amounts are
 * validated in integer base units; totals are checked against budgets.
 */

import type { FixtureProfile } from "@shelter/core";
import {
  baseToDecimalString,
  decimalToBase,
  ETH_DECIMALS,
  formatUnits,
  USDC_DECIMALS,
} from "./money";
import type {
  ApprovedPlan,
  PlanChunk,
  PlanDraft,
  SampleId,
} from "./types";

/** Illustrative USDC the demo pretends the old wallet holds — NOT a live balance. */
export const SIMULATED_USDC_BUDGET = "250";

export const DEFAULT_PLAN_DRAFT: PlanDraft = {
  chunkCount: "2",
  usdcPerChunk: "25",
  ethPerChunk: "0.01",
  startDelayMin: "60",
  spreadMin: "30",
};

export interface PlanValidation {
  ok: boolean;
  errors: string[];
  /** Always-on honesty notes (correlation, trusted operators, simulated fee). */
  warnings: string[];
}

export interface PlanContext {
  profileId: SampleId;
  /** Sum of recorded native balances across scanned EVM wallets, wei. */
  ethBudgetWei: bigint;
}

export function ethBudgetFromProfile(profile: FixtureProfile): bigint {
  let total = 0n;
  for (const account of Object.values(profile.accounts)) {
    if (!account.balanceWei) continue;
    try {
      total += BigInt(account.balanceWei);
    } catch {
      // ignore malformed fixture entries
    }
  }
  return total;
}

const parseCount = (value: string): number | null => {
  if (!/^\d+$/.test(value.trim())) return null;
  const n = Number(value.trim());
  return Number.isInteger(n) ? n : null;
};

const parseMinutes = (value: string): number | null => {
  const n = Number(value.trim());
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
};

export function validatePlanDraft(
  draft: PlanDraft,
  ctx: PlanContext,
): PlanValidation {
  const errors: string[] = [];

  const count = parseCount(draft.chunkCount);
  if (count === null || count < 1 || count > 4) {
    errors.push("Chunk count must be a whole number between 1 and 4.");
  }

  const usdcBase = decimalToBase(draft.usdcPerChunk, USDC_DECIMALS);
  if (usdcBase === null) {
    errors.push(
      `USDC per chunk must be a non-negative decimal with at most ${USDC_DECIMALS} decimals.`,
    );
  }
  const ethWei = decimalToBase(draft.ethPerChunk, ETH_DECIMALS);
  if (ethWei === null) {
    errors.push(
      `ETH per chunk must be a non-negative decimal with at most ${ETH_DECIMALS} decimals.`,
    );
  }

  const startDelay = parseMinutes(draft.startDelayMin);
  const spread = parseMinutes(draft.spreadMin);
  if (startDelay === null) errors.push("Start delay must be a non-negative number of minutes.");
  if (spread === null) errors.push("Spacing must be a non-negative number of minutes.");

  if (count !== null && count >= 1 && count <= 4 && usdcBase !== null && ethWei !== null) {
    const totalUsdc = usdcBase * BigInt(count);
    const totalEth = ethWei * BigInt(count);
    const usdcBudgetBase = decimalToBase(SIMULATED_USDC_BUDGET, USDC_DECIMALS)!;
    if (totalUsdc > usdcBudgetBase) {
      errors.push(
        `Total USDC (${formatUnits(totalUsdc.toString(), USDC_DECIMALS)}) exceeds the simulated balance of ${SIMULATED_USDC_BUDGET} USDC.`,
      );
    }
    if (totalEth > ctx.ethBudgetWei) {
      errors.push(
        `Total ETH (${formatUnits(totalEth.toString(), ETH_DECIMALS)}) exceeds the recorded fixture balance of ${formatUnits(ctx.ethBudgetWei.toString(), ETH_DECIMALS)} ETH.`,
      );
    }
    if (totalUsdc === 0n && totalEth === 0n) {
      errors.push("The plan moves nothing — set a USDC or ETH amount per chunk.");
    }
  }

  const warnings = [
    "Round chunks and timing can still correlate deposit and withdrawal on a quiet route — the private rail has trusted operators.",
    "Amounts and delays shown here are a UI-only preview; the 0.2% fee figure is a simulated estimate, not a live quote.",
  ];

  return { ok: errors.length === 0, errors, warnings };
}

/** Deterministic fictional addresses for destinations/deposit addresses. */
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function demoAddress(
  kind: string,
  seed: string,
  index = 0,
): Promise<string> {
  const hex = await sha256Hex(`shelter:demo:${kind}:${seed}:${index}`);
  return `0x${hex.slice(0, 40)}`;
}

/**
 * Build the immutable approved-plan snapshot from a valid draft. Addresses
 * are derived from the draft content, so editing the plan yields a different
 * destination set — a changed plan can never reuse an old approval.
 */
export async function buildApprovedPlan(
  draft: PlanDraft,
  ctx: PlanContext,
): Promise<{ plan: ApprovedPlan } | { errors: string[] }> {
  const validation = validatePlanDraft(draft, ctx);
  if (!validation.ok) return { errors: validation.errors };

  const count = parseCount(draft.chunkCount)!;
  const usdcBase = decimalToBase(draft.usdcPerChunk, USDC_DECIMALS)!;
  const ethWei = decimalToBase(draft.ethPerChunk, ETH_DECIMALS)!;
  const startDelay = parseMinutes(draft.startDelayMin)!;
  const spread = parseMinutes(draft.spreadMin)!;

  const canonical = JSON.stringify({
    p: ctx.profileId,
    c: count,
    u: draft.usdcPerChunk.trim(),
    e: draft.ethPerChunk.trim(),
    s: startDelay,
    w: spread,
  });
  const hash = (await sha256Hex(`shelter:plan:${canonical}`)).slice(0, 16);

  const chunks: PlanChunk[] = [];
  for (let i = 0; i < count; i++) {
    chunks.push({
      index: i,
      usdc: baseToDecimalString((usdcBase * 1n).toString(), USDC_DECIMALS),
      usdcBase: (usdcBase * 1n).toString(),
      eth: baseToDecimalString(ethWei.toString(), ETH_DECIMALS),
      ethWei: ethWei.toString(),
      destination: await demoAddress("destination", hash, i),
      depositAddress: await demoAddress("deposit", hash, i),
    });
  }

  const totalUsdcBase = usdcBase * BigInt(count);
  const totalEthWei = ethWei * BigInt(count);
  // Simulated 0.2% Intents fee on the USDC leg — illustrative, not a quote.
  const feeBase = (totalUsdcBase * 2n) / 1000n;

  return {
    plan: {
      hash,
      profileId: ctx.profileId,
      approvedAt: new Date().toISOString(),
      chunks,
      timing: {
        firstWithdrawalDelayMin: startDelay,
        spacingMin: spread,
      },
      totals: {
        usdc: baseToDecimalString(totalUsdcBase.toString(), USDC_DECIMALS),
        usdcBase: totalUsdcBase.toString(),
        eth: baseToDecimalString(totalEthWei.toString(), ETH_DECIMALS),
        ethWei: totalEthWei.toString(),
      },
      simulatedFeeUsdc: baseToDecimalString(feeBase.toString(), USDC_DECIMALS),
    },
  };
}

export interface ApprovalRecord {
  owner: string;
  spender: string;
  token: string;
  txHash: string;
  chain: string;
}

/** Open approvals recorded in the fixture profile, for revoke preview. */
export function approvalPreview(profile: FixtureProfile): ApprovalRecord[] {
  const seen = new Set<string>();
  const out: ApprovalRecord[] = [];
  for (const account of Object.values(profile.accounts)) {
    for (const a of account.approvals ?? []) {
      const key = `${a.owner}:${a.spender}:${a.token}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        owner: a.owner,
        spender: a.spender,
        token: a.token,
        txHash: a.txHash,
        chain: a.chain,
      });
    }
  }
  return out;
}
