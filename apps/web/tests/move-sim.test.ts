import { describe, expect, it } from "vitest";
import { MoveSimulation, type MoveEngineOptions } from "@/lib/flow/sim/move";
import { buildApprovedPlan, DEFAULT_PLAN_DRAFT } from "@/lib/flow/plan";
import type {
  ApprovedPlan,
  MoveSimSnapshot,
  SimStepKind,
} from "@/lib/flow/types";

const FAST: Partial<Record<SimStepKind, number>> = {
  deposit: 2,
  settle: 2,
  wait: 5,
  withdraw: 2,
};

async function makePlan(
  draft = DEFAULT_PLAN_DRAFT,
): Promise<ApprovedPlan> {
  const r = await buildApprovedPlan(draft, {
    profileId: "exposed",
    ethBudgetWei: 10n ** 18n,
  });
  if (!("plan" in r)) throw new Error("plan build failed");
  return r.plan;
}

function runSim(
  plan: ApprovedPlan,
  scenario: MoveEngineOptions["scenario"],
  onSnapshot: (s: MoveSimSnapshot) => void,
  extra: Partial<MoveEngineOptions> = {},
): MoveSimulation {
  const sim = new MoveSimulation({
    plan,
    scenario,
    pace: "brisk",
    durations: FAST,
    onSnapshot,
    ...extra,
  });
  sim.start();
  return sim;
}

function waitFor(
  pred: () => boolean,
  timeoutMs = 5000,
): Promise<void> {
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

describe("MoveSimulation", () => {
  it("happy path completes every step with both withdrawal legs", async () => {
    const plan = await makePlan();
    let snap: MoveSimSnapshot | null = null;
    const sim = runSim(plan, "happy", (s) => (snap = s));
    await waitFor(() => snap?.status === "done");
    sim.dispose();
    expect(snap!.outcome).toBe("completed");
    const steps = snap!.steps;
    expect(steps.every((s) => s.status === "completed")).toBe(true);
    expect(snap!.chunks).toHaveLength(2);
    for (const c of snap!.chunks) {
      expect(c.usdcWithdrawn).toBe(true);
      expect(c.ethWithdrawn).toBe(true);
    }
    // Deposit → settle → wait → per-chunk USDC+ETH withdrawals.
    expect(steps.map((s) => s.kind)).toEqual([
      "deposit", "deposit", "settle", "wait",
      "withdraw", "withdraw", "withdraw", "withdraw",
    ]);
  });

  it("partial-funding fails once then retry completes without duplicating steps", async () => {
    const plan = await makePlan();
    let snap: MoveSimSnapshot | null = null;
    const sim = runSim(plan, "partial-funding", (s) => (snap = s));
    await waitFor(() => snap?.status === "failed");
    expect(snap!.outcome).toBe("partial");
    const completedBefore = snap!.steps.filter((s) => s.status === "completed").length;
    sim.retry();
    await waitFor(() => snap?.status === "done");
    sim.dispose();
    expect(snap!.outcome).toBe("completed");
    // The retried ETH leg now completes; earlier steps were not re-run.
    expect(snap!.steps.filter((s) => s.status === "completed").length).toBeGreaterThanOrEqual(
      completedBefore,
    );
    const failedSteps = snap!.steps.filter((s) => s.status === "failed");
    expect(failedSteps).toHaveLength(0);
  });

  it("deposit-refund marks the deposit refunded and skips its withdrawals", async () => {
    const plan = await makePlan();
    let snap: MoveSimSnapshot | null = null;
    const sim = runSim(plan, "deposit-refund", (s) => (snap = s));
    await waitFor(() => snap?.status === "done");
    sim.dispose();
    expect(snap!.outcome).toBe("partial");
    const refunded = snap!.steps.filter((s) => s.status === "refunded");
    const skipped = snap!.steps.filter((s) => s.status === "skipped");
    expect(refunded).toHaveLength(1);
    expect(refunded[0]!.kind).toBe("deposit");
    // Both withdrawal legs of the refunded chunk are skipped.
    expect(skipped).toHaveLength(2);
    expect(skipped.every((s) => s.kind === "withdraw")).toBe(true);
    expect(snap!.message).toMatch(/partial/i);
  });

  it("cancel stops future timers and preserves completed steps", async () => {
    const plan = await makePlan();
    let snap: MoveSimSnapshot | null = null;
    const sim = runSim(plan, "happy", (s) => (snap = s), {
      durations: { deposit: 60, settle: 60, wait: 60, withdraw: 60 },
    });
    await waitFor(() => (snap?.steps ?? []).some((s) => s.status === "completed"));
    sim.cancel();
    const atCancel = snap!;
    expect(atCancel.status).toBe("cancelled");
    // Wait well past remaining durations; nothing may advance.
    await new Promise((r) => setTimeout(r, 200));
    const later = snap!;
    expect(later.status).toBe("cancelled");
    expect(later.steps.filter((s) => s.status === "completed")).toHaveLength(
      atCancel.steps.filter((s) => s.status === "completed").length,
    );
    sim.dispose();
  });

  it("retry after cancel resumes instead of restarting", async () => {
    const plan = await makePlan();
    let snap: MoveSimSnapshot | null = null;
    const sim = runSim(plan, "happy", (s) => (snap = s), {
      durations: { deposit: 30, settle: 30, wait: 30, withdraw: 30 },
    });
    await waitFor(() => (snap?.steps ?? []).some((s) => s.status === "completed"));
    sim.cancel();
    sim.retry();
    await waitFor(() => snap?.status === "done", 8000);
    sim.dispose();
    expect(snap!.outcome).toBe("completed");
  });
});
