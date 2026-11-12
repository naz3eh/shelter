/**
 * `pnpm demo --dry-run`: replays the recorded mainnet run (G9) with no
 * network, keys or funds, verifying every signature in it offline.
 *
 *   demo --dry-run [--recording PATH]
 *   demo record --job bj_... [--deposit 0x...]... [--out PATH] --account NAME.near
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
import { buildRecording, parseRecording, replay, type DepositRecord } from "./demo/recording.js";
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
    if (!account || !jobIds.length) {
      console.error("usage: demo record --account NAME.near --job bj_... [--job ...] [--deposit 0x...]... [--out PATH]");
      process.exit(1);
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
    writeFileSync(out, `${JSON.stringify(buildRecording(account, deposits, jobs), null, 2)}\n`);
    console.log(`Wrote ${out}: ${deposits.length} deposit(s), ${jobs.length} burner job(s).`);
    console.log("It holds no secret, but it links your NEAR account, the burner and the payee. Commit it only if that is fine for this run.");
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
