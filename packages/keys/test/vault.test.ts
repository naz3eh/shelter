import { validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { parseTransaction, recoverMessageAddress, recoverTypedDataAddress, verifyTypedData, type TypedDataDefinition } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { derivationPath, MAX_INDEX } from "../src/derivation.js";
import { DEFAULT_KDF, parseVaultEnvelope, type VaultEnvelopeV1 } from "../src/envelope.js";
import { isKeysError } from "../src/errors.js";
import { createMemoryStore } from "../src/store.js";
import { createSeedVault, deriveHardened } from "../src/vault.js";
import { counterRandom, FAST, HARDENED_VECTORS, importedVault, PASS, TEST_MNEMONIC } from "./helpers.js";

const kind = async (p: Promise<unknown> | (() => unknown)) => {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    return isKeysError(e) ? e.kind : `non-keys error: ${String(e)}`;
  }
  return "no error";
};

describe("hardened derivation", () => {
  it("matches independent vectors at m/44'/60'/0'/0'/n', including the last hardened index", async () => {
    const vault = await importedVault();
    for (const [i, sk] of Object.entries(HARDENED_VECTORS)) {
      expect(vault.address(Number(i))).toBe(privateKeyToAccount(sk).address);
    }
    expect(await deriveHardened(vault, 1)).toEqual({ path: "m/44'/60'/0'/0'/1'", address: privateKeyToAccount(HARDENED_VECTORS[1]!).address });
  });

  it("differs from the common non-hardened path (m/44'/60'/0'/0/0)", async () => {
    const vault = await importedVault();
    // Well-known address for the test phrase at m/44'/60'/0'/0/0.
    expect(vault.address(0)).not.toBe("0x9858EfFD232B4033E47d90003D41EC34EcaEda94");
  });

  it("gives distinct addresses at different indexes", async () => {
    const vault = await importedVault();
    const seen = new Set(Array.from({ length: 50 }, (_, i) => vault.address(i)));
    expect(seen.size).toBe(50);
  });

  it("rejects out-of-range indexes", async () => {
    const vault = await importedVault();
    for (const bad of [-1, MAX_INDEX + 1, 1.5, Number.NaN]) {
      expect(await kind(() => vault.address(bad))).toBe("validation");
    }
    expect(derivationPath(MAX_INDEX)).toBe("m/44'/60'/0'/0'/2147483647'");
  });
});

describe("create and import", () => {
  it("creates a valid 24-word mnemonic and a vault that reopens after restart", async () => {
    const store = createMemoryStore();
    const a = createSeedVault({ ...FAST, store });
    const { mnemonic, vaultId } = await a.create(PASS);
    expect(mnemonic.split(" ")).toHaveLength(24);
    expect(validateMnemonic(mnemonic, wordlist)).toBe(true);
    expect(a.isUnlocked()).toBe(true);
    const addr = a.address(3);

    const b = createSeedVault({ ...FAST, store }); // a new process on the same storage
    expect(b.isUnlocked()).toBe(false);
    expect(await b.vaultId()).toBe(vaultId);
    await b.unlock(PASS);
    expect(b.address(3)).toBe(addr);
  });

  it("can create a 12-word mnemonic, deterministic under injected randomness", async () => {
    const one = await createSeedVault({ ...FAST, random: counterRandom() }).create(PASS, { words: 12 });
    const two = await createSeedVault({ ...FAST, random: counterRandom() }).create(PASS, { words: 12 });
    expect(one.mnemonic.split(" ")).toHaveLength(12);
    expect(one).toEqual(two);
  });

  it("import round trip: a created mnemonic restores the same keys elsewhere", async () => {
    const a = createSeedVault(FAST);
    const { mnemonic, vaultId } = await a.create(PASS);
    const b = createSeedVault(FAST);
    expect(await b.importMnemonic(`  ${mnemonic.toUpperCase().replace(/ /g, "   ")}\n`, "another passphrase")).toEqual({ vaultId });
    expect(b.address(0)).toBe(a.address(0));
  });

  it("rejects invalid mnemonics and never overwrites an existing vault", async () => {
    const v = createSeedVault(FAST);
    expect(await kind(v.importMnemonic(TEST_MNEMONIC.replace(/about$/, "abandon"), PASS))).toBe("invalid_mnemonic");
    expect(await kind(v.importMnemonic("not a mnemonic", PASS))).toBe("invalid_mnemonic");
    await v.importMnemonic(TEST_MNEMONIC, PASS);
    expect(await kind(v.create(PASS))).toBe("vault_exists");
    expect(await kind(v.importMnemonic(TEST_MNEMONIC, PASS))).toBe("vault_exists");
  });

  it("refuses short passphrases and weak KDF settings", async () => {
    expect(await kind(createSeedVault(FAST).importMnemonic(TEST_MNEMONIC, "short"))).toBe("validation");
    expect(await kind(createSeedVault({ kdf: { m: 1024, t: 1, p: 1 } }).importMnemonic(TEST_MNEMONIC, PASS))).toBe("validation");
  });

  it("works with the production Argon2id parameters", async () => {
    const store = createMemoryStore();
    await createSeedVault({ store }).importMnemonic(TEST_MNEMONIC, PASS);
    const env = (await store.getVault())!;
    expect(env.kdf).toMatchObject({ alg: "argon2id", ...DEFAULT_KDF });
    const again = createSeedVault({ store });
    await again.unlock(PASS);
    expect(again.address(0)).toBe(privateKeyToAccount(HARDENED_VECTORS[0]!).address);
  }, 30_000);
});

describe("lock and unlock", () => {
  it("blocks derivation and signing when locked, including on accounts taken earlier", async () => {
    const vault = await importedVault();
    const account = vault.account(0);
    await expect(account.signMessage({ message: "ok" })).resolves.toMatch(/^0x/);
    vault.lock();
    expect(vault.isUnlocked()).toBe(false);
    expect(await kind(() => vault.address(0))).toBe("locked");
    expect(await kind(() => vault.account(0))).toBe("locked");
    expect(await kind(account.signMessage({ message: "after lock" }))).toBe("locked");
    expect(await kind(account.signTransaction({ chainId: 8453, to: account.address, value: 1n, gas: 21000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, nonce: 0 }))).toBe("locked");
  });

  it("fails on a wrong passphrase and on an empty store", async () => {
    const store = createMemoryStore();
    expect(await kind(createSeedVault({ ...FAST, store }).unlock(PASS))).toBe("no_vault");
    await createSeedVault({ ...FAST, store }).importMnemonic(TEST_MNEMONIC, PASS);
    const v = createSeedVault({ ...FAST, store });
    expect(await kind(v.unlock("wrong passphrase"))).toBe("decrypt_failed");
    expect(await kind(v.unlock(""))).toBe("decrypt_failed");
    expect(v.isUnlocked()).toBe(false);
  });

  it("changes the passphrase with a fresh salt and IV", async () => {
    const store = createMemoryStore();
    const v = createSeedVault({ ...FAST, store });
    await v.importMnemonic(TEST_MNEMONIC, PASS);
    const before = (await store.getVault())!;
    await v.changePassphrase(PASS, "a brand new passphrase");
    const after = (await store.getVault())!;
    expect(after.kdf.salt).not.toBe(before.kdf.salt);
    expect(after.cipher.iv).not.toBe(before.cipher.iv);
    expect(after.vaultId).toBe(before.vaultId);
    const w = createSeedVault({ ...FAST, store });
    expect(await kind(w.unlock(PASS))).toBe("decrypt_failed");
    await w.unlock("a brand new passphrase");
    expect(await kind(v.changePassphrase(PASS, "x".repeat(10)))).toBe("decrypt_failed");
  });
});

describe("encrypted format", () => {
  const sealed = async () => {
    const store = createMemoryStore();
    await createSeedVault({ ...FAST, store }).importMnemonic(TEST_MNEMONIC, PASS);
    return { store, env: (await store.getVault())! };
  };

  const unlockWith = async (env: unknown) => {
    const store = createMemoryStore();
    await store.updateVault(() => env as VaultEnvelopeV1);
    return kind(createSeedVault({ ...FAST, store }).unlock(PASS));
  };

  it("uses independent random salts and IVs for every seal", async () => {
    const a = (await sealed()).env;
    const b = (await sealed()).env;
    expect(a.kdf.salt).not.toBe(b.kdf.salt);
    expect(a.cipher.iv).not.toBe(b.cipher.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  it("rejects ciphertext tampering", async () => {
    const { env } = await sealed();
    const ct = Buffer.from(env.ct, "base64");
    ct[5]! ^= 1;
    expect(await unlockWith({ ...env, ct: ct.toString("base64") })).toBe("decrypt_failed");
    const tag = Buffer.from(env.ct, "base64");
    tag[tag.length - 1]! ^= 1;
    expect(await unlockWith({ ...env, ct: tag.toString("base64") })).toBe("decrypt_failed");
  });

  it("authenticates every header field", async () => {
    const { env } = await sealed();
    expect(await unlockWith({ ...env, createdAt: "2020-01-01T00:00:00.000Z" })).toBe("decrypt_failed");
    expect(await unlockWith({ ...env, vaultId: "0".repeat(32) })).toBe("decrypt_failed");
    expect(await unlockWith({ ...env, kdf: { ...env.kdf, t: env.kdf.t + 1 } })).toBe("decrypt_failed");
    const iv = Buffer.from(env.cipher.iv, "base64");
    iv[0]! ^= 1;
    expect(await unlockWith({ ...env, cipher: { ...env.cipher, iv: iv.toString("base64") } })).toBe("decrypt_failed");
  });

  it("refuses unknown versions, extra fields and out-of-bounds KDF costs before decrypting", async () => {
    const { env } = await sealed();
    expect(await unlockWith({ ...env, v: 2 })).toBe("unsupported_format");
    expect(await unlockWith({ ...env, extra: true })).toBe("unsupported_format");
    expect(await unlockWith({ ...env, kdf: { ...env.kdf, m: 1024 } })).toBe("unsupported_format");
    expect(await unlockWith({ ...env, kdf: { ...env.kdf, m: 2 ** 22 } })).toBe("unsupported_format");
    expect(await unlockWith({ ...env, cipher: { alg: "AES-128-CBC", iv: env.cipher.iv } })).toBe("unsupported_format");
    expect(() => parseVaultEnvelope(JSON.parse(JSON.stringify(env)))).not.toThrow();
  });

  it("stores no plaintext secret", async () => {
    const { env } = await sealed();
    const text = JSON.stringify(env);
    for (const secret of [TEST_MNEMONIC, "abandon abandon", PASS, "5eb00bbddcf06908", ...Object.values(HARDENED_VECTORS).map((k) => k.slice(2, 18))]) {
      expect(text.toLowerCase()).not.toContain(secret.toLowerCase());
    }
    expect(Object.keys(env).sort()).toEqual(["cipher", "createdAt", "ct", "format", "kdf", "v", "vaultId"]);
  });
});

describe("signing matches viem's reference account", () => {
  const typed: TypedDataDefinition = {
    domain: { name: "Shelter", version: "1", chainId: 8453 },
    types: { Mail: [{ name: "contents", type: "string" }] },
    primaryType: "Mail",
    message: { contents: "hello" },
  };

  it("message, typed data and transactions are byte-identical", async () => {
    const vault = await importedVault();
    const ours = vault.account(1);
    const ref = privateKeyToAccount(HARDENED_VECTORS[1]!);
    expect(ours.address).toBe(ref.address);
    expect(await ours.signMessage({ message: "Shelter test" })).toBe(await ref.signMessage({ message: "Shelter test" }));
    expect(await ours.signMessage({ message: { raw: "0xdeadbeef" } })).toBe(await ref.signMessage({ message: { raw: "0xdeadbeef" } }));
    expect(await ours.signTypedData(typed)).toBe(await ref.signTypedData(typed));
    const tx1559 = { chainId: 8453, to: ref.address, value: 12345n, gas: 21000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000n, nonce: 7 } as const;
    expect(await ours.signTransaction(tx1559)).toBe(await ref.signTransaction(tx1559));
    const legacy = { chainId: 1, to: ref.address, value: 1n, gas: 21000n, gasPrice: 3_000_000_000n, nonce: 0 } as const;
    expect(await ours.signTransaction(legacy)).toBe(await ref.signTransaction(legacy));
    expect(await ours.sign!({ hash: `0x${"11".repeat(32)}` })).toBe(await ref.sign({ hash: `0x${"11".repeat(32)}` }));
  });

  it("signatures recover to the derived address", async () => {
    const vault = await importedVault();
    const acct = vault.account(2);
    const sig = await acct.signMessage({ message: "recover me" });
    expect(await recoverMessageAddress({ message: "recover me", signature: sig })).toBe(acct.address);
    const tsig = await acct.signTypedData(typed);
    expect(await recoverTypedDataAddress({ ...typed, signature: tsig })).toBe(acct.address);
    expect(await verifyTypedData({ ...typed, address: acct.address, signature: tsig })).toBe(true);
    const raw = await acct.signTransaction({ chainId: 8453, to: acct.address, value: 1n, gas: 21000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, nonce: 0 });
    expect(parseTransaction(raw).chainId).toBe(8453);
  });

  it("account objects expose no private key", async () => {
    const vault = await importedVault();
    const acct = vault.account(0);
    const dump = JSON.stringify(acct, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    expect(dump).not.toContain(HARDENED_VECTORS[0]!.slice(2, 18));
    expect(Object.keys(acct)).not.toContain("privateKey");
  });
});
