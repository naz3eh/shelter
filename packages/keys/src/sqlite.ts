/**
 * SQLite adapter for the CLI, on Node's built-in `node:sqlite` (Node 24+).
 * Node-only: import it as `@shelter/keys/sqlite`, never from browser code.
 *
 * Schema version 1 (`PRAGMA user_version`):
 * - `meta(key TEXT PRIMARY KEY, value TEXT)`: `vault` (encrypted envelope JSON), `nextIndex`.
 * - `addresses(idx INTEGER PRIMARY KEY, address TEXT UNIQUE, record TEXT)`.
 *
 * Every update runs inside `BEGIN IMMEDIATE`, which takes the database write
 * lock before reading, so concurrent processes on the same file are
 * serialised (they wait up to `busyTimeoutMs`). WAL journal with
 * `synchronous=FULL`: a committed allocation survives a crash or power loss.
 * The file and its directory are created owner-only (0600 / 0700).
 */

import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseVaultEnvelope, type VaultEnvelopeV1 } from "./envelope.js";
import { KeysError, isKeysError } from "./errors.js";
import { parseRecord } from "./records.js";
import type { BookState, BookUpdate, KeyStore } from "./store.js";

export interface SqliteStoreOptions {
  /** How long to wait for another process's write lock. Default 5000 ms. */
  busyTimeoutMs?: number;
}

const SCHEMA_VERSION = 1;

export function createSqliteStore(path: string, options: SqliteStoreOptions = {}): KeyStore {
  if (path !== ":memory:") prepareFile(path);
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path);
  } catch (cause) {
    throw new KeysError("storage", "could not open the key store database", { cause });
  }
  try {
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(options.busyTimeoutMs ?? 5000))}`);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = FULL");
    migrate(db);
  } catch (e) {
    db.close();
    if (isKeysError(e)) throw e;
    throw new KeysError("storage", "could not prepare the key store database", { cause: e });
  }

  const getMeta = db.prepare("SELECT value FROM meta WHERE key = ?");
  const putMeta = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  const allAddresses = db.prepare("SELECT record FROM addresses ORDER BY idx");
  const putAddress = db.prepare(
    "INSERT INTO addresses (idx, address, record) VALUES (?, ?, ?) ON CONFLICT(idx) DO UPDATE SET address = excluded.address, record = excluded.record",
  );

  const readVault = (): VaultEnvelopeV1 | null => {
    const row = getMeta.get("vault") as { value: string } | undefined;
    return row ? parseVaultEnvelope(JSON.parse(row.value)) : null;
  };

  const readState = (): BookState => {
    const row = getMeta.get("nextIndex") as { value: string } | undefined;
    const records = (allAddresses.all() as { record: string }[]).map((r) => parseRecord(JSON.parse(r.record)));
    return { nextIndex: row ? Number(row.value) : 0, records };
  };

  /** BEGIN IMMEDIATE ... COMMIT around a synchronous body; rolls back on any throw. */
  const transaction = <T>(body: () => T): T => {
    try {
      db.exec("BEGIN IMMEDIATE");
    } catch (cause) {
      throw new KeysError("storage", "could not lock the key store database (busy?)", { cause });
    }
    try {
      const result = body();
      db.exec("COMMIT");
      return result;
    } catch (e) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* the failed statement may already have rolled back */
      }
      if (isKeysError(e)) throw e;
      throw new KeysError("storage", "key store write failed", { cause: e });
    }
  };

  const reading = <T>(body: () => T): Promise<T> => {
    try {
      return Promise.resolve(body());
    } catch (e) {
      return Promise.reject(isKeysError(e) ? e : new KeysError("storage", "key store read failed", { cause: e }));
    }
  };

  const writing = <T>(body: () => T): Promise<T> => {
    try {
      return Promise.resolve(transaction(body));
    } catch (e) {
      return Promise.reject(e);
    }
  };

  return {
    getVault: () => reading(readVault),

    updateVault: (fn) =>
      writing(() => {
        putMeta.run("vault", JSON.stringify(fn(readVault())));
      }),

    readBook: () => reading(readState),

    updateBook: <T>(fn: (s: BookState) => BookUpdate<T>) =>
      writing(() => {
        const u = fn(readState());
        for (const r of u.writes) putAddress.run(r.index, r.address, JSON.stringify(r));
        putMeta.run("nextIndex", String(u.nextIndex));
        return u.result;
      }),

    close: () => db.close(),
  };
}

function migrate(db: DatabaseSync): void {
  const { user_version: v } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  if (v === SCHEMA_VERSION) return;
  if (v !== 0) throw new KeysError("unsupported_format", `key store schema version ${v} is newer than this build supports`);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS addresses (
        idx INTEGER PRIMARY KEY CHECK (idx >= 0 AND idx <= 2147483647),
        address TEXT NOT NULL UNIQUE,
        record TEXT NOT NULL
      ) STRICT;
      PRAGMA user_version = ${SCHEMA_VERSION};
    `);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

function prepareFile(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!existsSync(path)) closeSync(openSync(path, "a", 0o600));
  try {
    chmodSync(path, 0o600);
  } catch {
    /* not supported on every filesystem; the vault inside is encrypted regardless */
  }
}
