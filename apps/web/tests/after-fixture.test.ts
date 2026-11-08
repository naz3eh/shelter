import { describe, expect, it } from "vitest";
import { FixtureReader, scanWallets, type WalletRef } from "@shelter/core";
import { buildApprovedPlan, DEFAULT_PLAN_DRAFT } from "@/lib/flow/plan";
import { buildAfterProfile } from "@/lib/flow/sim/after-fixture";
import { MoveSimulation, type MoveEngineOptions } from "@/lib/flow/sim/move";
import { BurnerSimulation } from "@/lib/flow/sim/burner";
import type {
  ApprovedPlan,
  BurnerPlan,
  BurnerSimSnapshot,
  MoveSimSnapshot,
  SimStepKind,
} from "@/lib/flow/types";

const FAST: Partial<Record<SimStepKind, number>> = {
  deposit: 2, settle: 2, wait: 5, withdraw: 2,
  create: 2, fund: 2, action: 2, retire: 2, sweep: 2,
};

async function runMoveToDone(plan: ApprovedPlan): Promise<MoveSimSnapshot> {
  let snap: MoveSimSnapshot | null = null;
  const sim = new MoveSimulation({
    plan, scenario: "happy", pace: "brisk", durations: FAST,
    onSnapshot: (s) => (snap = s),
  });
  sim.start();
  await waitFor(() => snap?.status === "done");
  sim.dispose();
  return snap!;
}

function burnerPlan(): BurnerPlan {
  return {
    hash: "burnhash00000001",
    profileId: "exposed",
    movePlanHash: "x",
    approvedAt: new Date().toISOString(),
    burnerAddress: "0x" + "d".repeat(40),
    fundingUsdc: "11",
    fundingUsdcBase: "11000000",
    fundingEth: "0.0003",
    fundingEthWei: "300000000000000",
    requiredGasEth: "0.00021",
    payment: {
      recipient: "0x" + "e".repeat(40),
      amountUsdc: "10",
      amountUsdcBase: "10000000",
    },
  };
}

async function runBurnerToDone(): Promise<BurnerSimSnapshot> {
  let snap: BurnerSimSnapshot | null = null;
  const sim = new BurnerSimulation({
    plan: burnerPlan(), scenario: "happy", pace: "brisk", durations: FAST,
    onSnapshot: (s) => (snap = s),
  });
  sim.start();
  await waitFor(() => snap?.status === "done");
  sim.dispose();
  return snap!;
}

function waitFor(pred: () => boolean, timeoutMs = 8000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (pred()) return resolve();
      if (Date.now() - t0 > timeoutMs) return reject(new Error("timeout"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe("buildAfterProfile", () => {
  it("produces a scannable fictional fixture with funded destinations", async () => {
    const r = await buildApprovedPlan(DEFAULT_PLAN_DRAFT, {
      profileId: "exposed",
      ethBudgetWei: 10n ** 18n,
    });
    if (!("plan" in r)) throw new Error("no plan");
    const moveSim = await runMoveToDone(r.plan);
    const built = await buildAfterProfile({
      profileId: "exposed",
      planHash: r.plan.hash,
      moveSim,
      burnerSim: null,
      burnerPlan: null,
    });
    expect(built.fundedChunks).toBe(2);
    expect(built.totalChunks).toBe(2);
    expect(built.burnerIncluded).toBe(false);
    expect(built.notes.length).toBeGreaterThan(0);
    // The generated profile must be valid input for the real scanner.
    const report = await scanWallets(
      built.profile.wallets as WalletRef[],
      new FixtureReader(built.profile),
    );
    expect(report.score).toBeGreaterThanOrEqual(0);
    expect(report.score).toBeLessThanOrEqual(100);
    // New destination wallets exist in the after dataset.
    const dests = new Set(r.plan.chunks.map((c) => c.destination.toLowerCase()));
    const scanned = new Set(
      built.profile.wallets.map((w) => w.address.toLowerCase()),
    );
    for (const d of dests) expect(scanned.has(d)).toBe(true);
  });

  it("includes the used burner when a completed burner sim is supplied", async () => {
    const r = await buildApprovedPlan(DEFAULT_PLAN_DRAFT, {
      profileId: "exposed",
      ethBudgetWei: 10n ** 18n,
    });
    if (!("plan" in r)) throw new Error("no plan");
    const moveSim = await runMoveToDone(r.plan);
    const burnerSim = await runBurnerToDone();
    const built = await buildAfterProfile({
      profileId: "exposed",
      planHash: r.plan.hash,
      moveSim,
      burnerSim,
      burnerPlan: burnerPlan(),
    });
    expect(built.burnerIncluded).toBe(true);
    const addrs = built.profile.wallets.map((w) => w.address.toLowerCase());
    expect(addrs).toContain(burnerPlan().burnerAddress.toLowerCase());
  });

  it("ignores a burner sim that never completed its action", async () => {
    const r = await buildApprovedPlan(DEFAULT_PLAN_DRAFT, {
      profileId: "exposed",
      ethBudgetWei: 10n ** 18n,
    });
    if (!("plan" in r)) throw new Error("no plan");
    const moveSim = await runMoveToDone(r.plan);
    // A cancelled/idle burner snapshot contributes nothing.
    const dead: BurnerSimSnapshot = {
      status: "cancelled",
      planHash: "x",
      scenario: "happy",
      pace: "brisk",
      burnerAddress: burnerPlan().burnerAddress,
      fundingUsdc: "11",
      fundingEth: "0.0003",
      requiredGasEth: "0.00021",
      paymentRecipient: "0x" + "e".repeat(40),
      paymentAmountUsdc: "10",
      steps: [],
      dustEth: null,
      events: [],
      startedAt: null,
      finishedAt: null,
      message: null,
    };
    const built = await buildAfterProfile({
      profileId: "exposed",
      planHash: r.plan.hash,
      moveSim,
      burnerSim: dead,
      burnerPlan: burnerPlan(),
    });
    expect(built.burnerIncluded).toBe(false);
  });
});
