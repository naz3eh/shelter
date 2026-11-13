/**
 * `shelter connect ...`: use the confidential balance in any dapp through
 * WalletConnect, without linking the dapp to you.
 *
 *   connect link add 0x.. [--label TEXT]   a public wallet of yours that no dapp may see
 *   connect link add NAME.near             a NEAR account of yours, likewise
 *   connect link list | link remove X
 *   connect start [wc:URI] [--budget 5]    run Shelter as a WalletConnect wallet until Ctrl-C;
 *                                          pairs the URI if given (copy it from the dapp's
 *                                          WalletConnect dialog)
 *   connect start --sandbox [wc:URI]       the same with a throwaway seed and no funding: try
 *                                          the linkage check and signatures on any real dapp
 *                                          without a vault, Meteor, a partner key or money
 *   connect list | show ID
 *   connect fund ID                        finish funding that stopped
 *   connect top-up ID --amount 2 [--gas 0.00002]
 *   connect close ID                       sweep everything back and retire the address
 *
 * Common flags: --account NAME.near (or SHELTER_NEAR_ACCOUNT), --asset usdc|eth
 * (what the dapp address holds; default usdc), --no-open (do not open the
 * Meteor signing page in a browser).
 * Needs ONECLICK_JWT, BASE_RPC_URL (your own Base RPC; it sees the dapp
 * addresses) and, for start, WALLETCONNECT_PROJECT_ID (Reown Cloud).
 * Accounts live in ~/.shelter/connect.db, linked identities in
 * ~/.shelter/linked.json, WalletConnect session keys in ~/.shelter/walletconnect/.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BURNER_ASSETS, createBaseChain, createBurnerEngine, createMemoryJobStore, isBurnerError, type ApprovalRequest, type BurnerAssetKey } from "@shelter/burner";
import { createSqliteJobStore } from "@shelter/burner/sqlite";
import {
  buildIdentity,
  createConnectEngine,
  createMemoryAccountStore,
  isConnectError,
  type ConnectAccount,
  type ConnectApproval,
  type Finding,
  type Identity,
} from "@shelter/connect";
import { createSqliteAccountStore } from "@shelter/connect/sqlite";
import { createConnectBridge, createWalletKit } from "@shelter/connect/walletconnect";
import { createIntentsClient, formatBaseUnits, isIntentsError, isIntentsAccountId, toBaseUnits, type Nep413Signer } from "@shelter/intents";
import { createAddressBook, createMemoryStore, createSeedVault, isKeysError } from "@shelter/keys";
import { createSqliteStore } from "@shelter/keys/sqlite";
import { getAddress, isAddress } from "viem";
import { flag, loadEnv, subArgs } from "./env.js";
import { createMeteorSigner, type MeteorSigner } from "./near/meteor-signer.js";
import { ask, askHidden, confirm, isPairingLink, listenWhileIdle, shelterHome } from "./prompt.js";

loadEnv();

const usage = `shelter connect link add 0x...|NAME.near [--label TEXT]
shelter connect link list
shelter connect link remove 0x...|NAME.near
shelter connect start [wc:URI] [--budget DECIMAL] [--asset usdc|eth] [--account NAME.near] [--no-open]
shelter connect start --sandbox [wc:URI]
shelter connect list
shelter connect show ID
shelter connect fund ID [--account NAME.near]
shelter connect top-up ID [--amount DECIMAL] [--gas ETH] [--account NAME.near]
shelter connect close ID [--account NAME.near]`;

const args = subArgs("connect");
const sub = args[0];
const home = shelterHome();
const account = flag(args, "account") ?? process.env.SHELTER_NEAR_ACCOUNT?.trim();
const rpcUrl = process.env.BASE_RPC_URL?.trim() || "https://mainnet.base.org";
const linkedPath = join(home, "linked.json");

const fail = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};

const fmtEth = (wei: string | bigint) => `${formatBaseUnits(String(wei), 18)} ETH`;
const fmtAsset = (key: BurnerAssetKey, v: string) => `${formatBaseUnits(v, BURNER_ASSETS[key].decimals)} ${BURNER_ASSETS[key].symbol}`;

// ---------- linked identities ----------

interface LinkedFile {
  evm: { address: string; label: string }[];
  near: string[];
}

function readLinked(): LinkedFile {
  if (!existsSync(linkedPath)) return { evm: [], near: [] };
  const raw = JSON.parse(readFileSync(linkedPath, "utf8")) as Partial<LinkedFile>;
  return { evm: Array.isArray(raw.evm) ? raw.evm : [], near: Array.isArray(raw.near) ? raw.near : [] };
}

function writeLinked(l: LinkedFile) {
  if (!existsSync(home)) mkdirSync(home, { recursive: true, mode: 0o700 });
  const tmp = `${linkedPath}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(l, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, linkedPath);
}

/** linked.json plus SHELTER_LINKED_ADDRESSES (comma-separated 0x... and NAME.near). */
function loadIdentity(): Identity {
  const l = readLinked();
  const extra = (process.env.SHELTER_LINKED_ADDRESSES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return buildIdentity({
    evm: [...l.evm.map((e) => [e.address, e.label] as [string, string]), ...extra.filter((x) => isAddress(x)).map((x) => [x, "a linked wallet (SHELTER_LINKED_ADDRESSES)"] as [string, string])],
    near: [...l.near, ...extra.filter((x) => !isAddress(x))],
  });
}

function linkCommand() {
  const op = args[1];
  const target = args[2];
  const l = readLinked();
  if (op === "list") {
    if (!l.evm.length && !l.near.length) console.log("No linked identities. Add the public wallets you never want a dapp to see.");
    for (const e of l.evm) console.log(`  ${e.address}  ${e.label}`);
    for (const n of l.near) console.log(`  ${n}`);
    return;
  }
  if (!target) fail(usage);
  if (op === "add") {
    let shown: string;
    if (isAddress(target!, { strict: false })) {
      const address = getAddress(target!);
      if (l.evm.some((e) => e.address.toLowerCase() === address.toLowerCase())) fail(`${address} is already linked`);
      l.evm.push({ address, label: flag(args, "label") ?? "your linked wallet" });
      shown = address;
    } else {
      const id = target!.toLowerCase();
      // A named account (name.near, name.tg, ...) or a 64-hex implicit one; a bare word is almost always a typo.
      if (!isIntentsAccountId(id) || !(id.includes(".") || /^[0-9a-f]{64}$/.test(id))) fail(`${target} is neither an EVM address nor a NEAR account id like name.near`);
      if (l.near.includes(id)) fail(`${id} is already linked`);
      l.near.push(id);
      shown = id;
    }
    writeLinked(l);
    console.log(`Linked. Connect now blocks any dapp request that names ${shown}.`);
    return;
  }
  if (op === "remove") {
    const k = target!.toLowerCase();
    const next = { evm: l.evm.filter((e) => e.address.toLowerCase() !== k), near: l.near.filter((n) => n !== k) };
    if (next.evm.length === l.evm.length && next.near.length === l.near.length) fail(`${target} is not linked`);
    writeLinked(next);
    console.log(`Removed ${target}.`);
    return;
  }
  fail(usage);
}

// ---------- prompts (one at a time: requests from several dapps can arrive together) ----------

let queue: Promise<unknown> = Promise.resolve();
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

function printFindings(f: Finding[]) {
  for (const w of f) console.log(`  ! ${w.message}`);
}

async function approve(r: ConnectApproval | ApprovalRequest): Promise<boolean> {
  return exclusive(async () => {
    console.log("");
    switch (r.kind) {
      case "open":
        console.log(`Open a Shelter address for ${r.dapp.name ? `${r.dapp.name} (${r.dapp.origin})` : r.dapp.origin}:`);
        console.log(`  the dapp gets a fresh address that only it will ever see`);
        if (r.budget.amount === "0" && r.gasWei === "0") console.log("  sign-in only: nothing is sent to it, so it can sign messages but not pay for transactions");
        else console.log(`  funded with ${fmtAsset(r.budget.asset, r.budget.amount)} plus ${fmtEth(r.gasWei)} for gas, paid in ${BURNER_ASSETS[r.budget.payWith].symbol} from the confidential balance of ${account}`);
        return confirm("Open it?");
      case "dapp_transaction":
        console.log(`${r.dapp.name ?? r.dapp.origin} asks to send a transaction:`);
        console.log(`  ${r.summary}`);
        if (BigInt(r.value) > 0n) console.log(`  sends ${fmtEth(r.value)}`);
        console.log(`  max fee ${fmtEth(r.maxFeeWei)}`);
        if (r.topUpWei) console.log(`  first tops the address up with ${fmtEth(r.topUpWei)} from the confidential balance`);
        printFindings(r.warnings);
        return confirm("Sign and send it?");
      case "dapp_signature":
        console.log(`${r.dapp.name ?? r.dapp.origin} asks for a signature (${r.method}):`);
        console.log(r.method === "personal_sign" ? `  ${r.summary}` : r.text.replace(/^/gm, "  "));
        printFindings(r.warnings);
        return confirm("Sign it?");
      case "top_up":
        console.log(`Top up account ${r.accountId} (${r.reason}):`);
        if (r.amount !== "0") console.log(`  ${fmtAsset(r.asset, r.amount)}`);
        if (r.gasWei !== "0") console.log(`  ${fmtEth(r.gasWei)} for gas`);
        console.log(`  paid in ${BURNER_ASSETS[r.payWith].symbol} from the confidential balance`);
        return confirm("Top up?");
      case "sweep":
        console.log(`Sweep ${r.address} back into the confidential balance, then retire it:`);
        if (!r.items.length) console.log("  nothing left to sweep");
        for (const x of r.items) console.log(`  ${x.amount} ${x.symbol}`);
        for (const u of r.unsupported) console.log(`  ! ${u} cannot be swept by 1Click and stays on the retired address`);
        return confirm("Sweep and retire?");
      case "withdraw": {
        const key = r.asset.key;
        console.log(`Approve a withdrawal from the confidential balance of ${account} (${r.leg}):`);
        console.log(`  address receives  ${fmtAsset(key, r.amountOut)} at ${r.to}`);
        console.log(`  balance pays max  ${fmtAsset(r.payAsset.key, r.maxAmountIn)}${r.withdrawFee ? ` (includes a withdraw fee of ${fmtAsset(key, r.withdrawFee)})` : ""}`);
        for (const t of r.intent.transfers) console.log(`  signed intent     transfer ${t.amount} ${t.tokenId} to ${t.receiverId}`);
        console.log(`  intent valid until ${r.intent.deadline}`);
        return confirm("Approve, then sign it in Meteor?");
      }
      case "transaction":
        // Burner engine transactions: Connect's fund jobs never sign one, but show it plainly if one comes.
        console.log(`Approve a transaction from ${r.from}: ${r.description}, max fee ${fmtEth(r.maxFeeWei)}`);
        return confirm("Sign and send it?");
    }
  });
}

/** Sandbox approvals: dapp prompts as usual, but nothing is ever funded. */
async function sandboxApprove(r: ConnectApproval | ApprovalRequest): Promise<boolean> {
  if (r.kind === "dapp_transaction") {
    return exclusive(async () => {
      console.log("");
      console.log(`${r.dapp.name ?? r.dapp.origin} asks to send a transaction (it passed the linkage check):`);
      console.log(`  ${r.summary}`);
      printFindings(r.warnings);
      console.log("  sandbox: this address holds no funds, so the transaction is declined");
      return false;
    });
  }
  if (r.kind === "withdraw" || r.kind === "top_up" || r.kind === "sweep") return false;
  return approve(r);
}

// ---------- output ----------

function printAccount(a: ConnectAccount, full = false) {
  console.log(`${a.id}  ${a.status}  ${a.dapp.origin}${a.dapp.name ? ` (${a.dapp.name})` : ""}`);
  console.log(`  address ${a.address.address} (index ${a.address.index})  https://basescan.org/address/${a.address.address}`);
  console.log(`  budget  ${fmtAsset(a.budget.asset, a.budget.amount)}, paid in ${BURNER_ASSETS[a.budget.payWith].symbol}; ${a.fundings.length} funding(s), ${a.requests.length} request(s)`);
  if (a.attention) console.log(`  attention: ${a.attention}`);
  if (!full) return;
  for (const q of a.requests) {
    console.log(`  #${q.seq} ${q.at} ${q.method} ${q.decision ?? "open"}: ${q.summary}`);
    for (const f of q.findings) console.log(`      ${f.level} ${f.code}: ${f.message}`);
    if (q.tx) console.log(`      tx https://basescan.org/tx/${q.tx.hash}`);
  }
  for (const x of a.sweep?.items ?? []) console.log(`  sweep ${formatBaseUnits(x.balance, x.decimals)} ${x.symbol}: ${x.outcome ?? x.decision}${x.note ? ` (${x.note})` : ""}`);
  for (const e of a.events) console.log(`    ${e.at}  ${e.message}`);
}

// ---------- main ----------

async function main() {
  if (sub === "link") return linkCommand();
  if (!sub || !["start", "list", "show", "fund", "top-up", "close"].includes(sub)) fail(usage);

  // Sandbox: a throwaway seed and stores in memory; nothing touches ~/.shelter's vault or databases.
  const sandbox = sub === "start" && args.includes("--sandbox");
  const keyStore = sandbox ? createMemoryStore() : createSqliteStore(join(home, "keys.db"));
  const jobs = sandbox ? createMemoryJobStore() : createSqliteJobStore(join(home, "burner.db"));
  const accounts = sandbox ? createMemoryAccountStore() : createSqliteAccountStore(join(home, "connect.db"));
  const vault = createSeedVault({ store: keyStore });
  const book = createAddressBook(vault);
  let signer: MeteorSigner | undefined;
  let stop: (() => void) | undefined;
  const ctl = new AbortController();

  const engineFor = (owner: Nep413Signer) => {
    const intents = createIntentsClient({ jwt: process.env.ONECLICK_JWT, nearRpcUrl: process.env.NEAR_RPC_URL });
    const chain = createBaseChain({ rpcUrl });
    const ask = sandbox ? sandboxApprove : approve;
    const burner = createBurnerEngine({ intents, vault, book, chain, store: jobs, owner, approve: ask, onEvent: (_j, m) => console.log(`  - ${m}`) });
    return createConnectEngine({
      burner,
      vault,
      book,
      chain,
      intents,
      store: accounts,
      owner: owner.accountId,
      linked: loadIdentity,
      approve: ask,
      onEvent: (a, m) => console.log(`  [${a.dapp.origin}] ${m}`),
    });
  };


  /** Runs the WalletConnect wallet until Ctrl-C. */
  async function serve(engine: ReturnType<typeof engineFor>, sandboxed: boolean) {
    const projectId = process.env.WALLETCONNECT_PROJECT_ID?.trim();
    if (!projectId) fail("connect start needs WALLETCONNECT_PROJECT_ID in .env (a free project at https://cloud.reown.com).");
    const assetKey = (flag(args, "asset") ?? "usdc") as BurnerAssetKey;
    if (!BURNER_ASSETS[assetKey]) fail("--asset must be usdc or eth");
    // The sandbox keeps WalletConnect sessions in a fresh directory, so no session outlives its throwaway seed.
    const wcDir = sandboxed ? mkdtempSync(join(tmpdir(), "shelter-wc-sandbox-")) : join(home, "walletconnect");
    if (!existsSync(wcDir)) mkdirSync(wcDir, { recursive: true, mode: 0o700 });
    const kit = await createWalletKit({ projectId: projectId!, storageDir: wcDir });
    const bridge = createConnectBridge({
      kit,
      engine,
      log: (m, e) => console.log(`  ${m}${e ? `: ${e instanceof Error ? e.message : String(e)}` : ""}`),
      decide: (p) =>
        exclusive(async () => {
          console.log("");
          console.log(`${p.dapp.name ?? "A dapp"} at ${p.dapp.origin} wants to connect (domain ${p.verified === "valid" ? "verified" : p.verified === "invalid" ? "DOES NOT MATCH its registration" : "not verified"}).`);
          if (p.existing) {
            console.log(`  it already has address ${p.existing.address.address} (account ${p.existing.id})`);
            return (await confirm("Reconnect it to that address?")) ? { reuse: true as const } : null;
          }
          if (sandboxed) {
            if (!(await confirm("Connect it to a throwaway sandbox address (no funds)?"))) return null;
            return { budget: { asset: "usdc" as const, amount: "0", payWith: "usdc" as const }, gasWei: "0" };
          }
          const preset = flag(args, "budget");
          console.log("  The budget must hold what you will spend there: most dapps check the address can pay before they ask Shelter.");
          const amount = preset ?? (await ask(`Budget for this dapp in ${BURNER_ASSETS[assetKey].symbol}; 0 for sign-in only (empty to refuse): `));
          if (!amount) return null;
          const base = toBaseUnits(amount, BURNER_ASSETS[assetKey].decimals);
          return { budget: { asset: assetKey, amount: base, payWith: "usdc" as const }, ...(base === "0" ? { gasWei: "0" } : {}) };
        }),
    });
    stop = () => bridge.stop();
    const sessions = await bridge.sessions();
    for (const s of sessions) console.log(`Session with ${s.dapp}: ${s.account ? `${s.account.address.address} (${s.account.status})` : "no Shelter account"}`);
    const uri = args.find((x) => x.startsWith("wc:"));
    if (uri) await bridge.pair(uri);
    console.log(`Shelter Connect is running as a WalletConnect wallet${sandboxed ? " in SANDBOX mode (throwaway seed, no funding)" : ""} (rpc ${new URL(rpcUrl).host}).`);
    console.log(uri ? "Approve the connection here when the dapp asks." : "Pair a dapp: in its Connect dialog choose WalletConnect, copy the link, and paste it here.");
    if (sandboxed) console.log("Sandbox addresses hold nothing, so dapps usually stop transactions before asking; signatures and the linkage check work.");
    console.log(sandboxed ? "Ctrl-C stops and forgets the sandbox." : "Ctrl-C stops; open accounts stay open until you run connect close ID.");
    const stopListening = listenWhileIdle("wc link> ", (line) => {
      if (!line) return;
      if (!isPairingLink(line)) {
        console.log("  Paste a WalletConnect link (it starts with wc:), or press Ctrl-C to stop.");
        return;
      }
      console.log("  Pairing...");
      bridge.pair(line).then(
        () => console.log("  Paired; approve the connection here when the dapp asks."),
        (e: unknown) => console.log(`  Could not pair: ${e instanceof Error ? e.message : String(e)}`),
      );
    });
    try {
      await new Promise<void>((resolve) => ctl.signal.addEventListener("abort", () => resolve(), { once: true }));
    } finally {
      stopListening();
    }
  }

  /** --sandbox: a throwaway seed, no vault, no Meteor, no partner key; dapp transactions are declined because nothing is funded. */
  async function startSandbox() {
    await vault.create(crypto.randomUUID(), { words: 24 });
    const owner: Nep413Signer = { accountId: account ?? "sandbox.near", sign: () => Promise.reject(new Error("sandbox: no NEAR wallet")) };
    if (!loadIdentity().evm.size) console.log("! No linked wallets yet: add one (connect link add 0x...) to see the linkage check block it.");
    process.once("SIGINT", () => {
      ctl.abort(new Error("interrupted"));
      stop?.();
    });
    await serve(engineFor(owner), true);
  }

  try {
    if (sandbox) return await startSandbox();
    // list and show only read the saved accounts: no owner, wallet or network needed.
    if (sub === "list") {
      const all = (await accounts.list()).map((s) => s.account);
      if (!all.length) console.log("No Connect accounts.");
      for (const a of all) printAccount(a);
      return;
    }
    if (sub === "show") {
      const a = (await accounts.get(args[1] ?? ""))?.account;
      if (!a) fail(`No account ${args[1]}`);
      printAccount(a!, true);
      return;
    }
    if (!account) fail(`--account (or SHELTER_NEAR_ACCOUNT) is required\n\n${usage}`);

    if (!process.env.ONECLICK_JWT?.trim()) fail("Connect needs ONECLICK_JWT in .env (confidential withdrawals and deposits).");
    if (!(await vault.exists())) fail("No vault yet. Create one with: shelter vault create");
    const identity = loadIdentity();
    if (!identity.evm.size) {
      console.log("! No linked wallets. Add the public wallets no dapp may see: shelter connect link add 0x... --label 'main wallet'");
    }
    await vault.unlock(await askHidden("Vault passphrase: "));
    signer = await createMeteorSigner({ accountId: account!, openBrowser: !args.includes("--no-open") });
    const engine = engineFor(signer);
    process.once("SIGINT", () => {
      console.error("\nStopping. Everything is saved; run the same command again to resume.");
      ctl.abort(new Error("interrupted"));
      stop?.();
    });

    if (sub === "fund" || sub === "close" || sub === "top-up") {
      const id = args[1];
      if (!id || id.startsWith("--")) fail(usage);
      let a: ConnectAccount;
      if (sub === "fund") a = await engine.fund(id!, { signal: ctl.signal });
      else if (sub === "close") a = await engine.close(id!, { signal: ctl.signal });
      else {
        const cur = await engine.get(id!);
        if (!cur) fail(`No account ${id}`);
        const amount = flag(args, "amount");
        const gas = flag(args, "gas");
        if (!amount && !gas) fail("top-up needs --amount and/or --gas");
        a = await engine.topUp(
          id!,
          {
            asset: cur!.budget.asset,
            amount: amount ? toBaseUnits(amount, BURNER_ASSETS[cur!.budget.asset].decimals) : "0",
            gasWei: gas ? toBaseUnits(gas, 18) : "0",
          },
          { signal: ctl.signal },
        );
      }
      printAccount(a, sub === "close");
      return;
    }

    await serve(engine, false);
  } finally {
    vault.lock();
    await signer?.close();
    accounts.close?.();
    jobs.close?.();
    keyStore.close?.();
  }
}

main()
  .then(() => {
    // WalletKit keeps its relay socket open; leave once the command is done.
    if (sub === "start") process.exit(0);
  })
  .catch((e) => {
    if (isConnectError(e)) fail(`${e.kind}: ${e.message}`);
    if (isBurnerError(e)) fail(`${e.kind}: ${e.message}`);
    if (isIntentsError(e)) fail(`${e.kind}: ${e.message}${e.correlationId ? ` (correlation ${e.correlationId})` : ""}`);
    if (isKeysError(e)) fail(`${e.kind}: ${e.message}`);
    fail(e instanceof Error ? e.message : String(e));
  });
