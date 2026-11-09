import { mnemonicToSeedSync } from "@scure/bip39";
import { describe, expect, it } from "vitest";
import { createAddressBook } from "../src/address-book.js";
import { sealBackup, utf8 } from "../src/envelope.js";
import { isKeysError } from "../src/errors.js";
import { createMemoryStore } from "../src/store.js";
import { createSeedVault } from "../src/vault.js";
import { FAST, importedVault, PASS, TEST_MNEMONIC } from "./helpers.js";

const kind = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return isKeysError(e) ? e.kind : `non-keys error: ${String(e)}`;
  }
  return "no error";
};

describe("address book", () => {
  it("allocates sequential hardened indexes with the derived addresses", async () => {
    const vault = await importedVault();
    const book = createAddressBook(vault);
    const a = await book.allocate({ purpose: "burner", chain: "base", label: "pay invoice" });
    const b = await book.allocate({ purpose: "destination", chain: "base" });
    expect([a.index, b.index]).toEqual([0, 1]);
    expect(a.address).toBe(vault.address(0));
    expect(b.address).toBe(vault.address(1));
    expect(a).toMatchObject({ status: "active", purpose: "burner", chain: "base", label: "pay invoice" });
    expect(b).not.toHaveProperty("label");
    expect(await book.nextIndex()).toBe(2);
  });

  it("never hands out the same index under concurrency", async () => {
    const book = createAddressBook(await importedVault());
    const recs = await Promise.all(Array.from({ length: 40 }, () => book.allocate({ purpose: "burner", chain: "base" })));
    expect(new Set(recs.map((r) => r.index)).size).toBe(40);
    expect(new Set(recs.map((r) => r.address)).size).toBe(40);
    expect(await book.nextIndex()).toBe(40);
  });

  it("retires permanently and rejects retired addresses", async () => {
    const book = createAddressBook(await importedVault());
    const a = await book.allocate({ purpose: "burner", chain: "base" });
    await expect(book.assertUsable(a.address.toLowerCase())).resolves.toMatchObject({ index: 0 });
    const r1 = await book.retire(a.address);
    const r2 = await book.retire(a.address);
    expect(r1.status).toBe("retired");
    expect(r2.retiredAt).toBe(r1.retiredAt);
    expect(await kind(book.assertUsable(a.address))).toBe("retired");
    const b = await book.allocate({ purpose: "burner", chain: "base" });
    expect(b.index).toBe(1);
    expect(await kind(book.assertUsable("0x0000000000000000000000000000000000000001"))).toBe("not_found");
    expect(await kind(book.retire("not an address"))).toBe("validation");
  });

  it("requires an unlocked vault to allocate", async () => {
    const vault = await importedVault();
    const book = createAddressBook(vault);
    vault.lock();
    expect(await kind(book.allocate({ purpose: "burner", chain: "base" }))).toBe("locked");
    expect(await book.nextIndex()).toBe(0);
  });

  it("a failed allocation writes nothing", async () => {
    const store = createMemoryStore();
    const vault = await importedVault({ store });
    await store.updateBook((s) => ({ nextIndex: s.nextIndex, writes: [{ index: 0, address: vault.address(0), chain: "base", purpose: "x", status: "active", createdAt: "t" }], result: null }));
    // nextIndex (0) now points at an existing record: allocation must refuse rather than reuse it.
    expect(await kind(createAddressBook(vault).allocate({ purpose: "burner", chain: "base" }))).toBe("conflict");
    expect((await store.readBook()).records).toHaveLength(1);
  });
});

describe("encrypted backup and restore", () => {
  it("round trips to a new device that imports the same mnemonic", async () => {
    const vault = await importedVault();
    const book = createAddressBook(vault);
    for (let i = 0; i < 3; i++) await book.allocate({ purpose: "burner", chain: "base" });
    await book.retire(vault.address(1));
    const backup = await book.exportBackup();
    expect(JSON.stringify(backup)).not.toContain(vault.address(0).slice(2, 12));
    expect(JSON.stringify(backup).toLowerCase()).not.toContain(vault.address(0).slice(2, 12).toLowerCase());

    const device2 = createSeedVault(FAST);
    await device2.importMnemonic(TEST_MNEMONIC, "other device passphrase");
    const book2 = createAddressBook(device2);
    expect(await book2.restoreBackup(JSON.parse(JSON.stringify(backup)))).toEqual({ added: 3, updated: 0, nextIndex: 3 });
    expect(await book2.list()).toEqual(await book.list());
    expect(await kind(book2.assertUsable(vault.address(1)))).toBe("retired");
    expect((await book2.allocate({ purpose: "burner", chain: "base" })).index).toBe(3);
  });

  it("merges: never lowers nextIndex, and a retirement on either side wins", async () => {
    const vault = await importedVault();
    const book = createAddressBook(vault);
    await book.allocate({ purpose: "burner", chain: "base" });
    await book.allocate({ purpose: "burner", chain: "base" });
    await book.retire(vault.address(0));
    const backup = await book.exportBackup(); // index 0 retired, nextIndex 2

    const other = await importedVault();
    const book2 = createAddressBook(other);
    for (let i = 0; i < 5; i++) await book2.allocate({ purpose: "burner", chain: "base" });
    await book2.retire(other.address(1));
    expect(await book2.restoreBackup(backup)).toEqual({ added: 0, updated: 1, nextIndex: 5 });
    const list = await book2.list();
    expect(list.filter((r) => r.status === "retired").map((r) => r.index)).toEqual([0, 1]);
  });

  it("rejects tampered backups, backups from another seed, and records that do not match the seed", async () => {
    const vault = await importedVault();
    const book = createAddressBook(vault);
    await book.allocate({ purpose: "burner", chain: "base" });
    const backup = await book.exportBackup();

    const ct = Buffer.from(backup.ct, "base64");
    ct[0]! ^= 1;
    expect(await kind(book.restoreBackup({ ...backup, ct: ct.toString("base64") }))).toBe("decrypt_failed");
    expect(await kind(book.restoreBackup({ ...backup, createdAt: "2000-01-01T00:00:00Z" }))).toBe("decrypt_failed");
    expect(await kind(book.restoreBackup({ ...backup, v: 9 }))).toBe("unsupported_format");

    const stranger = createSeedVault(FAST);
    await stranger.create(PASS);
    expect(await kind(createAddressBook(stranger).restoreBackup(backup))).toBe("decrypt_failed");

    // Correctly encrypted with this seed, but index 0 claims another index's address.
    const seed = mnemonicToSeedSync(TEST_MNEMONIC);
    const vaultId = (await vault.vaultId())!;
    const forged = await sealBackup(seed, utf8(JSON.stringify({ nextIndex: 1, records: [{ index: 0, address: vault.address(5), chain: "base", purpose: "burner", status: "active", createdAt: "t" }] })), { vaultId, createdAt: "t" });
    expect(await kind(createAddressBook(await importedVault()).restoreBackup(forged))).toBe("conflict");

    vault.lock();
    expect(await kind(book.exportBackup())).toBe("locked");
    expect(await kind(book.restoreBackup(backup))).toBe("locked");
  });
});

describe("bounded recovery", () => {
  it("finds used indexes up to the gap limit, marks them retired and skips the scanned window", async () => {
    const vault = await importedVault();
    const used = new Set([0, 3, 7].map((i) => vault.address(i)));
    const book = createAddressBook(vault);
    const asked: string[] = [];
    const res = await book.recover({ gapLimit: 5, isUsed: async (a) => (asked.push(a), used.has(a)) });
    expect(res.recovered.map((r) => r.index)).toEqual([0, 3, 7]);
    expect(res.recovered.every((r) => r.status === "retired" && r.purpose === "recovered")).toBe(true);
    expect(res.scannedThrough).toBe(12);
    expect(res.nextIndex).toBe(13);
    expect(asked).toHaveLength(13);
    expect(await kind(book.assertUsable(vault.address(3)))).toBe("retired");
    // The key is still recoverable for a sweep, but the address is never reissued.
    await expect(vault.account(3).signMessage({ message: "sweep" })).resolves.toMatch(/^0x/);
    expect((await book.allocate({ purpose: "burner", chain: "base" })).index).toBe(13);
  });

  it("skips indexes already in the book and respects maxScan and abort", async () => {
    const vault = await importedVault();
    const book = createAddressBook(vault);
    await book.allocate({ purpose: "burner", chain: "base" });
    const asked: string[] = [];
    const res = await book.recover({ gapLimit: 3, isUsed: async (a) => (asked.push(a), false) });
    expect(asked).not.toContain(vault.address(0));
    expect(res).toMatchObject({ recovered: [], scannedThrough: 3, nextIndex: 4 });
    const capped = await book.recover({ from: 10, gapLimit: 1000, maxScan: 4, isUsed: async () => false });
    expect(capped.scannedThrough).toBe(13);
    const ac = new AbortController();
    ac.abort();
    await expect(book.recover({ isUsed: async () => false, signal: ac.signal })).rejects.toThrow();
    expect(await kind(book.recover({ gapLimit: 0, isUsed: async () => false }))).toBe("validation");
  });
});
