/**
 * `shelter burner ...`: one public action from a one-time address (G6).
 *
 *   burner preview --to 0x.. --amount 0.25     dry quotes and gas estimate; nothing allocated or sent
 *   burner new     --to 0x.. --amount 0.25     stores a job; nothing sent
 *   burner run     JOB                         runs or resumes it: Meteor signs each withdrawal,
 *                                              you approve every spend in this terminal
 *   burner list | show JOB | cancel JOB
 *
 * Common flags: --account NAME.near (or SHELTER_NEAR_ACCOUNT), --to 0x.. (or
 * SHELTER_DEMO_PAYEE), --asset usdc.
 * Needs ONECLICK_JWT and, for anything that reads the chain, BASE_RPC_URL
 * (your own Base RPC; the public one is used if unset, and sees the burner).
 * Jobs live in ~/.shelter/burner.db, keys in ~/.shelter/keys.db.
 */

import { join } from "node:path";
import {
  BURNER_ASSETS,
  createBaseChain,
  createBurnerEngine,
  isBurnerError,
  type ApprovalRequest,
  type BurnerAction,
  type BurnerJob,
} from "@shelter/burner";
import { createSqliteJobStore } from "@shelter/burner/sqlite";
import { createIntentsClient, formatBaseUnits, isIntentsError, toBaseUnits, type Nep413Signer } from "@shelter/intents";
import { createAddressBook, createSeedVault, isKeysError } from "@shelter/keys";
import { createSqliteStore } from "@shelter/keys/sqlite";
import { flag, loadEnv, subArgs } from "./env.js";
import { createMeteorSigner, type MeteorSigner } from "./near/meteor-signer.js";
import { askHidden, confirm, shelterHome } from "./prompt.js";

loadEnv();

const usage = `shelter burner preview --to 0x... --amount DECIMAL [--asset usdc] [--account NAME.near]
shelter burner preview --payout --amount DECIMAL
shelter burner new     --to 0x... --amount DECIMAL [--in 3h | --after ISO-TIME] [--asset usdc] [--account NAME.near]
shelter burner payout  --amount DECIMAL [--in 3h | --after ISO-TIME] [--account NAME.near]
                       private-move payout: a fresh address funded with USDC plus gas, kept for later
shelter burner run     JOB [--account NAME.near] [--no-open]
shelter burner list
shelter burner show    JOB
shelter burner cancel  JOB`;

const args = subArgs("burner");
const sub = args[0];
const account = flag(args, "account") ?? process.env.SHELTER_NEAR_ACCOUNT;
const home = shelterHome();
const rpcUrl = process.env.BASE_RPC_URL?.trim() || "https://mainnet.base.org";

const fail = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};

const fmtEth = (wei: string | bigint) => `${formatBaseUnits(String(wei), 18)} ETH`;
const fmtAsset = (key: keyof typeof BURNER_ASSETS, v: string) => `${formatBaseUnits(v, BURNER_ASSETS[key].decimals)} ${BURNER_ASSETS[key].symbol}`;

function printJob(j: BurnerJob, events = false) {
  console.log(`${j.id}  ${j.status}  step ${j.step}  ${j.createdAt}`);
  const a = j.action;
  console.log(
    a.kind === "hold"
      ? `  action  payout: fund a fresh address with ${fmtAsset(a.asset, a.amount)} plus gas, and keep it`
      : `  action  send ${fmtAsset(a.asset, a.amount)} to ${a.to}`,
  );
  if (j.notBefore) console.log(`  starts  not before ${j.notBefore}`);
  console.log(`  owner   ${j.owner}`);
  if (j.burner) console.log(`  ${a.kind === "hold" ? "address" : "burner "} ${j.burner.address} (index ${j.burner.index})`);
  if (j.act?.tx) console.log(`  tx      ${j.act.tx.hash}${j.act.outcome ? ` (${j.act.outcome})` : ""}  https://basescan.org/tx/${j.act.tx.hash}`);
  if (j.attention) console.log(`  attention: ${j.attention}`);
  if (events) for (const e of j.events) console.log(`    ${e.at}  [${e.step}] ${e.message}`);
}

async function approve(r: ApprovalRequest): Promise<boolean> {
  console.log("");
  if (r.kind === "withdraw") {
    const key = r.asset.key;
    console.log(`Approve a withdrawal from the confidential balance of ${account} (${r.leg}):`);
    console.log(`  burner receives   ${fmtAsset(key, r.amountOut)} at ${r.to}`);
    console.log(`  balance pays max  ${fmtAsset(r.payAsset.key, r.maxAmountIn)}${r.withdrawFee ? ` (includes a withdraw fee of ${fmtAsset(key, r.withdrawFee)})` : ""}`);
    for (const t of r.intent.transfers) console.log(`  signed intent     transfer ${t.amount} ${t.tokenId} to ${t.receiverId}`);
    console.log(`  intent valid until ${r.intent.deadline}`);
    return confirm("Approve, then sign it in Meteor?");
  }
  console.log(`Approve a transaction from burner ${r.from} (${r.purpose}):`);
  console.log(`  ${r.description}`);
  console.log(`  contract ${r.to}, max fee ${fmtEth(r.maxFeeWei)}`);
  return confirm("Sign and send it?");
}

async function main() {
  if (!sub || !["preview", "new", "payout", "run", "list", "show", "cancel"].includes(sub)) fail(usage);
  const keyStore = createSqliteStore(join(home, "keys.db"));
  const jobs = createSqliteJobStore(join(home, "burner.db"));
  const vault = createSeedVault({ store: keyStore });
  const book = createAddressBook(vault);
  let signer: MeteorSigner | undefined;
  const ctl = new AbortController();
  process.once("SIGINT", () => {
    console.error("\nStopping after the current step is saved. Run the job again to resume.");
    ctl.abort(new Error("interrupted"));
  });

  try {
    const needsOwner = sub === "preview" || sub === "new" || sub === "payout" || sub === "run" || sub === "cancel";
    if (needsOwner && !account) fail(`--account is required\n\n${usage}`);
    const owner: Nep413Signer = { accountId: account ?? "", sign: () => Promise.reject(new Error("no wallet in this command")) };
    const engineFor = (o: Nep413Signer) =>
      createBurnerEngine({
        intents: createIntentsClient({ jwt: process.env.ONECLICK_JWT, nearRpcUrl: process.env.NEAR_RPC_URL }),
        vault,
        book,
        chain: createBaseChain({ rpcUrl }),
        store: jobs,
        owner: o,
        approve,
        onEvent: (_j, m) => console.log(`  - ${m}`),
      });

    if (sub === "list") {
      const all = await engineFor(owner).list();
      if (!all.length) console.log("No burner jobs.");
      for (const j of all) printJob(j);
      return;
    }
    if (sub === "show" || sub === "cancel" || sub === "run") {
      const id = args[1];
      if (!id || id.startsWith("--")) fail(usage);
      if (sub === "show") {
        const j = await engineFor(owner).get(id!);
        if (!j) fail(`No job ${id}`);
        printJob(j!, true);
        return;
      }
      if (sub === "cancel") {
        printJob(await engineFor(owner).cancel(id!));
        return;
      }
      if (!process.env.ONECLICK_JWT?.trim()) fail("Running a burner job needs ONECLICK_JWT in .env.");
      if (!(await vault.exists())) fail("No vault yet. Create one with: shelter vault create");
      await vault.unlock(await askHidden("Vault passphrase: "));
      signer = await createMeteorSigner({ accountId: account!, openBrowser: !args.includes("--no-open") });
      console.log(`Running ${id} (rpc ${new URL(rpcUrl).host}). Ctrl-C stops safely; run again to resume.`);
      const j = await engineFor(signer).run(id!, { signal: ctl.signal });
      printJob(j);
      return;
    }

    const assetKey = (flag(args, "asset") ?? "usdc") as keyof typeof BURNER_ASSETS;
    if (assetKey !== "usdc") fail("--asset must be usdc");
    const amount = flag(args, "amount");
    if (!amount) fail(usage);
    const base = toBaseUnits(amount!, BURNER_ASSETS.usdc.decimals);
    const payout = sub === "payout" || (sub === "preview" && args.includes("--payout"));
    const to = flag(args, "to") ?? process.env.SHELTER_DEMO_PAYEE?.trim();
    if (!payout && !to) fail(`--to (or SHELTER_DEMO_PAYEE) is required\n\n${usage}`);
    const action: BurnerAction = payout
      ? { kind: "hold", asset: "usdc", amount: base }
      : { kind: "erc20_transfer", asset: "usdc", to: to as `0x${string}`, amount: base };
    const notBefore = startTime(flag(args, "in"), flag(args, "after"));

    if (sub === "preview") {
      if (!process.env.ONECLICK_JWT?.trim()) fail("A confidential quote needs ONECLICK_JWT in .env.");
      const p = await engineFor(owner).preview(action, { signal: ctl.signal });
      console.log(
        action.kind === "hold"
          ? `Preview: a fresh payout address receives ${fmtAsset("usdc", action.amount)} plus gas`
          : `Preview: send ${fmtAsset("usdc", action.amount)} to ${action.to} from a new burner`,
      );
      const who = action.kind === "hold" ? "address" : "burner";
      const label = (l: string) => `  ${l.padEnd(22)}`;
      console.log(`${label(`gas for the ${who}`)}${fmtEth(p.gasWei)} (balance pays max ${fmtAsset("usdc", p.gasQuote.amountIn)})`);
      console.log(`${label(`asset for the ${who}`)}${fmtAsset("usdc", p.assetQuote.amountOut)} (balance pays max ${fmtAsset("usdc", p.assetQuote.amountIn)}, fee ${fmtAsset("usdc", p.assetQuote.withdrawFee ?? "0")})`);
      console.log(`${label("total from balance")}max ${fmtAsset("usdc", p.maxSpend[BURNER_ASSETS.usdc.assetId] ?? "0")}`);
      console.log(`${label("quotes")}${p.gasQuote.confidentiality}/${p.assetQuote.confidentiality}, signatures ${p.gasQuote.provenance.signatureVerified && p.assetQuote.provenance.signatureVerified ? "verified" : "NOT verified"}`);
      return;
    }
    const j = await engineFor(owner).create(action, notBefore ? { notBefore } : {});
    if (notBefore) console.log(`Scheduled: it will not start before ${j.notBefore}.`);
    console.log(`Created ${j.id}. Nothing has been sent. Run it with:\n  pnpm --filter @shelter/cli burner run ${j.id} --account ${account}`);
  } finally {
    vault.lock();
    await signer?.close();
    jobs.close?.();
    keyStore.close?.();
  }
}

/** `--in 90m|3h|2d` or `--after <ISO time>` into an ISO start time. */
function startTime(within: string | undefined, after: string | undefined): string | undefined {
  if (within && after) fail("use --in or --after, not both");
  if (after) {
    const t = Date.parse(after);
    if (Number.isNaN(t)) fail(`--after ${after} is not a date`);
    return new Date(t).toISOString();
  }
  if (!within) return undefined;
  const m = /^(\d+)(m|h|d)$/.exec(within);
  if (!m) fail("--in takes a number and m, h or d, for example 90m or 3h");
  const ms = Number(m![1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m![2] as "m" | "h" | "d"];
  return new Date(Date.now() + ms).toISOString();
}

main().catch((e) => {
  if (isBurnerError(e)) fail(`${e.kind}: ${e.message}`);
  if (isIntentsError(e)) fail(`${e.kind}: ${e.message}${e.correlationId ? ` (correlation ${e.correlationId})` : ""}`);
  if (isKeysError(e)) fail(`${e.kind}: ${e.message}`);
  fail(e instanceof Error ? e.message : String(e));
});
