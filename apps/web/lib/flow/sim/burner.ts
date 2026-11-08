/**
 * Deterministic, fully local simulation of a one-time burner action:
 *
 *   created -> funded (USDC + ETH gas via the private path)
 *   -> used (exactly one payment) -> retired
 *   -> optional housekeeping sweep of leftover dust
 *
 * The burner address is a fictional label — no key material exists, nothing
 * is derived, signed or broadcast. Timers are owned by the instance so
 * cancel()/dispose() stop all future steps.
 */

import { baseToDecimalString, ETH_DECIMALS } from "../money";
import type {
  BurnerPlan,
  BurnerScenario,
  BurnerSimSnapshot,
  DemoPace,
  SimEvent,
  SimStep,
  SimStepKind,
} from "../types";

export interface BurnerEngineOptions {
  plan: BurnerPlan;
  scenario: BurnerScenario;
  pace: DemoPace;
  onSnapshot: (snapshot: BurnerSimSnapshot) => void;
  durations?: Partial<Record<SimStepKind, number>>;
}

const PACE_MS: Record<DemoPace, Partial<Record<SimStepKind, number>>> = {
  relaxed: { create: 500, fund: 800, action: 900, retire: 600, sweep: 500 },
  brisk: { create: 30, fund: 40, action: 45, retire: 35, sweep: 30 },
};

/** Simulated gas the single payment needs, in ETH (18dp base units). */
export const REQUIRED_GAS_WEI = 210_000n * 1_000_000_000n; // 0.00021 ETH
/** Below this, sweeping dust costs more than it returns. */
export const SWEEP_MIN_WEI = 100_000_000_000_000n; // 0.0001 ETH

export class BurnerSimulation {
  private readonly opts: BurnerEngineOptions;
  private readonly durations: Partial<Record<SimStepKind, number>>;
  private steps: SimStep[] = [];
  private events: SimEvent[] = [];
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private cursor = 0;
  private status: BurnerSimSnapshot["status"] = "idle";
  private startedAt: string | null = null;
  private finishedAt: string | null = null;
  private message: string | null = null;
  private disposed = false;
  /** ETH actually delivered by the (simulated) gas funding leg. */
  private gasDeliveredWei: bigint;

  constructor(opts: BurnerEngineOptions) {
    this.opts = opts;
    this.durations = { ...PACE_MS[opts.pace], ...opts.durations };
    const { plan, scenario } = opts;
    // insufficient-gas delivers only part of the requested gas.
    this.gasDeliveredWei =
      scenario === "insufficient-gas"
        ? REQUIRED_GAS_WEI / 4n
        : BigInt(plan.fundingEthWei);
    this.steps = this.buildSteps();
  }

  private buildSteps(): SimStep[] {
    const { plan, scenario } = this.opts;
    const gasShort =
      scenario === "insufficient-gas"
        ? ` — only ${this.gasDeliveredWei.toString()} wei delivered, below the simulated ${REQUIRED_GAS_WEI.toString()} wei needed`
        : "";
    const fundingFails = scenario === "funding-failed";
    const paymentFails = scenario === "payment-failed";

    const steps: SimStep[] = [
      {
        id: "create",
        kind: "create",
        title: "Burner created",
        description: `Fictional one-time address ${plan.burnerAddress.slice(0, 10)}…. No key material exists — this is a label in the demo, not a derived account.`,
        status: "pending",
        counterparty: plan.burnerAddress,
      },
      {
        id: "fund-usdc",
        kind: "fund",
        title: `Fund ${plan.fundingUsdc} USDC`,
        description: `Private payout from the confidential balance to the burner — covers the payment plus a small buffer.`,
        status: "pending",
        asset: "USDC",
        amount: plan.fundingUsdc,
        amountBase: plan.fundingUsdcBase,
        counterparty: plan.burnerAddress,
      },
      {
        id: "fund-eth",
        kind: "fund",
        title: `Fund ${plan.fundingEth} ETH gas`,
        description: `Gas money through the private path${gasShort}.`,
        status: "pending",
        asset: "ETH",
        amount: plan.fundingEth,
        amountBase: plan.fundingEthWei,
        counterparty: plan.burnerAddress,
      },
      {
        id: "action",
        kind: "action",
        title: `One payment: ${plan.payment.amountUsdc} USDC → ${plan.payment.recipient.slice(0, 10)}…`,
        description:
          "The single business action this burner exists for. A second action from the same address is rejected by design.",
        status: "pending",
        asset: "USDC",
        amount: plan.payment.amountUsdc,
        amountBase: plan.payment.amountUsdcBase,
        counterparty: plan.payment.recipient,
      },
      {
        id: "retire",
        kind: "retire",
        title: "Retire burner",
        description:
          "Mark the address non-reusable. In a real build the child key stays recoverable from the seed but is never used again — here no key exists at all.",
        status: "pending",
        counterparty: plan.burnerAddress,
      },
      {
        id: "sweep",
        kind: "sweep",
        title: "Housekeeping: dust sweep (optional)",
        description:
          "Separate from the business action: return leftover funds to the confidential balance. Uneconomical dust is left in place and stays visible.",
        status: "pending",
        counterparty: plan.burnerAddress,
      },
    ];
    for (const s of steps) {
      const meta = s as SimStep & { _fail?: "funding" | "payment" | "gas" };
      if (s.id === "fund-usdc" && fundingFails) meta._fail = "funding";
      if (s.id === "fund-eth" && fundingFails) meta._fail = "funding";
      if (s.id === "action" && paymentFails) meta._fail = "payment";
      if (s.id === "action" && scenario === "insufficient-gas") meta._fail = "gas";
    }
    return steps;
  }

  private snapshot(): BurnerSimSnapshot {
    const used = this.find("action").status === "completed";
    const usedGas = used ? REQUIRED_GAS_WEI : 0n;
    const remaining = this.gasDeliveredWei - usedGas;
    const terminal =
      this.status === "done" ||
      this.status === "failed" ||
      this.status === "cancelled";
    return {
      status: this.status,
      planHash: this.opts.plan.hash,
      scenario: this.opts.scenario,
      pace: this.opts.pace,
      burnerAddress: this.opts.plan.burnerAddress,
      fundingUsdc: this.opts.plan.fundingUsdc,
      fundingEth: this.opts.plan.fundingEth,
      requiredGasEth: this.decimal(REQUIRED_GAS_WEI),
      paymentRecipient: this.opts.plan.payment.recipient,
      paymentAmountUsdc: this.opts.plan.payment.amountUsdc,
      steps: this.steps.map((s) => ({ ...s })),
      // ETH left on the burner once the run ends. After retirement this is
      // uneconomical dust; before that it is simply unspent funding.
      dustEth: terminal
        ? this.decimal(remaining > 0n ? remaining : 0n)
        : null,
      events: [...this.events],
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      message: this.message,
    };
  }

  private decimal(wei: bigint): string {
    return baseToDecimalString(wei.toString(), ETH_DECIMALS);
  }

  private emit() {
    if (!this.disposed) this.opts.onSnapshot(this.snapshot());
  }

  private log(text: string) {
    this.events.push({ at: new Date().toISOString(), text });
    if (this.events.length > 60) this.events.shift();
  }

  private schedule(ms: number, fn: () => void) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }

  private find(id: string) {
    return this.steps.find((s) => s.id === id)!;
  }

  private runStep() {
    if (this.disposed || this.status !== "running") return;
    const step = this.steps[this.cursor];
    if (!step) {
      this.finish();
      return;
    }
    step.status = "active";
    this.emit();

    const failMode = (step as SimStep & { _fail?: string })._fail;
    const duration = this.durations[step.kind] ?? 500;

    this.schedule(duration, () => {
      if (this.disposed || this.status !== "running") return;
      const meta = step as SimStep & { _fail?: string; _failedOnce?: boolean };
      const failMode = meta._fail;
      // Funding/payment failures are transient: they fail once, then a retry
      // succeeds. The gas failure is deterministic — delivered gas stays
      // short, so every attempt fails until the run is cancelled.
      const shouldFail =
        failMode === "gas"
          ? this.gasDeliveredWei < REQUIRED_GAS_WEI
          : failMode !== undefined && !meta._failedOnce;
      if (shouldFail) {
        meta._failedOnce = true;
        step.status = "failed";
        if (failMode === "funding") {
          this.log(
            `${step.title}: simulated funding failed — nothing reached the burner; retry re-attempts the private payout.`,
          );
          this.message =
            "Simulated funding failed. Retry resumes — the burner was never funded and no business action ran.";
        } else if (failMode === "gas") {
          this.log(
            `${step.title}: insufficient gas — the payment cannot be broadcast. The burner holds funds but stays unused.`,
          );
          this.message =
            "Insufficient gas for the simulated payment. Retrying will fail again while gas stays short — cancel to stop, or restart with another scenario.";
        } else {
          this.log(
            `${step.title}: simulated payment failed — the burner is not marked used; retry re-attempts the single action.`,
          );
          this.message =
            "The simulated payment failed. Retry re-attempts the one business action — it has not been used yet.";
        }
        this.status = "failed";
        this.emit();
        return;
      }

      // Success path per step kind.
      if (step.id === "sweep") {
        const usedGas =
          this.find("action").status === "completed" ? REQUIRED_GAS_WEI : 0n;
        const leftover = this.gasDeliveredWei - usedGas;
        if (leftover < SWEEP_MIN_WEI) {
          step.status = "skipped";
          step.description = `${step.description} Skipped — leftover dust (${this.decimal(leftover > 0n ? leftover : 0n)} ETH) is below the sweep cost, so it stays on the retired address and remains visible.`;
          this.log(
            `Dust sweep skipped: ${this.decimal(leftover > 0n ? leftover : 0n)} ETH is uneconomical to sweep.`,
          );
        } else {
          step.status = "completed";
          this.log("Dust sweep completed (housekeeping, separate from the business action).");
        }
      } else {
        step.status = "completed";
        if (step.kind === "action") {
          this.log(
            `Payment completed: ${this.opts.plan.payment.amountUsdc} USDC to fictional recipient ${this.opts.plan.payment.recipient.slice(0, 10)}…. The burner is now used — a second action is rejected.`,
          );
        } else if (step.kind === "retire") {
          this.log("Burner retired — marked non-reusable.");
        } else if (step.id === "fund-eth" && this.gasDeliveredWei < BigInt(this.opts.plan.fundingEthWei)) {
          this.log(
            `Gas funding delivered short: ${this.decimal(this.gasDeliveredWei)} of ${this.opts.plan.fundingEth} ETH.`,
          );
        }
      }
      this.cursor += 1;
      this.emit();
      this.schedule(30, () => this.runStep());
    });
  }

  private finish() {
    this.status = "done";
    this.finishedAt = new Date().toISOString();
    const used = this.find("action").status === "completed";
    const leftover = this.gasDeliveredWei - (used ? REQUIRED_GAS_WEI : 0n);
    this.message = used
      ? `Lifecycle complete: created → funded → used → retired. ${this.decimal(leftover > 0n ? leftover : 0n)} ETH dust remains visible; the optional sweep was evaluated separately. No real funds moved.`
      : "Lifecycle finished without a completed payment — review the step states above.";
    this.log(this.message);
    this.emit();
  }

  start() {
    if (this.disposed || this.status === "running" || this.status === "done")
      return;
    this.status = "running";
    this.message = null;
    if (!this.startedAt) this.startedAt = new Date().toISOString();
    this.cursor = this.steps.findIndex(
      (s) =>
        s.status === "pending" ||
        s.status === "failed" ||
        s.status === "cancelled",
    );
    if (this.cursor === -1) {
      this.finish();
      return;
    }
    this.emit();
    this.schedule(40, () => this.runStep());
  }

  cancel() {
    if (this.disposed) return;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    for (const s of this.steps) {
      if (s.status === "pending" || s.status === "active") s.status = "cancelled";
    }
    if (this.status === "running" || this.status === "failed") {
      this.status = "cancelled";
      this.message =
        "Simulation cancelled. Completed steps stay completed; the burner was never a real account.";
      this.log(this.message);
    }
    this.emit();
  }

  retry() {
    if (this.disposed) return;
    if (this.status !== "failed" && this.status !== "cancelled") return;
    for (const s of this.steps) {
      if (s.status === "failed" || s.status === "cancelled") s.status = "pending";
    }
    this.start();
  }

  /** True once the single business action has completed — burner is spent. */
  get actionConsumed(): boolean {
    return this.find("action").status === "completed";
  }

  dispose() {
    this.disposed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }
}
