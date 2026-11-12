/**
 * SQLite job store for the CLI, on Node's built-in `node:sqlite` (Node 24+).
 * Node-only: import it as `@shelter/burner/sqlite`.
 *
 * Schema version 1 (`PRAGMA user_version`):
 *   jobs(id TEXT PRIMARY KEY, rev INTEGER NOT NULL, created_at TEXT NOT NULL, job TEXT NOT NULL)
 *
 * Writes are a single conditional statement (`UPDATE ... WHERE rev = ?`), so
 * two processes on one file cannot both advance a job. WAL with
 * `synchronous=FULL`: a recorded signed intent or signed transaction
 * survives a crash before it is sent. File 0600 in a 0700 directory.
 */

import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BurnerError, isBurnerError } from "./errors.js";
import { parseJob, type BurnerJob, type JobStore, type StoredJob } from "./job.js";

const SCHEMA_VERSION = 1;

export function createSqliteJobStore(path: string, options: { busyTimeoutMs?: number } = {}): JobStore {
  if (path !== ":memory:") prepareFile(path);
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path);
  } catch (cause) {
    throw new BurnerError("storage", "could not open the burner job database", { cause });
  }
  try {
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(options.busyTimeoutMs ?? 5000))}`);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = FULL");
    const v = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (v === 0) {
      db.exec(
        "CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, rev INTEGER NOT NULL, created_at TEXT NOT NULL, job TEXT NOT NULL)",
      );
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    } else if (v !== SCHEMA_VERSION) {
      throw new BurnerError("storage", `burner job database has unsupported schema version ${v}`);
    }
  } catch (e) {
    db.close();
    if (isBurnerError(e)) throw e;
    throw new BurnerError("storage", "could not prepare the burner job database", { cause: e });
  }

  const getOne = db.prepare("SELECT job, rev FROM jobs WHERE id = ?");
  const getAll = db.prepare("SELECT job, rev FROM jobs ORDER BY created_at, id");
  const insert = db.prepare("INSERT INTO jobs (id, rev, created_at, job) VALUES (?, 1, ?, ?) ON CONFLICT(id) DO NOTHING");
  const cas = db.prepare("UPDATE jobs SET job = ?, rev = rev + 1 WHERE id = ? AND rev = ?");

  const row = (r: { job: string; rev: number }): StoredJob => ({ job: parseJob(JSON.parse(r.job)), rev: Number(r.rev) });
  const run = <T>(what: string, fn: () => T): T => {
    try {
      return fn();
    } catch (cause) {
      if (isBurnerError(cause)) throw cause;
      throw new BurnerError("storage", `burner job database: ${what} failed`, { cause });
    }
  };

  return {
    async get(id) {
      return run("read", () => {
        const r = getOne.get(id) as { job: string; rev: number } | undefined;
        return r ? row(r) : null;
      });
    },
    async list() {
      return run("list", () => (getAll.all() as { job: string; rev: number }[]).map(row));
    },
    async create(job: BurnerJob) {
      return run("create", () => {
        const res = insert.run(job.id, job.createdAt, JSON.stringify(job));
        if (Number(res.changes) !== 1) throw new BurnerError("busy", `job ${job.id} already exists`);
        return { job: structuredClone(job), rev: 1 };
      });
    },
    async update(job: BurnerJob, rev: number) {
      return run("update", () => {
        const res = cas.run(JSON.stringify(job), job.id, rev);
        if (Number(res.changes) !== 1) {
          const exists = getOne.get(job.id);
          throw exists
            ? new BurnerError("busy", `job ${job.id} was changed by another runner`)
            : new BurnerError("not_found", `job ${job.id} does not exist`);
        }
        return { job: structuredClone(job), rev: rev + 1 };
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
