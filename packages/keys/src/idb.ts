/**
 * IndexedDB adapter for the browser.
 *
 * Database `shelter-keys` (configurable), version 1:
 * - `meta`: out-of-line keys `vault` (encrypted envelope) and `nextIndex`.
 * - `addresses`: keyPath `index`, unique index on `address`.
 *
 * Each update is one `readwrite` transaction over both stores with
 * `durability: "strict"` where supported. IndexedDB runs overlapping
 * `readwrite` transactions one at a time, across tabs too, so two tabs cannot
 * allocate the same index. Inside a transaction this adapter only uses request
 * callbacks (no awaits), so the transaction cannot auto-commit half way.
 */

import { parseRecord } from "./records.js";
import { parseVaultEnvelope, type VaultEnvelopeV1 } from "./envelope.js";
import { KeysError } from "./errors.js";
import type { AddressRecord, BookState, BookUpdate, KeyStore } from "./store.js";

export interface IndexedDbStoreOptions {
  name?: string;
  /** Defaults to `globalThis.indexedDB`. */
  indexedDB?: IDBFactory;
}

const META = "meta";
const ADDRESSES = "addresses";

export async function createIndexedDbStore(options: IndexedDbStoreOptions = {}): Promise<KeyStore> {
  const factory = options.indexedDB ?? globalThis.indexedDB;
  if (!factory) throw new KeysError("storage", "IndexedDB is not available in this environment");
  const db = await open(factory, options.name ?? "shelter-keys");

  const run = <T>(mode: IDBTransactionMode, body: (tx: IDBTransaction, done: (v: T) => void, fail: (e: unknown) => void) => void) =>
    new Promise<T>((resolve, reject) => {
      let tx: IDBTransaction;
      try {
        tx = db.transaction([META, ADDRESSES], mode, { durability: "strict" });
      } catch (cause) {
        reject(new KeysError("storage", "could not start an IndexedDB transaction", { cause }));
        return;
      }
      let value: T;
      let failure: unknown;
      tx.oncomplete = () => (failure === undefined ? resolve(value) : reject(failure));
      tx.onabort = () => reject(failure ?? new KeysError("storage", "IndexedDB transaction aborted", { cause: tx.error }));
      tx.onerror = (ev) => {
        if (failure === undefined) failure = new KeysError("storage", "IndexedDB request failed", { cause: tx.error });
        ev.preventDefault();
      };
      body(
        tx,
        (v) => (value = v),
        (e) => {
          failure = e;
          try {
            tx.abort();
          } catch {
            /* already finished */
          }
        },
      );
    });

  const readState = (tx: IDBTransaction, cb: (s: BookState, vault: VaultEnvelopeV1 | null) => void, fail: (e: unknown) => void) => {
    const meta = tx.objectStore(META);
    const nextReq = meta.get("nextIndex");
    const vaultReq = meta.get("vault");
    const allReq = tx.objectStore(ADDRESSES).getAll();
    allReq.onsuccess = () => {
      try {
        const records = (allReq.result as unknown[]).map(parseRecord);
        const vault = vaultReq.result === undefined ? null : parseVaultEnvelope(vaultReq.result);
        cb({ nextIndex: typeof nextReq.result === "number" ? nextReq.result : 0, records }, vault);
      } catch (e) {
        fail(e);
      }
    };
  };

  return {
    getVault: () =>
      run<VaultEnvelopeV1 | null>("readonly", (tx, done, fail) => readState(tx, (_s, v) => done(v), fail)),

    updateVault: (fn) =>
      run<void>("readwrite", (tx, done, fail) =>
        readState(tx, (_s, current) => {
          try {
            tx.objectStore(META).put(fn(current), "vault");
            done();
          } catch (e) {
            fail(e);
          }
        }, fail),
      ),

    readBook: () => run<BookState>("readonly", (tx, done, fail) => readState(tx, (s) => done(s), fail)),

    updateBook: <T>(fn: (s: BookState) => BookUpdate<T>) =>
      run<T>("readwrite", (tx, done, fail) =>
        readState(tx, (state) => {
          try {
            const u = fn(state);
            const addresses = tx.objectStore(ADDRESSES);
            for (const r of u.writes) addresses.put(plain(r));
            tx.objectStore(META).put(u.nextIndex, "nextIndex");
            done(u.result);
          } catch (e) {
            fail(e);
          }
        }, fail),
      ),

    close: () => db.close(),
  };
}

function plain(r: AddressRecord): AddressRecord {
  // Drop undefined optionals so stored objects match the record format exactly.
  return JSON.parse(JSON.stringify(r)) as AddressRecord;
}

function open(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(name, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
      if (!db.objectStoreNames.contains(ADDRESSES)) {
        db.createObjectStore(ADDRESSES, { keyPath: "index" }).createIndex("address", "address", { unique: true });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // Let a future schema upgrade in another tab proceed instead of blocking it.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(new KeysError("storage", "could not open IndexedDB", { cause: req.error }));
    req.onblocked = () => reject(new KeysError("storage", "IndexedDB open is blocked by another tab"));
  });
}
