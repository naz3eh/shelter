import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { IDBFactory } from "fake-indexeddb";
import { afterAll, describe, expect, it } from "vitest";
import { createAddressBook } from "../src/address-book.js";
import { isKeysError } from "../src/errors.js";
import { createIndexedDbStore } from "../src/idb.js";
import { createSqliteStore } from "../src/sqlite.js";
import { createMemoryStore, type KeyStore } from "../src/store.js";
import { createSeedVault } from "../src/vault.js";
import { FAST, HARDENED_VECTORS, PASS, TEST_MNEMONIC } from "./helpers.js";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "shelter-keys-"));
  dirs.push(d);
  return d;
};

interface Adapter {
  name: string;
  /** Returns a function that opens the same durable storage again (a "restart"). */
  fresh(): () => Promise<KeyStore>;
  /** Everything the adapter persisted, as text, to scan for secrets. */
  raw?(open: () => Promise<KeyStore>): Promise<string>;
}

const adapters: Adapter[] = [
  {
    name: "memory",
    fresh() {
      const s = createMemoryStore();
      return async () => s;
    },
  },
  {
    name: "indexeddb",
    fresh() {
      const factory = new IDBFactory();
      return () => createIndexedDbStore({ indexedDB: factory, name: "shelter-keys-test" });
    },
    async raw(open) {
      // Everything IndexedDB holds for this database, through a second connection.
      const s = await open();
      const text = JSON.stringify({ vault: await s.getVault(), book: await s.readBook() });
      s.close?.();
      return text;
    },
  },
  {
    name: "sqlite",
    fresh() {
      const path = join(tempDir(), "nested", "keys.db");
      const fn = async () => createSqliteStore(path);
      (fn as { path?: string }).path = path;
      return fn;
    },
    async raw(open) {
      const path = (open as { path?: string }).path!;
      const dir = join(path, "..");
      return readdirSync(dir).map((f) => readFileSync(join(dir, f)).toString("latin1")).join("\n");
    },
  },
];

const kind = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return isKeysError(e) ? e.kind : `non-keys error: ${String(e)}`;
  }
  return "no error";
};

for (const adapter of adapters) {
  describe(`${adapter.name} store`, () => {
    it("persists the vault and address book across a restart", async () => {
      const open = adapter.fresh();
      const s1 = await open();
      const v1 = createSeedVault({ ...FAST, store: s1 });
      await v1.importMnemonic(TEST_MNEMONIC, PASS);
      const b1 = createAddressBook(v1);
      await b1.allocate({ purpose: "burner", chain: "base" });
      await b1.allocate({ purpose: "destination", chain: "base", label: "fresh" });
      await b1.retire(v1.address(0));
      s1.close?.();

      const s2 = await open();
      const v2 = createSeedVault({ ...FAST, store: s2 });
      expect(await kind(v2.create(PASS))).toBe("vault_exists");
      await v2.unlock(PASS);
      const b2 = createAddressBook(v2);
      expect(await b2.nextIndex()).toBe(2);
      expect(await kind(b2.assertUsable(v2.address(0)))).toBe("retired");
      expect(await b2.get(v2.address(1))).toMatchObject({ index: 1, label: "fresh", status: "active" });
      expect((await b2.allocate({ purpose: "burner", chain: "base" })).index).toBe(2);
      s2.close?.();
    });

    it("allocates unique indexes under concurrent callers", async () => {
      const open = adapter.fresh();
      const store = await open();
      const vault = createSeedVault({ ...FAST, store });
      await vault.importMnemonic(TEST_MNEMONIC, PASS);
      const book = createAddressBook(vault);
      const recs = await Promise.all(Array.from({ length: 30 }, () => book.allocate({ purpose: "burner", chain: "base" })));
      expect(recs.map((r) => r.index).sort((a, b) => a - b)).toEqual(Array.from({ length: 30 }, (_, i) => i));
      store.close?.();
    });

    it("two connections (two tabs or processes) allocating at once never share an index", async () => {
      const open = adapter.fresh();
      const a = await open();
      await createSeedVault({ ...FAST, store: a }).importMnemonic(TEST_MNEMONIC, PASS);
      const b = await open();
      const va = createSeedVault({ ...FAST, store: a });
      const vb = createSeedVault({ ...FAST, store: b });
      await Promise.all([va.unlock(PASS), vb.unlock(PASS)]);
      const [ba, bb] = [createAddressBook(va), createAddressBook(vb)];
      const recs = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? ba : bb).allocate({ purpose: "burner", chain: "base" })));
      expect(recs.map((r) => r.index).sort((x, y) => x - y)).toEqual(Array.from({ length: 20 }, (_, i) => i));
      a.close?.();
      if (b !== a) b.close?.();
    });

    it("an update that throws leaves no partial write", async () => {
      const store = await adapter.fresh()();
      await expect(
        store.updateBook(() => {
          throw new Error("boom");
        }),
      ).rejects.toThrow();
      expect(await store.readBook()).toEqual({ nextIndex: 0, records: [] });
      await expect(store.updateVault(() => { throw new Error("boom"); })).rejects.toThrow();
      expect(await store.getVault()).toBeNull();
      store.close?.();
    });

    if (adapter.raw) {
      it("persists no plaintext secret", async () => {
        const open = adapter.fresh();
        const store = await open();
        const vault = createSeedVault({ ...FAST, store });
        await vault.importMnemonic(TEST_MNEMONIC, PASS);
        await createAddressBook(vault).allocate({ purpose: "burner", chain: "base" });
        store.close?.();
        const text = (await adapter.raw!(open)).toLowerCase();
        for (const s of ["abandon abandon", PASS, "5eb00bbddcf06908", HARDENED_VECTORS[0]!.slice(2, 18)]) expect(text).not.toContain(s.toLowerCase());
      });
    }
  });
}

describe("sqlite specifics", () => {
  it("creates the database owner-only and refuses a newer schema", async () => {
    const dir = tempDir();
    const path = join(dir, "keys.db");
    createSqliteStore(path).close?.();
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    const db = new DatabaseSync(path);
    db.exec("PRAGMA user_version = 99");
    db.close();
    expect(() => createSqliteStore(path)).toThrow(/schema version 99/);
  });

  it("rejects a duplicate address at the database level", async () => {
    const store = createSqliteStore(join(tempDir(), "k.db"));
    const rec = { index: 0, address: "0x0000000000000000000000000000000000000001" as const, chain: "base", purpose: "x", status: "active" as const, createdAt: "t" };
    await store.updateBook(() => ({ nextIndex: 1, writes: [rec], result: null }));
    expect(await kind(store.updateBook(() => ({ nextIndex: 2, writes: [{ ...rec, index: 1 }], result: null })))).toBe("storage");
    expect((await store.readBook()).nextIndex).toBe(1);
    store.close?.();
  });
});
