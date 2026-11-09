/**
 * Persistence contract for the vault and the address book, plus an in-memory
 * adapter. Durable adapters: `@shelter/keys/idb` (browser, IndexedDB) and
 * `@shelter/keys/sqlite` (CLI, Node's built-in `node:sqlite`).
 *
 * Every write goes through an atomic read-modify-write: the adapter reads the
 * current state, calls a synchronous function, and either commits everything
 * it returns or nothing. All allocation and merge rules live in that function
 * (see `address-book.ts`), so the adapters stay thin and behave identically.
 *
 * Stored data never contains a passphrase, mnemonic, seed or private key in
 * plaintext: the vault is an encrypted envelope and address records hold only
 * public data.
 */

import type { VaultEnvelopeV1 } from "./envelope.js";

export type AddressStatus = "active" | "retired";

/** What an address was made for. Free-form beyond the names Shelter uses. */
export type AddressPurpose = "burner" | "destination" | "recovered" | (string & {});

export interface AddressRecord {
  /** Hardened derivation index; unique and never reused. */
  index: number;
  /** Checksummed EVM address derived at `index`; unique. */
  address: `0x${string}`;
  /** Chain the address was issued for (e.g. "base"). Informational: the same key works on every EVM chain. */
  chain: string;
  purpose: AddressPurpose;
  status: AddressStatus;
  label?: string;
  createdAt: string;
  /** Set once, when the address is first retired. */
  retiredAt?: string;
}

export interface BookState {
  /** Next index to hand out. Only ever grows. */
  nextIndex: number;
  records: AddressRecord[];
}

export interface BookUpdate<T> {
  nextIndex: number;
  /** Records to insert or replace (by index). Records not listed are left as they are. */
  writes: AddressRecord[];
  result: T;
}

export interface KeyStore {
  getVault(): Promise<VaultEnvelopeV1 | null>;
  /**
   * Atomically replaces the vault with what `fn` returns, given the current
   * one. Throwing inside `fn` aborts without writing.
   */
  updateVault(fn: (current: VaultEnvelopeV1 | null) => VaultEnvelopeV1): Promise<void>;
  readBook(): Promise<BookState>;
  /**
   * Atomic read-modify-write of the address book. `fn` must be synchronous;
   * throwing aborts without writing. Concurrent callers, including other tabs
   * or processes on the same database, are serialised by the adapter.
   */
  updateBook<T>(fn: (state: BookState) => BookUpdate<T>): Promise<T>;
  close?(): void;
}

/** Process-local store for tests and ephemeral sessions. Not durable. */
export function createMemoryStore(): KeyStore {
  let vault: VaultEnvelopeV1 | null = null;
  let nextIndex = 0;
  const records = new Map<number, AddressRecord>();
  let queue: Promise<unknown> = Promise.resolve();

  const serial = <T>(fn: () => T): Promise<T> => {
    const run = queue.then(fn);
    queue = run.catch(() => undefined);
    return run;
  };

  return {
    getVault: () => serial(() => (vault ? structuredClone(vault) : null)),
    updateVault: (fn) =>
      serial(() => {
        vault = structuredClone(fn(vault ? structuredClone(vault) : null));
      }),
    readBook: () => serial(() => ({ nextIndex, records: [...records.values()].map((r) => structuredClone(r)) })),
    updateBook: (fn) =>
      serial(() => {
        const u = fn({ nextIndex, records: [...records.values()].map((r) => structuredClone(r)) });
        nextIndex = u.nextIndex;
        for (const r of u.writes) records.set(r.index, structuredClone(r));
        return u.result;
      }),
  };
}
