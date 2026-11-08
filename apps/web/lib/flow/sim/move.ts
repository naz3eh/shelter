/**
 * Deterministic, fully local simulation of the private move:
 *
 *   old wallet -> simulated 1Click deposit address -> confidential balance
 *   -> private delay -> fresh destinations (USDC leg + ETH gas leg)
 *
 * No network, no signing, no real funds. Timers are plain setTimeout handles
 * owned by the instance so cancel()/dispose() stop all future steps. Pace is
 * deliberately short for the demo and labelled as such in the UI.
 */

import { baseToDecimalString, ETH_DECIMALS, USDC_DECIMALS } from "../money";
import type {
  ApprovedPlan,
  DemoPace,
  MoveChunkResult,
  MoveScenario,
  MoveSimSnapshot,
  SimEvent,
  SimStep,
  SimStepKind,
} from "../types";

export interface MoveEngineOptions {
  plan: ApprovedPlan;
  scenario: MoveScenario;
  pace: DemoPace;
  onSnapshot: (snapshot: MoveSimSnapshot) => void;
  /** Test hook: override per-kind durations (ms). */
  durations?: Partial<Record<SimStepKind, number>>;
}

const PACE_MS: Record<DemoPace, Partial<Record<SimStepKind, number>>> = {
  relaxed: { deposit: 900, settle: 800, wait: 1100, withdraw: 800 },
  brisk: { deposit: 45, settle: 40, wait: 60, withdraw: 45 },
};

export class MoveSimulation {
  private readonly opts: MoveEngineOptions;
  private readonly durations: Partial<Record<SimStepKind, number>>;
  private steps: SimStep[] = [];
  private chunks: MoveChunkResult[] = [];
  private events: SimEvent[] = [];
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private cursor = 0;
  private status: MoveSimSnapshot["status"] = "idle";
  private startedAt: string | null = null;
  private finishedAt: string | null = null;
  private message: string | null = null;
  private disposed = false;

  constructor(opts: MoveEngineOptions) {
    this.opts = opts;
    this.durations = { ...PACE_MS[opts.pace], ...opts.durations };
    this.steps = this.buildSteps();
    this.chunks = opts.plan.chunks.map((c) => ({
      index: c.index,
      destination: c.destination,
      usdc: c.usdc,
      usdcBase: c.usdcBase,
      eth: c.eth,
      ethWei: c.ethWei,
      depositAddress: c.depositAddress,
      usdcWithdrawn: false,
      ethWithdrawn: false,
    }));
  }

  private buildSteps(): SimStep[] {
    const { plan, scenario } = this.opts;
    const steps: SimStep[] = [];
    const failingDeposit =
      scenario === "deposit-refund"
        ? Math.min(1, plan.chunks.length - 1)
        : -1;
    const failingEthChunk =
      scenario === "partial-funding" ? plan.chunks.length - 1 : -1;

    plan.chunks.forEach((c) => {
      steps.push({
        id: `deposit-${c.index}`,
        kind: "deposit",
        title: `Deposit chunk ${c.index + 1}`,
        description: `${c.usdc} USDC + ${c.eth} ETH from the old wallet to simulated deposit address ${c.depositAddress.slice(0, 10)}… — the only public leg.`,
        status: "pending",
        chunkIndex: c.index,
        counterparty: c.depositAddress,
      });
    });
    steps.push({
      id: "settle",
      kind: "settle",
      title: "Confidential balance settlement",
      description:
        "Deposits land in the confidential balance. Observers see unrelated Intents payouts, not a link to the old wallet.",
      status: "pending",
    });
    steps.push({
      id: "wait",
      kind: "wait",
      title: "Private delay window",
      description: `Withdrawals are spaced from deposits (first after ~${plan.timing.firstWithdrawalDelayMin} demo-minutes, then every ~${plan.timing.spacingMin}). Short demo delays would be linkable in real use.`,
      status: "pending",
    });
    plan.chunks.forEach((c) => {
      steps.push({
        id: `withdraw-usdc-${c.index}`,
        kind: "withdraw",
        title: `Withdraw ${c.usdc} USDC → destination ${c.index + 1}`,
        description: `Private payout to fresh fictional address ${c.destination.slice(0, 10)}….`,
        status: "pending",
        asset: "USDC",
        amount: c.usdc,
        amountBase: c.usdcBase,
        chunkIndex: c.index,
        counterparty: c.destination,
      });
      steps.push({
        id: `withdraw-eth-${c.index}`,
        kind: "withdraw",
        title: `Withdraw ${c.eth} ETH gas → destination ${c.index + 1}`,
        description: `Gas money arrives through the same private path — never a public top-up from the old wallet.`,
        status: "pending",
        asset: "ETH",
        amount: c.eth,
        amountBase: c.ethWei,
        chunkIndex: c.index,
        counterparty: c.destination,
      });
    });
    // Attach scenario bookkeeping without exposing it in the step shape.
    for (const s of steps) {
      const meta = s as SimStep & { _fail?: "refund" | "fail-once" };
      if (s.id === `deposit-${failingDeposit}`) meta._fail = "refund";
      if (s.id === `withdraw-eth-${failingEthChunk}`) meta._fail = "fail-once";
    }
    return steps;
  }

  private snapshot(): MoveSimSnapshot {
    const outcome: MoveSimSnapshot["outcome"] =
      this.status === "running"
        ? "running"
        : this.status === "cancelled"
          ? "cancelled"
          : this.steps.every((s) => s.status === "completed" || s.status === "skipped")
            ? this.steps.some((s) => s.status === "skipped")
              ? "partial"
              : "completed"
            : "partial";
    return {
      status: this.status,
      outcome,
      planHash: this.opts.plan.hash,
      scenario: this.opts.scenario,
      pace: this.opts.pace,
      steps: this.steps.map((s) => ({ ...s })),
      chunks: this.chunks.map((c) => ({ ...c })),
      events: [...this.events],
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      message: this.message,
    };
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

  private stepDuration(step: SimStep): number {
    if (step.kind === "wait") {
      // The private delay is one visible step; keep it short but non-zero.
      return Math.max(this.durations.wait ?? 1100, 30);
    }
    return this.durations[step.kind] ?? 500;
  }

  private findStep(id: string) {
    return this.steps.find((s) => s.id === id)!;
  }

  private markChunkWithdrawn(step: SimStep) {
    const c = this.chunks[step.chunkIndex ?? -1];
    if (!c) return;
    if (step.asset === "USDC") c.usdcWithdrawn = true;
    if (step.asset === "ETH") c.ethWithdrawn = true;
  }

  /** Run the step at `cursor`, then advance. */
  private runStep() {
    if (this.disposed || this.status !== "running") return;
    const step = this.steps[this.cursor];
    if (!step) {
      this.finish();
      return;
    }

    // Skip withdrawals for a chunk whose deposit was refunded.
    const depositId = `deposit-${step.chunkIndex ?? -1}`;
    if (
      step.kind === "withdraw" &&
      step.chunkIndex !== undefined &&
      this.findStep(depositId).status === "refunded"
    ) {
      step.status = "skipped";
      step.description = `${step.description} Skipped — the chunk's deposit was refunded, so there is nothing to withdraw.`;
      this.cursor += 1;
      this.emit();
      this.schedule(this.durations.deposit ?? 500, () => this.runStep());
      return;
    }

    step.status = "active";
    this.emit();

    const failMode = (step as SimStep & { _fail?: string })._fail;
    const duration = this.stepDuration(step);

    this.schedule(duration, () => {
      if (this.disposed || this.status !== "running") return;
      const meta = step as SimStep & { _fail?: string; _failedOnce?: boolean };
      if (failMode === "refund" && !meta._failedOnce) {
        meta._failedOnce = true;
        step.status = "refunded";
        this.log(
          `${step.title}: simulated deposit failed — funds returned to the sender (refund).`,
        );
        this.cursor += 1;
        this.emit();
        this.schedule(this.durations.deposit ?? 500, () => this.runStep());
        return;
      }
      if (failMode === "fail-once" && !meta._failedOnce) {
        meta._failedOnce = true;
        step.status = "failed";
        this.chunks[step.chunkIndex ?? -1]!.ethWithdrawn = false;
        this.log(
          `${step.title}: simulated failure — leg refunded to the confidential balance. Retry resumes here.`,
        );
        this.status = "failed";
        this.message =
          "A simulated withdrawal leg failed and was refunded. Retry resumes the simulation — completed steps are not repeated.";
        this.emit();
        return;
      }
      step.status = "completed";
      if (step.kind === "withdraw") this.markChunkWithdrawn(step);
      if (step.kind === "deposit") {
        this.log(`${step.title}: simulated deposit confirmed (fictional).`);
      }
      this.cursor += 1;
      this.emit();
      this.schedule(30, () => this.runStep());
    });
  }

  private finish() {
    this.status = "done";
    this.finishedAt = new Date().toISOString();
    const unresolved = this.steps.filter(
      (s) => s.status === "skipped" || s.status === "refunded",
    ).length;
    this.message =
      unresolved > 0
        ? `Simulation finished with ${unresolved} skipped/refunded step(s) — the move is partial.`
        : "Simulation finished. No real funds moved.";
    this.log(this.message);
    this.emit();
  }

  start() {
    if (this.disposed || this.status === "running" || this.status === "done")
      return;
    // Resume semantics: completed/refunded/skipped steps are kept; failed,
    // cancelled and pending steps run again from the cursor.
    this.status = "running";
    this.message = null;
    if (!this.startedAt) this.startedAt = new Date().toISOString();
    this.cursor = this.steps.findIndex(
      (s) => s.status === "pending" || s.status === "failed" || s.status === "cancelled",
    );
    if (this.cursor === -1) {
      this.finish();
      return;
    }
    this.emit();
    this.schedule(40, () => this.runStep());
  }

  /** Pause-free cancel: clears every pending timer, keeps finished steps. */
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
        "Simulation cancelled. Completed steps stay completed; nothing real was ever in flight.";
      this.log(this.message);
    }
    this.emit();
  }

  /** Retry/resume: failed or cancelled steps re-run; completed stay done. */
  retry() {
    if (this.disposed) return;
    if (this.status !== "failed" && this.status !== "cancelled") return;
    for (const s of this.steps) {
      if (s.status === "failed" || s.status === "cancelled") s.status = "pending";
    }
    this.start();
  }

  dispose() {
    this.disposed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }
}
