import { describe, expect, it } from "vitest";
import {
  BurnerSimulation,
  REQUIRED_GAS_WEI,
  type BurnerEngineOptions,
} from "@/lib/flow/sim/burner";
import type {
  BurnerPlan,
  BurnerScenario,
  BurnerSimSnapshot,
  SimStepKind,
} from "@/lib/flow/types";

const FAST: Partial<Record<SimStepKind, number>> = {
  create: 2,
  fund: 2,
  action: 2,
  retire: 2,
  sweep: 2,
};

function makePlan(): BurnerPlan {
  return {
    hash: "testburnerhash01",
    profileId: "exposed",
    movePlanHash: "moveplanhash0001",
    approvedAt: new Date().toISOString(),
    burnerAddress: "0x" + "b".repeat(40),
    fundingUsdc: "11",
    fundingUsdcBase: "11000000",
    fundingEth: "0.0003",
    fundingEthWei: "300000000000000",
    requiredGasEth: "0.00021",
    payment: {
      recipient: "0x" + "c".repeat(40),
      amountUsdc: "10",
      amountUsdcBase: "10000000",
    },
  };
}

function runSim(
  scenario: BurnerScenario,
  onSnapshot: (s: BurnerSimSnapshot) => void,
): BurnerSimulation {
  const sim = new BurnerSimulation({
    plan: makePlan(),
    scenario,
    pace: "brisk",
    durations: FAST,
    onSnapshot,
  });
  sim.start();
  return sim;
}

function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
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

describe("BurnerSimulation", () => {
  it("happy path: created → funded → used → retired, dust stays visible", async () => {
    let snap: BurnerSimSnapshot | null = null;
    const sim = runSim("happy", (s) => (snap = s));
    await waitFor(() => snap?.status === "done");
    sim.dispose();
    expect(snap!.steps.map((s) => s.id)).toEqual([
      "create", "fund-usdc", "fund-eth", "action", "retire", "sweep",
    ]);
    const byId = Object.fromEntries(snap!.steps.map((s) => [s.id, s.status]));
    expect(byId.create).toBe("completed");
    expect(byId["fund-usdc"]).toBe("completed");
    expect(byId["fund-eth"]).toBe("completed");
    expect(byId.action).toBe("completed");
    expect(byId.retire).toBe("completed");
    // 0.0003 funded − 0.00021 gas = 0.00009 dust < sweep min → skipped, visible.
    expect(byId.sweep).toBe("skipped");
    expect(snap!.dustEth).not.toBeNull();
    expect(Number(snap!.dustEth)).toBeGreaterThan(0);
    expect(sim.actionConsumed).toBe(true);
    // Second start is a no-op — the single action cannot repeat.
    const callsBefore = snap!.events.length;
    sim.start();
    expect(snap!.events.length).toBe(callsBefore);
  });

  it("insufficient-gas fails the payment deterministically on every retry", async () => {
    let snap: BurnerSimSnapshot | null = null;
    const sim = runSim("insufficient-gas", (s) => (snap = s));
    await waitFor(() => snap?.status === "failed");
    const actionStep = snap!.steps.find((s) => s.id === "action")!;
    expect(actionStep.status).toBe("failed");
    expect(snap!.message).toMatch(/gas/i);
    // Retry fails again — delivered gas stays short.
    sim.retry();
    await waitFor(() => snap?.status === "failed" && snap!.steps.find((s) => s.id === "action")!.status === "failed");
    sim.dispose();
    expect(REQUIRED_GAS_WEI).toBeGreaterThan(0n);
  });

  it("funding-failed leaves the burner unfunded; retries eventually fund it", async () => {
    let snap: BurnerSimSnapshot | null = null;
    const sim = runSim("funding-failed", (s) => (snap = s));
    await waitFor(() => snap?.status === "failed");
    expect(snap!.message).toMatch(/funding failed/i);
    // Each funding leg fails once, then succeeds on the next attempt.
    sim.retry();
    await waitFor(() => snap?.status === "failed" || snap?.status === "done", 8000);
    if (snap!.status === "failed") {
      sim.retry();
      await waitFor(() => snap?.status === "done", 8000);
    }
    sim.dispose();
    expect(snap!.status).toBe("done");
    const byId = Object.fromEntries(snap!.steps.map((s) => [s.id, s.status]));
    expect(byId["fund-usdc"]).toBe("completed");
    expect(byId["fund-eth"]).toBe("completed");
  });

  it("payment-failed does not consume the action; retry completes it once", async () => {
    let snap: BurnerSimSnapshot | null = null;
    const sim = runSim("payment-failed", (s) => (snap = s));
    await waitFor(() => snap?.status === "failed");
    expect(snap!.steps.find((s) => s.id === "action")!.status).toBe("failed");
    expect(sim.actionConsumed).toBe(false);
    sim.retry();
    await waitFor(() => snap?.status === "done", 8000);
    sim.dispose();
    expect(snap!.steps.find((s) => s.id === "action")!.status).toBe("completed");
    expect(sim.actionConsumed).toBe(true);
  });

  it("cancel stops timers and marks unfinished steps cancelled", async () => {
    let snap: BurnerSimSnapshot | null = null;
    const sim = new BurnerSimulation({
      plan: makePlan(),
      scenario: "happy",
      pace: "brisk",
      durations: { create: 50, fund: 50, action: 50, retire: 50, sweep: 50 },
      onSnapshot: (s) => (snap = s),
    });
    sim.start();
    await waitFor(() => (snap?.steps ?? []).some((s) => s.status === "completed"));
    sim.cancel();
    expect(snap!.status).toBe("cancelled");
    const completed = snap!.steps.filter((s) => s.status === "completed").length;
    await new Promise((r) => setTimeout(r, 200));
    expect(snap!.steps.filter((s) => s.status === "completed")).toHaveLength(completed);
    sim.dispose();
  });
});
