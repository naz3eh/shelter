import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { createAddressBook } from "../src/address-book.js";
import { createSqliteStore } from "../src/sqlite.js";
import { createSeedVault } from "../src/vault.js";
import { FAST, PASS, TEST_MNEMONIC } from "./helpers.js";

const run = promisify(execFile);
const tsx = createRequire(import.meta.url).resolve("tsx");
const worker = new URL("./fixtures/allocate-worker.ts", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "shelter-keys-mp-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const spawnWorker = async (path: string, count: number, crashAfter?: number) => {
  const args = ["--import", tsx, worker, path, String(count), ...(crashAfter === undefined ? [] : [String(crashAfter)])];
  const { stdout } = await run(process.execPath, args, { timeout: 60_000 });
  return stdout ? (JSON.parse(stdout) as number[]) : [];
};

describe("sqlite across processes", () => {
  it("separate processes allocating at once never share an index, and a crash never frees one", async () => {
    const path = join(dir, "keys.db");
    const setup = createSqliteStore(path);
    await createSeedVault({ ...FAST, store: setup }).importMnemonic(TEST_MNEMONIC, PASS);
    setup.close?.();

    const results = await Promise.all([spawnWorker(path, 15), spawnWorker(path, 15), spawnWorker(path, 15), spawnWorker(path, 15)]);
    const all = results.flat().sort((a, b) => a - b);
    expect(all).toEqual(Array.from({ length: 60 }, (_, i) => i));

    // A process that dies right after committing an allocation.
    await spawnWorker(path, 5, 3);

    const store = createSqliteStore(path);
    const vault = createSeedVault({ ...FAST, store });
    await vault.unlock(PASS);
    const book = createAddressBook(vault);
    expect(await book.nextIndex()).toBe(63);
    expect((await book.list()).map((r) => r.index)).toEqual(Array.from({ length: 63 }, (_, i) => i));
    expect((await book.allocate({ purpose: "burner", chain: "base" })).index).toBe(63);
    store.close?.();
  }, 120_000);
});
