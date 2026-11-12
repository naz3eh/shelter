/**
 * Local seed vault: one BIP-39 seed, encrypted at rest, used only through
 * derivation and signing calls while unlocked.
 *
 * What is stored: the 64-byte BIP-39 seed (no BIP-39 passphrase), sealed by
 * `envelope.ts`. The mnemonic is not stored, so it cannot be shown again
 * later; `create()` returns it exactly once for the user to write down.
 *
 * Memory: while unlocked the seed and BIP-32 root live in Uint8Arrays that
 * `lock()` overwrites with zeros. JavaScript cannot guarantee erasure: the
 * mnemonic and passphrase arrive as strings (immutable, never wiped), and the
 * engine or GC may have copied buffers. Locking stops further use; it does not
 * prove the bytes are gone from memory.
 */

import { HDKey } from "@scure/bip32";
import { entropyToMnemonic, mnemonicToSeed, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import type { LocalAccount } from "viem";
import { addressOf, assertIndex, childPrivateKey, derivationPath, signingAccount } from "./derivation.js";
import { defaultRandom, openSeed, sealSeed, vaultIdFor, type KdfParams, type RandomSource } from "./envelope.js";
import { KeysError } from "./errors.js";
import { createMemoryStore, type KeyStore } from "./store.js";

export interface SeedVault {
  isUnlocked(): boolean;
  /** Decrypts the stored seed. Throws `no_vault` or `decrypt_failed`. */
  unlock(passphrase: string): Promise<void>;
  /** Wipes the in-memory seed. Every later derivation or signature throws `locked`. */
  lock(): void;

  /** True when the store holds a vault. */
  exists(): Promise<boolean>;
  /** Public id of the stored seed, readable without unlocking; null when there is no vault. */
  vaultId(): Promise<string | null>;
  /**
   * Generates a new seed, stores it encrypted and leaves the vault unlocked.
   * Returns the mnemonic once, for the user's offline backup. Refuses to
   * overwrite an existing vault (`vault_exists`).
   */
  create(passphrase: string, options?: { words?: 12 | 24 }): Promise<{ mnemonic: string; vaultId: string }>;
  /** Imports an English BIP-39 mnemonic, stores it encrypted and leaves the vault unlocked. */
  importMnemonic(mnemonic: string, passphrase: string): Promise<{ vaultId: string }>;
  /** Re-encrypts the seed under a new passphrase with a fresh salt and IV. */
  changePassphrase(current: string, next: string): Promise<void>;

  /** Checksummed address at hardened index `index`. Requires an unlocked vault. */
  address(index: number): `0x${string}`;
  /**
   * A viem LocalAccount for index `index`. Signing re-checks the lock on every
   * call, so an account object kept after `lock()` cannot sign.
   */
  account(index: number): LocalAccount;
}

export interface SeedVaultOptions {
  /** Defaults to an in-memory store (nothing survives a reload). */
  store?: KeyStore;
  kdf?: KdfParams;
  random?: RandomSource;
  now?: () => Date;
}

interface Unlocked {
  seed: Uint8Array;
  root: HDKey;
  vaultId: string;
}

interface Internals {
  store: KeyStore;
  random: RandomSource;
  now: () => Date;
  /** Runs `fn` with the unlocked seed. Throws `locked` otherwise. */
  withSeed<T>(fn: (seed: Uint8Array, vaultId: string) => T): T;
  unlockedVaultId(): string;
}

const internals = new WeakMap<SeedVault, Internals>();

/** Package-internal access for the address book (backup key, seed binding). */
export function vaultInternals(vault: SeedVault): Internals {
  const i = internals.get(vault);
  if (!i) throw new KeysError("validation", "not a vault created by createSeedVault");
  return i;
}

export function createSeedVault(options: SeedVaultOptions = {}): SeedVault {
  const store = options.store ?? createMemoryStore();
  const random = options.random ?? defaultRandom;
  const now = options.now ?? (() => new Date());
  let state: Unlocked | null = null;

  const unlocked = (): Unlocked => {
    if (!state) throw new KeysError("locked", "the vault is locked");
    return state;
  };

  const wipe = () => {
    if (!state) return;
    state.root.wipePrivateData();
    state.seed.fill(0);
    state = null;
  };

  const adopt = (seed: Uint8Array): Unlocked => {
    const root = HDKey.fromMasterSeed(seed);
    if (!root.publicKey) throw new KeysError("storage", "seed produced no master public key");
    return { seed, root, vaultId: vaultIdFor(root.publicKey) };
  };

  const storeNew = async (seed: Uint8Array, passphrase: string): Promise<string> => {
    const next = adopt(seed);
    try {
      const envelope = await sealSeed(seed, passphrase, { vaultId: next.vaultId, createdAt: now().toISOString() }, { kdf: options.kdf, random });
      await store.updateVault((current) => {
        if (current) throw new KeysError("vault_exists", "a vault already exists in this store");
        return envelope;
      });
    } catch (e) {
      next.root.wipePrivateData();
      seed.fill(0);
      throw e;
    }
    wipe();
    state = next;
    return next.vaultId;
  };

  const withKey = (index: number) => <T>(use: (privateKey: Uint8Array) => T): T => {
    const sk = childPrivateKey(unlocked().root, index);
    try {
      return use(sk);
    } finally {
      sk.fill(0);
    }
  };

  const vault: SeedVault = {
    isUnlocked: () => state !== null,

    async unlock(passphrase) {
      const envelope = await store.getVault();
      if (!envelope) throw new KeysError("no_vault", "no vault in this store");
      const seed = await openSeed(envelope, passphrase);
      const next = adopt(seed);
      if (next.vaultId !== envelope.vaultId) {
        next.root.wipePrivateData();
        seed.fill(0);
        throw new KeysError("decrypt_failed", "vault id does not match the decrypted seed");
      }
      wipe();
      state = next;
    },

    lock: wipe,

    exists: async () => (await store.getVault()) !== null,
    vaultId: async () => (await store.getVault())?.vaultId ?? null,

    async create(passphrase, opts = {}) {
      const words = opts.words ?? 24;
      if (words !== 12 && words !== 24) throw new KeysError("validation", "words must be 12 or 24");
      if (await store.getVault()) throw new KeysError("vault_exists", "a vault already exists in this store");
      const entropy = random(words === 24 ? 32 : 16);
      const mnemonic = entropyToMnemonic(entropy, wordlist);
      entropy.fill(0);
      const vaultId = await storeNew(await mnemonicToSeed(mnemonic), passphrase);
      return { mnemonic, vaultId };
    },

    async importMnemonic(mnemonic, passphrase) {
      const normalized = normalizeMnemonic(mnemonic);
      if (!validateMnemonic(normalized, wordlist)) throw new KeysError("invalid_mnemonic", "not a valid English BIP-39 mnemonic");
      if (await store.getVault()) throw new KeysError("vault_exists", "a vault already exists in this store");
      return { vaultId: await storeNew(await mnemonicToSeed(normalized), passphrase) };
    },

    async changePassphrase(current, next) {
      const envelope = await store.getVault();
      if (!envelope) throw new KeysError("no_vault", "no vault in this store");
      const seed = await openSeed(envelope, current);
      try {
        const sealed = await sealSeed(seed, next, { vaultId: envelope.vaultId, createdAt: envelope.createdAt }, { kdf: options.kdf, random });
        await store.updateVault((cur) => {
          if (!cur || cur.ct !== envelope.ct) throw new KeysError("conflict", "the vault changed during the passphrase change; retry");
          return sealed;
        });
      } finally {
        seed.fill(0);
      }
    },

    address(index) {
      assertIndex(index);
      return withKey(index)(addressOf);
    },

    account(index) {
      return signingAccount(vault.address(index), withKey(index));
    },
  };

  internals.set(vault, {
    store,
    random,
    now,
    withSeed: (fn) => {
      const s = unlocked();
      return fn(s.seed, s.vaultId);
    },
    unlockedVaultId: () => unlocked().vaultId,
  });

  return vault;
}

export interface DerivedKey {
  /** Hardened derivation path, m/44'/60'/0'/0'/n'. */
  path: string;
  address: string;
}

/** Path and address at a hardened index. Requires an unlocked vault. */
export async function deriveHardened(vault: SeedVault, index: number): Promise<DerivedKey> {
  return { path: derivationPath(index), address: vault.address(index) };
}

/** Lowercase, NFKD, single spaces: the form BIP-39 validates against. */
export function normalizeMnemonic(m: string): string {
  return m.normalize("NFKD").trim().toLowerCase().split(/\s+/u).join(" ");
}
