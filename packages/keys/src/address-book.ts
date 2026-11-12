/**
 * Durable record of every derived address: which index, what it was made
 * for, and whether it is retired.
 *
 * Rules:
 * - An index is handed out at most once, even across crashes, tabs and
 *   processes: allocation reads `nextIndex`, derives, writes the record and
 *   advances `nextIndex` in one atomic store update.
 * - A retired address is never handed out again and `assertUsable` rejects it.
 *   Retirement is permanent; restore and recovery can only add retirements.
 * - Recovering a key (it can still sign, e.g. to sweep leftovers) is separate
 *   from permission to use the address for a new action, which recovered
 *   addresses never get.
 *
 * Separate from `@shelter/core`'s `AddressBook`, which holds the user's
 * labels for scanned public wallets. This one only tracks addresses derived
 * from the local seed.
 */

import { getAddress, isAddress } from "viem";
import { MAX_INDEX } from "./derivation.js";
import { openBackup, sealBackup, utf8, type BackupEnvelopeV1 } from "./envelope.js";
import { KeysError } from "./errors.js";
import { parseRecord } from "./records.js";
import type { AddressPurpose, AddressRecord, BookState, BookUpdate, KeyStore } from "./store.js";
import { vaultInternals, type SeedVault } from "./vault.js";

export interface AllocateInput {
  purpose: AddressPurpose;
  /** Chain the address is issued for, e.g. "base". */
  chain: string;
  label?: string;
}

export interface RecoverOptions {
  /**
   * Whether an address shows any on-chain use (nonce, balance, token history).
   * Each call reveals that address to whoever answers it; see the threat model.
   */
  isUsed(address: `0x${string}`): Promise<boolean>;
  /** Stop after this many consecutive unused, unknown indexes. Default 20. */
  gapLimit?: number;
  /** First index to scan. Default 0. */
  from?: number;
  /** Hard cap on indexes scanned in one call. Default 1000. */
  maxScan?: number;
  signal?: AbortSignal;
}

export interface RecoverResult {
  /** Addresses found in use that were not in the book; added as retired with purpose "recovered". */
  recovered: AddressRecord[];
  /** Last index checked. */
  scannedThrough: number;
  /** `nextIndex` after recovery. */
  nextIndex: number;
}

export interface AddressBook {
  /** Derives and records the next unused address. Requires an unlocked vault. */
  allocate(input: AllocateInput): Promise<AddressRecord>;
  /** Marks an address retired, permanently. Idempotent. */
  retire(address: string): Promise<AddressRecord>;
  /** Throws `retired` for a retired address and `not_found` for one not in the book. */
  assertUsable(address: string): Promise<AddressRecord>;
  get(address: string): Promise<AddressRecord | null>;
  list(): Promise<AddressRecord[]>;
  nextIndex(): Promise<number>;
  /** Encrypted backup of the records and `nextIndex`, keyed from the seed. Requires an unlocked vault. */
  exportBackup(): Promise<BackupEnvelopeV1>;
  /**
   * Restores a backup made from the same seed. Each record's address is
   * re-derived and must match. Merges with what is there: never lowers
   * `nextIndex`, and a retirement in either copy wins.
   */
  restoreBackup(backup: unknown): Promise<{ added: number; updated: number; nextIndex: number }>;
  /** Bounded scan of derived indexes for addresses used on-chain but missing from the book. */
  recover(options: RecoverOptions): Promise<RecoverResult>;
}

export function createAddressBook(vault: SeedVault, store: KeyStore = vaultInternals(vault).store): AddressBook {
  const inner = vaultInternals(vault);

  const find = async (address: string) => {
    const a = normalizeAddress(address);
    const { records } = await store.readBook();
    return records.find((r) => r.address === a) ?? null;
  };

  return {
    async allocate(input) {
      if (!input.chain || typeof input.chain !== "string") throw new KeysError("validation", "chain is required");
      if (!input.purpose || typeof input.purpose !== "string") throw new KeysError("validation", "purpose is required");
      inner.unlockedVaultId(); // fail fast with `locked` before touching the store
      await assertSameSeed(vault);
      const createdAt = inner.now().toISOString();
      return store.updateBook((state) => allocateIn(state, input, createdAt, (i) => vault.address(i)));
    },

    async retire(address) {
      const a = normalizeAddress(address);
      const at = inner.now().toISOString();
      return store.updateBook((state) => {
        const rec = state.records.find((r) => r.address === a);
        if (!rec) throw new KeysError("not_found", "address is not in the address book");
        if (rec.status === "retired") return { nextIndex: state.nextIndex, writes: [], result: rec };
        const next: AddressRecord = { ...rec, status: "retired", retiredAt: at };
        return { nextIndex: state.nextIndex, writes: [next], result: next };
      });
    },

    async assertUsable(address) {
      const rec = await find(address);
      if (!rec) throw new KeysError("not_found", "address is not in the address book");
      if (rec.status === "retired") throw new KeysError("retired", `address ${rec.address} is retired and must not be used again`);
      return rec;
    },

    get: find,
    list: async () => (await store.readBook()).records.sort((a, b) => a.index - b.index),
    nextIndex: async () => (await store.readBook()).nextIndex,

    async exportBackup() {
      const state = await store.readBook();
      const body = utf8(JSON.stringify({ nextIndex: state.nextIndex, records: state.records.sort((a, b) => a.index - b.index) }));
      const createdAt = inner.now().toISOString();
      // Seal while holding the seed; the seed buffer itself is never copied out.
      return inner.withSeed((seed, vaultId) => sealBackup(seed, body, { vaultId, createdAt }, inner.random));
    },

    async restoreBackup(raw) {
      const vaultId = inner.unlockedVaultId();
      const { envelope, plaintext } = await inner.withSeed((seed) => openBackup(seed, raw));
      if (envelope.vaultId !== vaultId) throw new KeysError("conflict", "backup was made from a different seed");
      const incoming = parseBackupBody(plaintext);
      for (const r of incoming.records) {
        if (vault.address(r.index) !== r.address) {
          throw new KeysError("conflict", `backup record ${r.index} does not match the address derived from this seed`);
        }
      }
      return store.updateBook((state) => mergeInto(state, incoming));
    },

    async recover(opts) {
      inner.unlockedVaultId();
      const gapLimit = opts.gapLimit ?? 20;
      const from = opts.from ?? 0;
      const maxScan = opts.maxScan ?? 1000;
      if (!Number.isSafeInteger(gapLimit) || gapLimit < 1 || gapLimit > 1000) throw new KeysError("validation", "gapLimit must be 1..1000");
      if (!Number.isSafeInteger(from) || from < 0 || from > MAX_INDEX) throw new KeysError("validation", "from must be a valid index");
      if (!Number.isSafeInteger(maxScan) || maxScan < 1) throw new KeysError("validation", "maxScan must be a positive integer");

      const known = new Set((await store.readBook()).records.map((r) => r.index));
      const found: AddressRecord[] = [];
      const at = inner.now().toISOString();
      let gap = 0;
      let i = from;
      let scannedThrough = from - 1;
      for (; i <= MAX_INDEX && i < from + maxScan && gap < gapLimit; i++) {
        opts.signal?.throwIfAborted();
        scannedThrough = i;
        if (known.has(i)) {
          gap = 0;
          continue;
        }
        const address = vault.address(i);
        if (await opts.isUsed(address)) {
          gap = 0;
          found.push({ index: i, address, chain: "unknown", purpose: "recovered", status: "retired", createdAt: at, retiredAt: at });
        } else {
          gap++;
        }
      }
      // Skip the whole scanned window: an index in the trailing gap may have
      // been handed out (e.g. as a receive address) without on-chain use yet.
      const nextIndex = await store.updateBook((state) => {
        const m = mergeInto(state, { nextIndex: Math.min(scannedThrough + 1, MAX_INDEX + 1), records: found });
        return { nextIndex: m.nextIndex, writes: m.writes, result: m.nextIndex };
      });
      return { recovered: found, scannedThrough, nextIndex };
    },
  };
}

// ---------- pure state transitions (shared by every adapter) ----------

export function allocateIn(
  state: BookState,
  input: AllocateInput,
  createdAt: string,
  deriveAddress: (index: number) => `0x${string}`,
): BookUpdate<AddressRecord> {
  const index = state.nextIndex;
  if (index > MAX_INDEX) throw new KeysError("validation", "derivation index space exhausted");
  if (state.records.some((r) => r.index >= index)) {
    throw new KeysError("conflict", "address book has a record at or beyond nextIndex; refusing to reuse an index");
  }
  const address = deriveAddress(index);
  if (state.records.some((r) => r.address === address)) throw new KeysError("conflict", "derived address already recorded");
  const rec: AddressRecord = { index, address, chain: input.chain, purpose: input.purpose, status: "active", createdAt };
  if (input.label !== undefined) rec.label = input.label;
  return { nextIndex: index + 1, writes: [rec], result: rec };
}

export function mergeInto(state: BookState, incoming: BookState): BookUpdate<{ added: number; updated: number; nextIndex: number }> {
  const byIndex = new Map(state.records.map((r) => [r.index, r]));
  const byAddress = new Map(state.records.map((r) => [r.address, r]));
  const writes: AddressRecord[] = [];
  let added = 0;
  let updated = 0;
  let maxIndex = -1;
  for (const r of incoming.records) {
    maxIndex = Math.max(maxIndex, r.index);
    const e = byIndex.get(r.index);
    if (!e) {
      const clash = byAddress.get(r.address);
      if (clash) throw new KeysError("conflict", `address ${r.address} is recorded at index ${clash.index}, not ${r.index}`);
      writes.push(r);
      added++;
      continue;
    }
    if (e.address !== r.address) throw new KeysError("conflict", `index ${r.index} maps to different addresses`);
    if (e.status !== "retired" && r.status === "retired") {
      writes.push({ ...e, status: "retired", retiredAt: r.retiredAt ?? r.createdAt });
      updated++;
    }
  }
  const nextIndex = Math.max(state.nextIndex, incoming.nextIndex, maxIndex + 1);
  return { nextIndex, writes, result: { added, updated, nextIndex } };
}

async function assertSameSeed(vault: SeedVault): Promise<void> {
  const stored = await vault.vaultId();
  if (stored !== null && stored !== vaultInternals(vault).unlockedVaultId()) {
    throw new KeysError("conflict", "the unlocked seed is not the one stored in this vault");
  }
}

function normalizeAddress(a: string): `0x${string}` {
  if (typeof a !== "string" || !isAddress(a, { strict: false })) throw new KeysError("validation", "not an EVM address");
  return getAddress(a);
}

function parseBackupBody(plaintext: Uint8Array): BookState {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
  } catch (cause) {
    throw new KeysError("unsupported_format", "backup body is not JSON", { cause });
  }
  const o = raw as { nextIndex?: unknown; records?: unknown };
  if (typeof o !== "object" || o === null || !Number.isSafeInteger(o.nextIndex) || !Array.isArray(o.records)) {
    throw new KeysError("unsupported_format", "backup body has the wrong shape");
  }
  const nextIndex = o.nextIndex as number;
  if (nextIndex < 0 || nextIndex > MAX_INDEX + 1) throw new KeysError("unsupported_format", "backup nextIndex out of range");
  const seen = new Set<number>();
  const records = o.records.map((r: unknown) => {
    const rec = parseRecord(r);
    if (seen.has(rec.index)) throw new KeysError("unsupported_format", `backup has index ${rec.index} twice`);
    seen.add(rec.index);
    return rec;
  });
  return { nextIndex, records };
}
