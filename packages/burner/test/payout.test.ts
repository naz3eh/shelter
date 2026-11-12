import { describe, expect, it } from "vitest";
import { isBurnerError } from "../src/errors.js";
import type { BurnerAction } from "../src/job.js";
import { schedulePlan, type MoveStep } from "../src/plan.js";
import { Faults, PAYEE, rig, runToEnd, type Rig } from "./harness.js";

const hold = (amount = "500000"): BurnerAction => ({ kind: "hold", asset: "usdc", amount });

/** A finished payout: the address holds exactly the amount plus its gas, never sent anything, and stays usable. */
async function assertPayout(r: Rig, amount = 500_000n) {
  const w = r.world;
  const book = await r.book.list();
  expect(book).toHaveLength(1);
  const rec = book[0]!;
  expect(rec.purpose).toBe("destination");
  expect(rec.status).toBe("active"); // kept, not retired
  expect(w.usdc.get(rec.address)).toBe(amount);
  expect(w.eth.get(rec.address)).toBe(2_000_000_000_000n);
  expect(w.nonces.get(rec.address) ?? 0).toBe(0); // it never sent a transaction
  expect(w.broadcasts).toBe(0);
  expect([...w.settlements.values()].filter((s) => s.delivered)).toHaveLength(2);
  for (const s of w.settlements.values()) expect(s.intents.size).toBeLessThanOrEqual(1);
}

describe("private-move payout (hold)", () => {
  it("funds a fresh destination address with the amount plus gas for one later transfer, and keeps it", async () => {
    const r = await rig();
    const e = r.engine();
    const done = await e.run((await e.create(hold())).id);
    expect(done.status).toBe("done");
    expect(done.act).toBeUndefined();
    expect(done.sweep).toBeUndefined();
    expect(r.approvals.map((a) => (a.kind === "withdraw" ? a.leg : a.purpose))).toEqual(["gas", "asset"]);
    await assertPayout(r);
    // The kept address can still pass the book's check for a later action.
    await expect(r.book.assertUsable(done.burner!.address)).resolves.toBeTruthy();
  });

  it("survives a crash at every outside call", async () => {
    const clean = await rig();
    const ce = clean.engine();
    await ce.run((await ce.create(hold())).id);
    const total = clean.world.faults.calls;
    const failures: string[] = [];
    for (const phase of ["before", "after"] as const) {
      for (let k = 1; k <= total; k++) {
        const r = await rig();
        r.world.faults = new Faults(k, phase);
        const job = await r.engine().create(hold());
        try {
          const { job: done } = await runToEnd(r, job.id);
          expect(done.status).toBe("done");
          await assertPayout(r);
        } catch (x) {
          failures.push(`${phase} #${k} (${clean.world.faults.log[k - 1]}): ${x instanceof Error ? x.message : String(x)}`);
        }
      }
    }
    expect(failures).toEqual([]);
  }, 300_000);
});

describe("scheduled start (notBefore)", () => {
  it("does nothing before its time, then runs", async () => {
    const r = await rig();
    const e = r.engine();
    const job = await e.create(hold(), { notBefore: new Date(r.world.clock.t + 3 * 3_600_000).toISOString() });
    const early = await e.run(job.id).catch((x) => x);
    expect(isBurnerError(early, "pending")).toBe(true);
    expect(early.message).toMatch(/scheduled for/);
    expect(await r.book.list()).toHaveLength(0);
    expect(r.world.quotes).toBe(0);
    r.world.clock.advance(3 * 3_600_000);
    expect((await e.run(job.id)).status).toBe("done");
  });

  it("refuses a start time that is not a date", async () => {
    const e = (await rig()).engine();
    await expect(e.create(hold(), { notBefore: "soon" })).rejects.toThrow(/not a date/);
  });
});

describe("planner hand-off (schedulePlan)", () => {
  const plan: MoveStep[] = [
    { ref: "d1", action: "deposit", asset: "usdc", amount: "1000000" },
    { ref: "w1", action: "wait", durationMs: 2 * 3_600_000 },
    { ref: "p1", action: "withdraw", asset: "usdc", amount: "500000" },
    { ref: "w2", action: "wait", durationMs: 5 * 3_600_000 },
    { ref: "p2", action: "withdraw", asset: "usdc", amount: "400000" },
    { ref: "b1", action: "fund-burner", asset: "usdc", amount: "50000", to: PAYEE },
  ];

  it("turns deposits into user steps and the rest into jobs, each with its start time", async () => {
    const r = await rig();
    const start = r.world.clock.now();
    const s = await schedulePlan(r.engine(), plan, start);
    const h = (n: number) => new Date(start.getTime() + n * 3_600_000).toISOString();
    expect(s.deposits).toEqual([{ ref: "d1", asset: "usdc", amount: "1000000", notBefore: h(0) }]);
    expect(s.jobs.map((j) => [j.planRef, j.action.kind, j.notBefore])).toEqual([
      ["p1", "hold", h(2)],
      ["p2", "hold", h(7)],
      ["b1", "erc20_transfer", h(7)],
    ]);
    expect(r.world.quotes).toBe(0); // scheduling sends nothing
  });

  it("checks every step before creating any job", async () => {
    const r = await rig();
    const bad: MoveStep[] = [...plan, { ref: "x", action: "wait", durationMs: -1 }];
    await expect(schedulePlan(r.engine(), bad, r.world.clock.now())).rejects.toThrow(/wait must be/);
    await expect(schedulePlan(r.engine(), [plan[2]!, plan[2]!], r.world.clock.now())).rejects.toThrow(/duplicate/);
    await expect(schedulePlan(r.engine(), [{ ...plan[2]!, amount: "0" } as MoveStep], r.world.clock.now())).rejects.toThrow(/positive integer/);
    expect(await r.engine().list()).toHaveLength(0);
  });

  it("a scheduled payout and burner run end to end once their time comes", async () => {
    const r = await rig();
    const e = r.engine();
    const s = await schedulePlan(e, plan.slice(2), r.world.clock.now());
    r.world.clock.advance(8 * 3_600_000);
    for (const j of s.jobs) expect((await e.run(j.id)).status).toBe("done");
    expect(r.world.usdc.get(PAYEE)).toBe(50_000n);
    const book = await r.book.list();
    expect(book.map((b) => [b.purpose, b.status])).toEqual([
      ["destination", "active"],
      ["destination", "active"],
      ["burner", "retired"],
    ]);
  });
});
