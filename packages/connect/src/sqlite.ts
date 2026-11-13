/**
 * SQLite account store for the CLI, on Node's built-in `node:sqlite`.
 * Node-only: import it as `@shelter/connect/sqlite`.
 *
 * Schema version 1 (`PRAGMA user_version`):
 *   accounts(id TEXT PRIMARY KEY, rev INTEGER NOT NULL, created_at TEXT NOT NULL, account TEXT NOT NULL)
 *
 * Same guarantees as the burner job store: one conditional UPDATE per write
 * (compare-and-swap on `rev`), WAL with `synchronous=FULL` so a signed
 * transaction recorded before broadcast survives a crash, file 0600 in a
 * 0700 directory.
 */

import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseAccount, type AccountStore, type ConnectAccount, type StoredAccount } from "./account.js";
import { ConnectError, isConnectError } from "./errors.js";

const SCHEMA_VERSION = 1;

export function createSqliteAccountStore(path: string, options: { busyTimeoutMs?: number } = {}): AccountStore {
  if (path !== ":memory:") prepareFile(path);
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path);
  } catch (cause) {
    throw new ConnectError("storage", "could not open the Connect database", { cause });
  }
  try {
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(options.busyTimeoutMs ?? 5000))}`);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = FULL");
    const v = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (v === 0) {
      db.exec("CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, rev INTEGER NOT NULL, created_at TEXT NOT NULL, account TEXT NOT NULL)");
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    } else if (v !== SCHEMA_VERSION) {
      throw new ConnectError("storage", `Connect database has unsupported schema version ${v}`);
    }
  } catch (e) {
    db.close();
    if (isConnectError(e)) throw e;
    throw new ConnectError("storage", "could not prepare the Connect database", { cause: e });
  }

  const getOne = db.prepare("SELECT account, rev FROM accounts WHERE id = ?");
  const getAll = db.prepare("SELECT account, rev FROM accounts ORDER BY created_at, id");
  const insert = db.prepare("INSERT INTO accounts (id, rev, created_at, account) VALUES (?, 1, ?, ?) ON CONFLICT(id) DO NOTHING");
  const cas = db.prepare("UPDATE accounts SET account = ?, rev = rev + 1 WHERE id = ? AND rev = ?");

  const row = (r: { account: string; rev: number }): StoredAccount => ({ account: parseAccount(JSON.parse(r.account)), rev: Number(r.rev) });
  const run = <T>(what: string, fn: () => T): T => {
    try {
      return fn();
    } catch (cause) {
      if (isConnectError(cause)) throw cause;
      throw new ConnectError("storage", `Connect database: ${what} failed`, { cause });
    }
  };

  return {
    async get(id) {
      return run("read", () => {
        const r = getOne.get(id) as { account: string; rev: number } | undefined;
        return r ? row(r) : null;
      });
    },
    async list() {
      return run("list", () => (getAll.all() as { account: string; rev: number }[]).map(row));
    },
    async create(a: ConnectAccount) {
      return run("create", () => {
        const res = insert.run(a.id, a.createdAt, JSON.stringify(a));
        if (Number(res.changes) !== 1) throw new ConnectError("busy", `account ${a.id} already exists`);
        return { account: structuredClone(a), rev: 1 };
      });
    },
    async update(a: ConnectAccount, rev: number) {
      return run("update", () => {
        const res = cas.run(JSON.stringify(a), a.id, rev);
        if (Number(res.changes) !== 1) {
          throw getOne.get(a.id)
            ? new ConnectError("busy", `account ${a.id} was changed elsewhere`)
            : new ConnectError("not_found", `account ${a.id} does not exist`);
        }
        return { account: structuredClone(a), rev: rev + 1 };
      });
    },
    close() {
      db.close();
    },
  };
}

function prepareFile(path: string) {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!existsSync(path)) closeSync(openSync(path, "a", 0o600));
  try {
    chmodSync(path, 0o600);
  } catch {
    /* not the owner; opening will tell */
  }
}
