/**
 * IndexedDB job store for the browser: `@shelter/burner/idb`.
 *
 * Database `shelter-burner` (configurable), version 1, one object store
 * `jobs` with out-of-line keys (the job id); each value is
 * `{ rev, createdAt, json }`.
 *
 * Compare-and-swap: an update reads the stored revision and writes inside
 * one `readwrite` transaction (`durability: "strict"` where supported).
 * IndexedDB runs overlapping `readwrite` transactions one at a time, across
 * tabs too, so two tabs cannot both advance a job. Inside a transaction only
 * request callbacks are used (no awaits), so it cannot auto-commit half way.
 */

import { BurnerError } from "./errors.js";
import { parseJob, type BurnerJob, type JobStore, type StoredJob } from "./job.js";

export interface IndexedDbJobStoreOptions {
  name?: string;
  /** Defaults to `globalThis.indexedDB`. */
  indexedDB?: IDBFactory;
}

const JOBS = "jobs";

interface Row {
  rev: number;
  createdAt: string;
  json: string;
}

export async function createIndexedDbJobStore(options: IndexedDbJobStoreOptions = {}): Promise<JobStore> {
  const factory = options.indexedDB ?? globalThis.indexedDB;
  if (!factory) throw new BurnerError("storage", "IndexedDB is not available in this environment");
  const db = await open(factory, options.name ?? "shelter-burner");

  const run = <T>(mode: IDBTransactionMode, body: (store: IDBObjectStore, done: (v: T) => void, fail: (e: unknown) => void) => void) =>
    new Promise<T>((resolve, reject) => {
      let tx: IDBTransaction;
      try {
        tx = db.transaction(JOBS, mode, { durability: "strict" });
      } catch (cause) {
        reject(new BurnerError("storage", "could not start an IndexedDB transaction", { cause }));
        return;
      }
      let value: T;
      let failure: unknown;
      tx.oncomplete = () => (failure === undefined ? resolve(value) : reject(failure));
      tx.onabort = () => reject(failure ?? new BurnerError("storage", "IndexedDB transaction aborted", { cause: tx.error }));
      tx.onerror = (ev) => {
        if (failure === undefined) failure = new BurnerError("storage", "IndexedDB request failed", { cause: tx.error });
        ev.preventDefault();
      };
      body(
        tx.objectStore(JOBS),
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

  const toStored = (r: Row): StoredJob => ({ job: parseJob(JSON.parse(r.json)), rev: r.rev });

  return {
    get: (id) =>
      run<StoredJob | null>("readonly", (store, done, fail) => {
        const req = store.get(id);
        req.onsuccess = () => {
          try {
            done(req.result === undefined ? null : toStored(req.result as Row));
          } catch (e) {
            fail(e);
          }
        };
      }),

    list: () =>
      run<StoredJob[]>("readonly", (store, done, fail) => {
        const req = store.getAll();
        req.onsuccess = () => {
          try {
            const rows = (req.result as Row[]).slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
            done(rows.map(toStored));
          } catch (e) {
            fail(e);
          }
        };
      }),

    create: (job: BurnerJob) =>
      run<StoredJob>("readwrite", (store, done, fail) => {
        const req = store.get(job.id);
        req.onsuccess = () => {
          if (req.result !== undefined) return fail(new BurnerError("busy", `job ${job.id} already exists`));
          store.put({ rev: 1, createdAt: job.createdAt, json: JSON.stringify(job) } satisfies Row, job.id);
          done({ job: structuredClone(job), rev: 1 });
        };
      }),

    update: (job: BurnerJob, rev: number) =>
      run<StoredJob>("readwrite", (store, done, fail) => {
        const req = store.get(job.id);
        req.onsuccess = () => {
          const cur = req.result as Row | undefined;
          if (!cur) return fail(new BurnerError("not_found", `job ${job.id} does not exist`));
          if (cur.rev !== rev) return fail(new BurnerError("busy", `job ${job.id} was changed by another runner`));
          store.put({ rev: rev + 1, createdAt: cur.createdAt, json: JSON.stringify(job) } satisfies Row, job.id);
          done({ job: structuredClone(job), rev: rev + 1 });
        };
      }),

    close: () => db.close(),
  };
}

function open(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(name, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(JOBS)) req.result.createObjectStore(JOBS);
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(new BurnerError("storage", "could not open IndexedDB", { cause: req.error }));
    req.onblocked = () => reject(new BurnerError("storage", "IndexedDB open is blocked by another tab"));
  });
}
