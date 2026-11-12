import { describe, expect, it } from "vitest";
import { BURNER_ASSETS } from "../src/assets.js";
import { isBurnerError } from "../src/errors.js";
import type { BurnerAction } from "../src/job.js";
import { Faults, OWNER, PAYEE, rig, runToEnd, type Rig } from "./harness.js";

const USDC_ID = BURNER_ASSETS.usdc.assetId;
const action = (amount = "250000", to = PAYEE): BurnerAction => ({ kind: "erc20_transfer", asset: "usdc", to, amount });

/** Invariants that must hold after any finished run, however often it crashed. */
async function assertSettledOnce(r: Rig, amount = 250_000n) {
  const w = r.world;
  expect(w.usdc.get(PAYEE) ?? 0n).toBe(amount); // paid exactly once
  const delivered = [...w.settlements.values()].filter((s) => s.delivered);
  expect(delivered).toHaveLength(2); // one gas leg, one asset leg, never twice
  expect(w.broadcasts).toBe(1); // the burner sent exactly one transaction
  for (const st of w.settlements.values()) expect(st.intents.size).toBeLessThanOrEqual(1); // never two different spends for one quote
  const paid = [...w.settlements.values()].filter((st) => st.intents.size).reduce((t, st) => t + BigInt(st.quote.amountIn), 0n);
  expect(w.spent.get(USDC_ID)).toBe(paid); // the balance paid each signed withdrawal once
  const book = await r.book.list();
  expect(book).toHaveLength(1); // no address leaked by a crash during allocation
  expect(book[0]!.status).toBe("retired");
}

describe("happy path", () => {
  it("funds gas (paid in USDC), funds the asset, pays, retires", async () => {
    const r = await rig();
    const e = r.engine();
    const job = await e.create(action());
    const done = await e.run(job.id);

    expect(done.status).toBe("done");
    expect(done.step).toBe("done");
    expect(done.lease).toBeUndefined();
    await assertSettledOnce(r);
    expect(r.world.submits).toBe(2);
    // Gas is paid from the USDC balance, delivered as native ETH.
    expect(done.gas[0]!.payWith).toBe("usdc");
    expect(done.gas[0]!.attempts[0]!.quote.request.originAssetId).toBe(USDC_ID);
    expect(done.gas[0]!.attempts[0]!.quote.request.destinationAssetId).toBe(BURNER_ASSETS.eth.assetId);
    // Gas first, so the asset never waits on an address without gas.
    const order = r.approvals.map((a) => (a.kind === "withdraw" ? a.leg : a.purpose));
    expect(order).toEqual(["gas", "asset", "action"]);
    expect(done.sweep?.decision).toBe("nothing_left");
    expect(done.act?.tx?.receipt?.status).toBe("success");
  });

  it("budgets gas from live fees with headroom, rounded up", async () => {
    const r = await rig();
    const e = r.engine();
    const job = await e.run((await e.create(action())).id);
    // (90k gas * 0.007 gwei + 0.0000000004 ETH L1) * 2 = 0.00000126 ETH -> rounded to 0.000002 ETH
    expect(job.gas[0]!.amount).toBe("2000000000000");
  });
});

describe("crash at every outside call", () => {
  it("never pays twice, never funds twice, never leaks an address", async () => {
    // Count the calls of a clean run first.
    const clean = await rig();
    const ce = clean.engine();
    await ce.run((await ce.create(action())).id);
    const total = clean.world.faults.calls;
    expect(total).toBeGreaterThan(30);

    const failures: string[] = [];
    for (const phase of ["before", "after"] as const) {
      for (let k = 1; k <= total; k++) {
        const r = await rig();
        r.world.faults = new Faults(k, phase);
        const job = await r.engine().create(action());
        try {
          const { job: done, crashes } = await runToEnd(r, job.id);
          expect(done.status).toBe("done");
          expect(crashes).toBeLessThanOrEqual(1);
          await assertSettledOnce(r);
        } catch (e) {
          failures.push(`${phase} call #${k} (${clean.world.faults.log[k - 1]}): ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    expect(failures).toEqual([]);
  }, 300_000);
});

describe("1Click outcomes", () => {
  it("requotes after a refund; the refund went back to the balance", async () => {
    const r = await rig({ refundQuotes: [1] }); // the first gas quote is refunded
    const e = r.engine();
    const done = await e.run((await e.create(action())).id);
    expect(done.status).toBe("done");
    expect(done.gas[0]!.attempts.map((a) => a.outcome)).toEqual(["refunded", "delivered"]);
    expect(r.world.refunded.get(USDC_ID)).toBeGreaterThan(0n);
    await assertSettledOnce(r);
  });

  it("stops for a person after 3 failed attempts, and keeps the job resumable", async () => {
    const r = await rig({ refundQuotes: [1, 2, 3] });
    const e = r.engine();
    const job = await e.create(action());
    const err = await e.run(job.id).catch((x) => x);
    expect(isBurnerError(err, "needs_attention")).toBe(true);
    const saved = (await e.get(job.id))!;
    expect(saved.status).toBe("needs_attention");
    expect(saved.attention).toMatch(/3 attempts/);
    expect(r.world.usdc.get(PAYEE) ?? 0n).toBe(0n);
  });

  it("abandons an attempt that never executes only after the quote deadline, then requotes", async () => {
    const r = await rig({ stallQuotes: [1] });
    const e = r.engine();
    const job = await e.create(action());
    const first = await e.run(job.id).catch((x) => x);
    expect(isBurnerError(first, "pending")).toBe(true);
    expect((await e.get(job.id))!.gas[0]!.attempts).toHaveLength(1);

    r.world.clock.advance(40 * 60_000); // past the 30-minute quote deadline plus grace
    const done = await e.run(job.id);
    expect(done.gas[0]!.attempts.map((a) => a.outcome)).toEqual(["expired", "delivered"]);
    await assertSettledOnce(r);
  });

  it("requotes when the quote expired before it was signed", async () => {
    const r = await rig();
    let first = true;
    const e = r.engine({
      approve: (a) => {
        if (a.kind === "withdraw" && first) {
          first = false;
          return false; // decline the first time
        }
        return true;
      },
    });
    const job = await e.create(action());
    expect(isBurnerError(await e.run(job.id).catch((x) => x), "rejected")).toBe(true);
    r.world.clock.advance(28 * 60_000); // the saved quote is now too close to its deadline
    const done = await e.run(job.id);
    expect(done.gas[0]!.attempts[0]!.outcome).toBe("expired");
    await assertSettledOnce(r);
  });
});

describe("approvals and cancellation", () => {
  it("a declined action leaves the job active; approving later finishes it", async () => {
    const r = await rig();
    let allow = false;
    const e = r.engine({ approve: (a) => a.kind !== "transaction" || allow });
    const job = await e.create(action());
    expect(isBurnerError(await e.run(job.id).catch((x) => x), "rejected")).toBe(true);
    const mid = (await e.get(job.id))!;
    expect(mid.status).toBe("active");
    expect(mid.step).toBe("act");
    expect(mid.lease).toBeUndefined();
    allow = true;
    await e.run(job.id);
    await assertSettledOnce(r);
  });

  it("cancel before anything is signed retires the burner; after signing it is refused", async () => {
    const r = await rig();
    const e = r.engine({ approve: () => false });
    const a = await e.create(action());
    await e.run(a.id).catch(() => undefined); // allocated, declined before signing
    const cancelled = await e.cancel(a.id);
    expect(cancelled.status).toBe("cancelled");
    expect((await r.book.list())[0]!.status).toBe("retired");

    const r2 = await rig();
    const e2 = r2.engine({ approve: (x) => x.kind === "withdraw" && x.leg === "gas" });
    const b = await e2.create(action());
    await e2.run(b.id).catch(() => undefined); // gas withdrawal signed
    await expect(e2.cancel(b.id)).rejects.toThrow(/already signed/);
  });
});

describe("guards", () => {
  it("refuses to pay one of the user's own Shelter addresses", async () => {
    const r = await rig();
    const own = await r.book.allocate({ purpose: "destination", chain: "base" });
    await expect(r.engine().create(action("1", own.address))).rejects.toThrow(/your own Shelter addresses/);
  });

  it("refuses bad actions", async () => {
    const e = (await rig()).engine();
    await expect(e.create(action("0"))).rejects.toThrow(/positive integer/);
    await expect(e.create(action("1", "0x0000000000000000000000000000000000000000"))).rejects.toThrow(/zero address/);
    await expect(e.create(action("1", BURNER_ASSETS.usdc.token!))).rejects.toThrow(/token contract/);
    await expect(e.create({ ...action(), asset: "eth" as never })).rejects.toThrow(/unsupported asset/);
  });

  it("a second runner backs off while the first holds the lease", async () => {
    const r = await rig({ stallQuotes: [1] });
    const a = r.engine();
    const job = await a.create(action());
    // Simulate a runner that is alive and holds the lease.
    const s = (await r.store.get(job.id))!;
    await r.store.update({ ...s.job, lease: { holder: "someone-else", until: new Date(r.world.clock.t + 60_000).toISOString() } }, s.rev);
    const err = await a.run(job.id).catch((x) => x);
    expect(isBurnerError(err, "busy")).toBe(true);
    expect(await r.book.list()).toHaveLength(0); // it did nothing
  });

  it("refuses a derived address that already has history, retires it, and uses a new one on retry", async () => {
    const r = await rig();
    const e = r.engine();
    const job = await e.create(action());
    r.world.nonces.set(r.vault.address(0), 3); // index 0 was used elsewhere
    const err = await e.run(job.id).catch((x) => x);
    expect(isBurnerError(err, "needs_attention")).toBe(true);
    expect((await r.book.get(r.vault.address(0)))!.status).toBe("retired");
    const done = await e.run(job.id);
    expect(done.burner!.index).toBe(1);
    expect(r.world.usdc.get(PAYEE)).toBe(250_000n);
  });

  it("runs a job only for its own owner", async () => {
    const r = await rig();
    const job = await r.engine().create(action());
    const s = (await r.store.get(job.id))!;
    await r.store.update({ ...s.job, owner: "other.near" }, s.rev);
    await expect(r.engine().run(job.id)).rejects.toThrow(new RegExp(`belongs to other.near, not ${OWNER}`));
  });
});

describe("gas top-up and sweep", () => {
  it("tops up gas when the real estimate exceeds the budget", async () => {
    const r = await rig({ gasUsed: 400_000n });
    const e = r.engine();
    const done = await e.run((await e.create(action())).id);
    expect(done.status).toBe("done");
    expect(done.gas).toHaveLength(2);
    expect(r.approvals.filter((a) => a.kind === "withdraw" && a.leg === "gas")).toHaveLength(2);
    expect(r.world.usdc.get(PAYEE)).toBe(250_000n);
  });

  it("sweeps back to the confidential balance when the action reverts", async () => {
    const r = await rig({ revertAction: true });
    const e = r.engine();
    const done = await e.run((await e.create(action())).id);
    expect(done.act?.outcome).toBe("reverted");
    expect(done.sweep?.decision).toBe("deposit");
    expect(done.sweep?.outcome).toBe("returned");
    expect(r.world.returned).toBe(250_000n);
    expect(r.world.usdc.get(PAYEE) ?? 0n).toBe(0n);
    expect(r.world.depositNotices).toHaveLength(1);
    expect((await r.book.list())[0]!.status).toBe("retired");
  });

  it("leaves a leftover below the deposit minimum as dust", async () => {
    const r = await rig({ extraUsdc: 1_000n });
    const e = r.engine();
    const done = await e.run((await e.create(action())).id);
    expect(done.sweep?.decision).toBe("dust");
    expect(done.sweep?.assetLeft).toBe("1000");
    expect(done.status).toBe("done");
  });
});
