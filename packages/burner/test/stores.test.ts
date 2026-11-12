/** One contract, three adapters: memory, SQLite (node:sqlite) and IndexedDB (fake-indexeddb). */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { isBurnerError } from "../src/errors.js";
import { createIndexedDbJobStore } from "../src/idb.js";
import { createMemoryJobStore, JOB_FORMAT_VERSION, type BurnerJob, type JobStore } from "../src/job.js";
import { createSqliteJobStore } from "../src/sqlite.js";

const job = (id: string, createdAt: string): BurnerJob => ({
  v: JOB_FORMAT_VERSION,
  id,
  createdAt,
  updatedAt: createdAt,
  status: "active",
  step: "allocate",
  owner: "owner.near",
  chain: "base",
  action: { kind: "hold", asset: "usdc", amount: "1" },
  gas: [],
  events: [],
});

const dir = mkdtempSync(join(tmpdir(), "shelter-burner-"));
const idb = new IDBFactory();

const adapters: [string, () => Promise<JobStore>, (() => Promise<JobStore>) | null][] = [
  ["memory", async () => createMemoryJobStore(), null],
  ["sqlite", async () => createSqliteJobStore(join(dir, "a.db")), async () => createSqliteJobStore(join(dir, "a.db"))],
  ["indexeddb", () => createIndexedDbJobStore({ indexedDB: idb, name: "t" }), () => createIndexedDbJobStore({ indexedDB: idb, name: "t" })],
];

for (const [name, make, reopen] of adapters) {
  describe(`${name} job store`, () => {
    it("creates, reads, lists in creation order, and refuses a duplicate id", async () => {
      const s = await make();
      await s.create(job("b", "2026-11-09T12:00:02.000Z"));
      await s.create(job("a", "2026-11-09T12:00:01.000Z"));
      expect((await s.get("a"))!.rev).toBe(1);
      expect((await s.list()).map((x) => x.job.id)).toEqual(["a", "b"]);
      const e = await s.create(job("a", "2026-11-09T12:00:03.000Z")).catch((x) => x);
      expect(isBurnerError(e, "busy")).toBe(true);
      expect(await s.get("missing")).toBeNull();
      s.close?.();
    });

    it("compare-and-swap: a stale writer gets busy and changes nothing", async () => {
      const s = await make();
      const a = await s.create(job("cas", "2026-11-09T12:00:00.000Z"));
      const stale = await s.get("cas");
      const next = await s.update({ ...a.job, step: "fund_gas" }, a.rev);
      expect(next.rev).toBe(2);
      const e = await s.update({ ...stale!.job, step: "act" }, stale!.rev).catch((x) => x);
      expect(isBurnerError(e, "busy")).toBe(true);
      expect((await s.get("cas"))!.job.step).toBe("fund_gas");
      const nf = await s.update(job("nope", "2026-11-09T12:00:00.000Z"), 1).catch((x) => x);
      expect(isBurnerError(nf, "not_found")).toBe(true);
      s.close?.();
    });

    if (reopen) {
      it("keeps jobs across a reopen", async () => {
        const s = await reopen();
        expect((await s.get("cas"))!.job.step).toBe("fund_gas");
        expect((await s.get("cas"))!.rev).toBe(2);
        s.close?.();
      });
    }
  });
}

it("refuses a stored job of an unknown format version", async () => {
  const s = createMemoryJobStore();
  await expect(s.create({ ...job("v9", "2026-11-09T12:00:00.000Z"), v: 9 as 1 }).then(() => s.get("v9"))).rejects.toThrow(/format version 9/);
});
