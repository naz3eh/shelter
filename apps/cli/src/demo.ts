/**
 * `pnpm demo --dry-run`: replays the recorded mainnet run (G9) with no
 * network, keys or funds, verifying every signature in it offline.
 *
 *   demo --dry-run [--recording PATH]
 *   demo record --account NAME.near [--job bj_...]... [--connect ca_...]... [--deposit 0x...]... [--out PATH]
 *
 * `--connect` adds a Shelter Connect session with its funding jobs, and from
 * ~/.shelter/linked.json only the identities its blocked requests named.
 *
 * `record` assembles a recording from the local job database
 * (~/.shelter/burner.db) and the deposits `near deposit` saved
 * (~/.shelter/deposits). It holds no secret, but it links the owner's NEAR
 * account to the burner and the payee: publishing it gives up the privacy
 * of that run.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSqliteJobStore } from "@shelter/burner/sqlite";
import { createSqliteAccountStore } from "@shelter/connect/sqlite";
import { buildRecording, namedByBlocks, parseRecording, replay, type ConnectRecording, type DepositRecord } from "./demo/recording.js";
import { flag, loadEnv } from "./env.js";
import { shelterHome } from "./prompt.js";

loadEnv();

const DEFAULT_RECORDING = fileURLToPath(new URL("../../../scripts/demo/recording.json", import.meta.url));
const args = process.argv.slice(2).filter((a) => a !== "demo" && a !== "--");

const all = (name: string) => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [args[i + 1]!] : []));

async function main() {
  if (args[0] === "record") {
    const account = flag(args, "account") ?? process.env.SHELTER_NEAR_ACCOUNT;
    const jobIds = all("job");
    const connectIds = all("connect");
    if (!account || (!jobIds.length && !connectIds.length)) {
      console.error("usage: demo record --account NAME.near [--job bj_...]... [--connect ca_...]... [--deposit 0x...]... [--out PATH]");
      process.exit(1);
    }
    const connect: ConnectRecording[] = [];
    if (connectIds.length) {
      const accounts = createSqliteAccountStore(join(shelterHome(), "connect.db"));
      const linkedFile = join(shelterHome(), "linked.json");
      const raw = existsSync(linkedFile) ? (JSON.parse(readFileSync(linkedFile, "utf8")) as { evm?: { address: string; label: string }[]; near?: string[] }) : {};
      const linked = [...(raw.evm ?? []).map((e) => ({ id: e.address, label: e.label })), ...(raw.near ?? []).map((n) => ({ id: n, label: "a linked NEAR account" }))];
      for (const id of connectIds) {
        const s = await accounts.get(id);
        if (!s) throw new Error(`no Connect account ${id} in ${shelterHome()}`);
        if (s.account.owner !== account) throw new Error(`Connect account ${id} belongs to ${s.account.owner}`);
        connect.push({ account: s.account, linked: namedByBlocks(s.account, linked) });
        for (const f of s.account.fundings) if (!jobIds.includes(f.jobId)) jobIds.push(f.jobId);
      }
      accounts.close?.();
    }
    const store = createSqliteJobStore(join(shelterHome(), "burner.db"));
    const jobs = [];
    for (const id of jobIds) {
      const s = await store.get(id);
      if (!s) throw new Error(`no burner job ${id} in ${shelterHome()}`);
      if (s.job.owner !== account) throw new Error(`job ${id} belongs to ${s.job.owner}`);
      jobs.push(s.job);
    }
    store.close?.();
    const deposits: DepositRecord[] = all("deposit").map((addr) => {
      const f = join(shelterHome(), "deposits", `${addr.toLowerCase()}.json`);
      if (!existsSync(f)) throw new Error(`no saved deposit ${addr} (only deposits made with 'near deposit' are saved)`);
      return JSON.parse(readFileSync(f, "utf8")) as DepositRecord;
    });
    const out = flag(args, "out") ?? DEFAULT_RECORDING;
    writeFileSync(out, `${JSON.stringify(buildRecording(account, deposits, jobs, new Date(), connect), null, 2)}\n`);
    console.log(`Wrote ${out}: ${deposits.length} deposit(s), ${jobs.length} burner job(s), ${connect.length} Connect session(s).`);
    console.log("It holds no secret, but it links your NEAR account to every address in it (burners, payees, dapp addresses, and any linked wallet a block named).");
    console.log("Commit it only if that is fine for this run.");
    return;
  }

  if (args.includes("--dry-run")) {
    const path = flag(args, "recording") ?? DEFAULT_RECORDING;
    if (!existsSync(path)) {
      console.log(`No recording at ${path} yet. It is made after the approved mainnet run with: pnpm --filter @shelter/cli demo record ...`);
      return;
    }
    const failed = await replay(parseRecording(JSON.parse(readFileSync(path, "utf8"))));
    if (failed) process.exitCode = 1;
    return;
  }

  console.log("Shelter demo. Try: pnpm demo --dry-run (replays the recorded mainnet run offline).");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
