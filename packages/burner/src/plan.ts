/**
 * Planner hand-off (decision 4): the executable form of a private move, and
 * how it becomes engine jobs.
 *
 * `@shelter/core`'s `PlanStep` ({ action, description }) names the actions
 * but carries no amounts or times. The planner emits `MoveStep`s; the
 * actions keep core's names:
 *
 *   deposit      old address -> confidential balance. The user sends it from
 *                that wallet (`near deposit`); nothing for the engine to run.
 *   wait         delay before the next step, so amounts and times decorrelate.
 *   withdraw     confidential balance -> a fresh payout address, with gas
 *                (engine job, action `hold`).
 *   fund-burner  one public action from a one-time burner
 *                (engine job, action `erc20_transfer`).
 *
 * Times are absolute: each job gets `notBefore` = start + the sum of the
 * waits before it, and the engine refuses to start it earlier.
 */

import { BurnerError } from "./errors.js";
import type { BurnerEngine } from "./engine.js";
import type { BurnerJob } from "./job.js";

export type MoveStep =
  | { ref: string; action: "deposit"; asset: "usdc"; amount: string }
  | { ref: string; action: "wait"; durationMs: number }
  | { ref: string; action: "withdraw"; asset: "usdc"; amount: string }
  | { ref: string; action: "fund-burner"; asset: "usdc"; amount: string; to: `0x${string}` };

export interface ScheduledPlan {
  /** Deposits the user makes from the old wallet, in order, with the earliest time for each. */
  deposits: { ref: string; asset: "usdc"; amount: string; notBefore: string }[];
  /** Engine jobs created, in plan order. */
  jobs: BurnerJob[];
}

const MAX_WAIT_MS = 30 * 24 * 60 * 60_000;

/**
 * Checks every step's shape before creating any job. The engine then checks
 * each action as it creates the job (for example a payee that is one of the
 * user's own addresses); if it refuses one, the jobs already created stay,
 * unstarted, and can be cancelled.
 */
export async function schedulePlan(engine: BurnerEngine, steps: MoveStep[], start: Date): Promise<ScheduledPlan> {
  const refs = new Set<string>();
  for (const s of steps) {
    if (!s || typeof s.ref !== "string" || !s.ref) throw new BurnerError("validation", "every plan step needs a ref");
    if (refs.has(s.ref)) throw new BurnerError("validation", `duplicate plan step ref ${s.ref}`);
    refs.add(s.ref);
    if (s.action === "wait") {
      if (!Number.isSafeInteger(s.durationMs) || s.durationMs < 0 || s.durationMs > MAX_WAIT_MS) {
        throw new BurnerError("validation", `step ${s.ref}: wait must be 0 to 30 days`);
      }
    } else if (!["deposit", "withdraw", "fund-burner"].includes((s as { action: string }).action)) {
      throw new BurnerError("validation", `step ${s.ref}: unknown action ${(s as { action: string }).action}`);
    } else if (!/^[1-9][0-9]*$/.test(s.amount)) {
      throw new BurnerError("validation", `step ${s.ref}: amount must be a positive integer in base units`);
    }
  }

  const out: ScheduledPlan = { deposits: [], jobs: [] };
  let t = start.getTime();
  for (const s of steps) {
    const notBefore = new Date(t).toISOString();
    if (s.action === "wait") t += s.durationMs;
    else if (s.action === "deposit") out.deposits.push({ ref: s.ref, asset: s.asset, amount: s.amount, notBefore });
    else if (s.action === "withdraw") out.jobs.push(await engine.create({ kind: "hold", asset: s.asset, amount: s.amount }, { notBefore, planRef: s.ref }));
    else out.jobs.push(await engine.create({ kind: "erc20_transfer", asset: s.asset, to: s.to, amount: s.amount }, { notBefore, planRef: s.ref }));
  }
  return out;
}
