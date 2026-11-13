import { describe, expect, it } from "vitest";
import { isBurnerError } from "../src/errors.js";
import type { FundAction } from "../src/job.js";
import { Faults, rig, runToEnd, type Rig } from "./harness.js";

/** A held address, as Connect allocates one. */
async function held(r: Rig) {
  const rec = await r.book.allocate({ purpose: "connect", chain: "base", label: "connect:test" });
  return { index: rec.index, address: rec.address };
}

const fund = (target: FundAction["target"], over: Partial<FundAction> = {}): FundAction => ({
  kind: "fund",
  target,
  asset: "usdc",
  amount: "2000000",
  gasWei: "3000000000000",
  payWith: "usdc",
  ...over,
});

describe("fund: top up a held address", () => {
  it("delivers gas then the asset, keeps the address, and signs nothing on chain", async () => {
    const r = await rig();
    const t = await held(r);
    const e = r.engine();
    const job = await e.run((await e.create(fund(t))).id);
    expect(job.status).toBe("done");
    expect(r.approvals.map((a) => (a.kind === "withdraw" ? `${a.leg}:${a.asset.symbol}<-${a.payAsset.symbol}` : a.kind))).toEqual([
      "gas:ETH<-USDC",
      "asset:USDC<-USDC",
    ]);
    expect(r.world.usdc.get(t.address)).toBe(2_000_000n);
    expect(r.world.eth.get(t.address)).toBe(3_000_000_000_000n);
    expect(r.world.broadcasts).toBe(0);
    expect((await r.book.get(t.address))!.status).toBe("active");
  });

  it("does a gas-only top-up in one withdrawal", async () => {
    const r = await rig();
    const t = await held(r);
    const e = r.engine();
    const job = await e.run((await e.create(fund(t, { amount: "0" }))).id);
    expect(job.status).toBe("done");
    expect(job.asset).toBeUndefined();
    expect(r.approvals).toHaveLength(1);
    expect(r.world.eth.get(t.address)).toBe(3_000_000_000_000n);
  });

  it("merges gas into one ETH withdrawal when the asset is ETH", async () => {
    const r = await rig();
    const t = await held(r);
    const e = r.engine();
    const job = await e.run((await e.create(fund(t, { asset: "eth", amount: "1000000000000000", payWith: "eth" }))).id);
    expect(job.gas).toEqual([]);
    expect(job.asset!.amount).toBe("1003000000000000");
    expect(r.approvals).toHaveLength(1);
    expect(r.world.eth.get(t.address)).toBe(1_003_000_000_000_000n);
  });

  it("tops up an address that already has history and balances", async () => {
    const r = await rig();
    const t = await held(r);
    r.world.usdc.set(t.address, 7n);
    r.world.eth.set(t.address, 11n);
    r.world.nonces.set(t.address, 4);
    const e = r.engine();
    await e.run((await e.create(fund(t))).id);
    expect(r.world.usdc.get(t.address)).toBe(2_000_007n);
    expect(r.world.eth.get(t.address)).toBe(3_000_000_000_011n);
  });

  it("refuses targets that are unknown, mismatched or retired, and empty top-ups", async () => {
    const r = await rig();
    const t = await held(r);
    const e = r.engine();
    const bad: FundAction[] = [
      fund({ index: 0, address: "0x1111111111111111111111111111111111111111" }),
      fund({ index: t.index + 1, address: t.address }),
      fund(t, { amount: "0", gasWei: "0" }),
      fund(t, { amount: "-1" }),
      fund(t, { asset: "dai" as never }),
    ];
    for (const a of bad) await expect(e.create(a)).rejects.toSatisfy((x) => isBurnerError(x, "validation"));
    await r.book.retire(t.address);
    await expect(e.create(fund(t))).rejects.toSatisfy((x) => isBurnerError(x, "validation"));
  });

  it("stops for attention when the target is retired after the job was created", async () => {
    const r = await rig();
    const t = await held(r);
    const e = r.engine();
    const job = await e.create(fund(t));
    await r.book.retire(t.address);
    await expect(e.run(job.id)).rejects.toSatisfy((x) => isBurnerError(x, "needs_attention"));
    expect(r.approvals).toEqual([]);
  });

  it("cancelling a fund job leaves the held address active", async () => {
    const r = await rig();
    const t = await held(r);
    const e = r.engine();
    const job = await e.create(fund(t));
    expect((await e.cancel(job.id)).status).toBe("cancelled");
    expect((await r.book.get(t.address))!.status).toBe("active");
  });

  it("survives a crash at every outside call without paying twice", async () => {
    const clean = await rig();
    const ce = clean.engine();
    await ce.run((await ce.create(fund(await held(clean)))).id);
    const total = clean.world.faults.calls;
    const failures: string[] = [];
    for (const phase of ["before", "after"] as const) {
      for (let k = 1; k <= total; k++) {
        const r = await rig();
        const t = await held(r);
        r.world.faults = new Faults(k, phase);
        const job = await r.engine().create(fund(t));
        try {
          const { job: done } = await runToEnd(r, job.id);
          expect(done.status).toBe("done");
          expect(r.world.usdc.get(t.address)).toBe(2_000_000n);
          expect(r.world.eth.get(t.address)).toBe(3_000_000_000_000n);
          for (const s of r.world.settlements.values()) expect(s.intents.size).toBeLessThanOrEqual(1);
        } catch (x) {
          failures.push(`${phase} #${k} (${clean.world.faults.log[k - 1]}): ${x instanceof Error ? x.message : String(x)}`);
        }
      }
    }
    expect(failures).toEqual([]);
  }, 300_000);
});
