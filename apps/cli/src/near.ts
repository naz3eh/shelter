/**
 * `shelter near ...`: the confidential balance owner's NEAR account.
 *
 *   near keys    --account A                read-only: keys registered on intents.near
 *   near login   --account A                Meteor signs a NEP-413 sign-in; shows balances
 *   near quote   --account A --leg deposit|withdraw --asset usdc|eth --amount 0.25 [--to 0x..]
 *                                           sign-in, then a dry confidential quote. The quote
 *                                           authenticates the integration: it needs ONECLICK_JWT
 *                                           (partner key), not the user session.
 *
 *   near deposit --account A --asset usdc --amount 0.2 [--tx 0x..]
 *                                           real deposit quote into A's confidential balance:
 *                                           prints the Base deposit address, then waits for it.
 *                                           You send the funds yourself from your wallet.
 *   near watch   --deposit-address 0x.. [--tx 0x..]   keep waiting on an earlier deposit
 *
 * Nothing here signs a transaction or moves funds by itself. Tokens stay in
 * memory and end with the process.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createIntentsClient,
  formatBaseUnits,
  isIntentsError,
  privateDepositRequest,
  privateWithdrawRequest,
  toBaseUnits,
  type Quote,
} from "@shelter/intents";
import { flag, loadEnv, subArgs } from "./env.js";
import { createMeteorSigner } from "./near/meteor-signer.js";
import { shelterHome } from "./prompt.js";
import type { DepositRecord } from "./demo/recording.js";

loadEnv();

export const ASSETS = {
  usdc: { assetId: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", decimals: 6, symbol: "USDC (Base)" },
  eth: { assetId: "nep141:base.omft.near", decimals: 18, symbol: "ETH (Base)" },
} as const;

const usage = `shelter near keys  --account NAME.near
shelter near login --account NAME.near [--no-open]
shelter near quote --account NAME.near --leg deposit|withdraw --asset usdc|eth --amount DECIMAL [--to 0x...] [--no-open]
shelter near deposit --account NAME.near --asset usdc --amount DECIMAL [--tx 0x...]
shelter near watch --deposit-address 0x... [--tx 0x...]`;

const args = subArgs("near");
const sub = args[0];
const account = flag(args, "account") ?? process.env.SHELTER_NEAR_ACCOUNT;
const openBrowser = !args.includes("--no-open");

const client = createIntentsClient({ jwt: process.env.ONECLICK_JWT, nearRpcUrl: process.env.NEAR_RPC_URL });

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function printQuote(q: Quote, decimals: number, symbol: string) {
  const fmt = (v: string | undefined) => (v === undefined ? "-" : `${formatBaseUnits(v, decimals)} ${symbol}`);
  console.log(
    [
      `  confidentiality   ${q.confidentiality}`,
      `  amount in         ${fmt(q.amountIn)}  (~$${q.amountInUsd})`,
      `  amount out        ${fmt(q.amountOut)}  (~$${q.amountOutUsd}), min ${fmt(q.minAmountOut)}`,
      `  withdraw fee      ${fmt(q.withdrawFee)}`,
      `  refund fee        ${fmt(q.refundFee)}`,
      `  time estimate     ${q.timeEstimateSec} s`,
      `  signature         ${q.provenance.signatureVerified ? "verified" : "NOT verified"} (${q.provenance.signerPublicKey})`,
      `  correlation id    ${q.quoteId}`,
    ].join("\n"),
  );
}

async function main() {
  if (!sub || !["keys", "login", "quote", "deposit", "watch"].includes(sub)) fail(usage);
  if (sub === "watch") return watch(flag(args, "deposit-address") ?? fail(usage), undefined);
  if (!account) fail(`--account is required\n\n${usage}`);

  if (sub === "deposit") {
    if (!process.env.ONECLICK_JWT?.trim()) fail("A confidential deposit quote needs ONECLICK_JWT in .env.");
    const assetKey = flag(args, "asset") as keyof typeof ASSETS | undefined;
    const amount = flag(args, "amount");
    if (!assetKey || !(assetKey in ASSETS)) fail(`--asset must be usdc or eth\n\n${usage}`);
    if (!amount) fail(`--amount is required\n\n${usage}`);
    const a = ASSETS[assetKey];
    const q = await client.getQuote(
      privateDepositRequest({ asset: { assetId: a.assetId, amount: toBaseUnits(amount, a.decimals) }, owner: account, dry: false }),
    );
    if (!q.depositAddress || !q.provenance.signatureVerified) fail("1Click returned no verified deposit address; nothing to send.");
    console.log(`Deposit into the confidential balance of ${account}:`);
    printQuote(q, a.decimals, a.symbol);
    console.log(
      [
        "",
        `  SEND EXACTLY     ${formatBaseUnits(q.amountIn, a.decimals)} ${a.symbol} on Base`,
        `  TO               ${q.depositAddress}`,
        `  BEFORE           ${q.deadline} (later deposits are refunded to the balance)`,
        "",
        "Send it from your wallet now. This command waits for 1Click; Ctrl-C is safe, resume with:",
        `  pnpm --filter @shelter/cli near watch --deposit-address ${q.depositAddress}`,
      ].join("\n"),
    );
    return watch(q.depositAddress, q);
  }

  if (sub === "keys") {
    const keys = await client.near.publicKeysOf(account);
    console.log(keys.length ? `Keys registered for ${account} on intents.near:\n${keys.map((k) => `  ${k}`).join("\n")}` : `No keys registered for ${account} on intents.near.`);
    return;
  }

  // Check before asking Meteor, so nobody signs for a run that cannot finish.
  if (sub === "quote" && !process.env.ONECLICK_JWT?.trim()) {
    fail("A confidential quote needs a 1Click partner key: set ONECLICK_JWT in .env (from the Partner Dashboard).");
  }

  const signer = await createMeteorSigner({ accountId: account, openBrowser });
  try {
    const session = await client.signIn(signer);
    console.log(`Signed in as ${session.accountId} with ${session.publicKey}`);
    console.log(`  access token expires ${session.expiresAt().toISOString()}, session ends ${session.refreshExpiresAt().toISOString()}`);

    const balances = await client.balances(session);
    console.log(balances.length ? "Confidential balances:" : "Confidential balances: none");
    for (const b of balances) {
      const known = Object.values(ASSETS).find((a) => a.assetId === b.tokenId);
      console.log(`  ${known ? `${formatBaseUnits(b.available, known.decimals)} ${known.symbol}` : `${b.available} ${b.tokenId}`}  [${b.source}]`);
    }

    if (sub === "quote") {
      const leg = flag(args, "leg");
      const assetKey = flag(args, "asset") as keyof typeof ASSETS | undefined;
      const amount = flag(args, "amount");
      if (leg !== "deposit" && leg !== "withdraw") fail(`--leg must be deposit or withdraw\n\n${usage}`);
      if (!assetKey || !(assetKey in ASSETS)) fail(`--asset must be usdc or eth\n\n${usage}`);
      if (!amount) fail(`--amount is required\n\n${usage}`);
      const a = ASSETS[assetKey];
      const asset = { assetId: a.assetId, amount: toBaseUnits(amount, a.decimals) };
      // A dry withdrawal needs a destination; by default a random address nobody controls.
      const to = flag(args, "to") ?? `0x${randomBytes(20).toString("hex")}`;
      const req =
        leg === "deposit"
          ? privateDepositRequest({ asset, owner: account, dry: true })
          : privateWithdrawRequest({ asset, owner: account, destination: to, dry: true });
      const q = await client.getQuote(req);
      console.log(`Dry ${leg} quote (${a.symbol}${leg === "withdraw" ? ` to ${to}` : ""}):`);
      printQuote(q, a.decimals, a.symbol);
    }
    session.end();
  } finally {
    await signer.close();
  }
}

/** Where `near deposit` keeps what it saw, for the demo recording (G9). Public data only. */
const depositFile = (depositAddress: string) => join(shelterHome(), "deposits", `${depositAddress.toLowerCase()}.json`);

function loadDeposit(depositAddress: string): DepositRecord | undefined {
  const f = depositFile(depositAddress);
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as DepositRecord) : undefined;
}

function saveDeposit(rec: DepositRecord) {
  const f = depositFile(rec.quote.depositAddress!);
  mkdirSync(join(shelterHome(), "deposits"), { recursive: true, mode: 0o700 });
  writeFileSync(f, JSON.stringify(rec, null, 2), { mode: 0o600 });
}

/** Polls a deposit until it settles; submits the tx hash first when --tx is given. */
async function watch(depositAddress: string, fresh: Quote | undefined) {
  const rec: DepositRecord | undefined = fresh ? { quote: fresh, statuses: [] } : loadDeposit(depositAddress);
  if (rec) saveDeposit(rec);
  const tx = flag(args, "tx");
  if (tx && rec) {
    await client.submitDeposit(rec.quote, tx);
    rec.txHash = tx;
    saveDeposit(rec);
    console.log(`Told 1Click about ${tx}.`);
  } else if (tx) {
    console.log("No saved quote for this deposit address, so --tx is not sent; 1Click also watches the chain.");
  }
  let last = "";
  const st = await client.waitForStatus(depositAddress, {
    timeoutMs: 60 * 60_000,
    onUpdate: (s) => {
      const line = `${s.status}${s.depositedAmount ? `  deposited ${s.depositedAmount}` : ""}`;
      if (line === last) return;
      console.log(`  ${new Date().toISOString()}  ${(last = line)}`);
      if (rec) {
        rec.statuses.push({ at: new Date().toISOString(), status: s });
        saveDeposit(rec);
      }
    },
  });
  console.log(`Final status ${st.status}${st.refundReason ? ` (${st.refundReason})` : ""}`);
  for (const t of [...st.originChainTxs, ...st.destinationChainTxs]) console.log(`  ${t.explorerUrl || t.hash}`);
  if (st.status === "SUCCESS") console.log("Check the balance with: pnpm --filter @shelter/cli near login --account <you>.near");
  if (st.status !== "SUCCESS") process.exitCode = 1;
}

main().catch((e) => {
  if (isIntentsError(e)) fail(`${e.kind}: ${e.message}${e.correlationId ? ` (correlation ${e.correlationId})` : ""}`);
  fail(e instanceof Error ? e.message : String(e));
});
