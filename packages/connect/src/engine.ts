/**
 * Shelter Connect engine: the confidential balance, usable in any dapp
 * without linking the dapp to the user.
 *
 * Each dapp origin gets its own address derived from the local seed (never
 * Chain Signatures, whose addresses derive publicly from the NEAR account).
 * The address is funded from the confidential balance through 1Click, so on
 * chain its funder is the public Intents treasury. Every request the dapp
 * sends passes the linkage check (./linkage.ts) and the user's approval
 * before anything is signed. Closing the account sweeps every token 1Click
 * can take back into the confidential balance and retires the address.
 *
 *   open    allocate the dapp address; queue funding of the budget plus gas
 *   fund    run the queued funding (burner engine "fund" jobs; crash-safe)
 *   handle  one dapp request: check, approve, top up just in time, sign, send
 *   close   finish funding, settle sent transactions, sweep, retire
 *
 * Requests on one account run one at a time (an in-process queue plus
 * compare-and-swap on every save), so a top-up never races a transaction
 * on the same address and nonces stay in order.
 */

import { ETH_BASE, type BurnerAssetKey, type BurnerEngine, type ChainClient, type SignedTx, type TxRequest } from "@shelter/burner";
import { BURNER_ASSETS, isBurnerError } from "@shelter/burner";
import { assertFundable, formatBaseUnits, isIntentsError, privateDepositRequest, type IntentsClient, type TokenInfo } from "@shelter/intents";
import type { AddressBook, SeedVault } from "@shelter/keys";
import { encodeFunctionData, erc20Abi, getAddress, isAddress, isHex, keccak256, type Hex } from "viem";
import {
  ACCOUNT_FORMAT_VERSION,
  originOf,
  type AccountStore,
  type Budget,
  type ConnectAccount,
  type DappInfo,
  type Funding,
  type RequestRecord,
  type SweepItem,
} from "./account.js";
import { ConnectError, isConnectError } from "./errors.js";
import { blocks, inspect, type Finding, type Identity } from "./linkage.js";
import { BASE_CHAIN_ID, describeRequest, parseRequest, type DappRequest } from "./requests.js";

export interface ConnectOptions {
  /** Gas a typical dapp transaction is priced at before it can be estimated. Default 300k. */
  gasPerTx: bigint;
  /** Transactions the opening gas covers. Default 5. */
  initialTxs: number;
  /** Gas top-ups are this multiple of the shortfall. Default 2. */
  gasHeadroom: bigint;
  /** Gas amounts round up to a multiple of this (wei). Default 1e12. */
  gasRoundWei: bigint;
  slippageBps: number;
  receiptTimeoutMs: number;
  receiptIntervalMs: number;
  statusTimeoutMs: number;
  statusIntervalMs: number;
  /** Concurrent balance reads while planning a sweep. Default 4. */
  balanceReadConcurrency: number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const DEFAULTS: ConnectOptions = {
  gasPerTx: 300_000n,
  initialTxs: 5,
  gasHeadroom: 2n,
  gasRoundWei: 10n ** 12n,
  slippageBps: 50,
  receiptTimeoutMs: 3 * 60_000,
  receiptIntervalMs: 2_000,
  statusTimeoutMs: 15 * 60_000,
  statusIntervalMs: 5_000,
  balanceReadConcurrency: 4,
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          reject(signal.reason);
        },
        { once: true },
      );
    }),
};

/** Where a request came from, as the transport (WalletConnect) reports it. */
export interface RequestSource {
  origin: string;
  /** WalletConnect Verify: whether the origin matches the domain the dapp registered. */
  verified?: "valid" | "invalid" | "unknown";
  /** WalletConnect Verify flagged the domain as a known scam. */
  scam?: boolean;
}

export type ConnectApproval =
  | { kind: "open"; dapp: DappInfo; budget: Budget; gasWei: string }
  | {
      kind: "dapp_transaction";
      accountId: string;
      dapp: DappInfo;
      summary: string;
      to: `0x${string}`;
      /** Wei the transaction sends. */
      value: string;
      /** Upper bound on the fee, wei. */
      maxFeeWei: string;
      /** Wei of ETH the confidential balance must first send to the address for this, if any. */
      topUpWei?: string;
      warnings: Finding[];
    }
  | { kind: "dapp_signature"; accountId: string; dapp: DappInfo; method: string; summary: string; text: string; warnings: Finding[] }
  | { kind: "top_up"; accountId: string; reason: Funding["reason"]; asset: BurnerAssetKey; amount: string; gasWei: string; payWith: BurnerAssetKey }
  | {
      kind: "sweep";
      accountId: string;
      address: `0x${string}`;
      items: { symbol: string; amount: string; decision: SweepItem["decision"] }[];
      unsupported: string[];
    };

export interface ConnectDeps {
  /** Burner engine that runs the "fund" jobs; its own `approve` covers each withdrawal intent. */
  burner: BurnerEngine;
  vault: SeedVault;
  book: AddressBook;
  chain: ChainClient;
  intents: IntentsClient;
  store: AccountStore;
  /** NEAR account that owns the confidential balance. */
  owner: string;
  /** The user's own identities to keep apart from every dapp (public wallets, NEAR accounts). */
  linked(): Identity | Promise<Identity>;
  approve(req: ConnectApproval): boolean | Promise<boolean>;
  onEvent?(account: ConnectAccount, message: string): void;
  now?: () => Date;
  random?: (n: number) => Uint8Array;
  options?: Partial<ConnectOptions>;
}

export interface OpenInput {
  dapp: DappInfo;
  /** Amount "0" with `gasWei` "0" opens a sign-in-only account that holds nothing until a transaction needs it. */
  budget: Budget;
  /** Opening gas, wei. Default: `initialTxs` transactions of `gasPerTx` at current fees, with headroom. */
  gasWei?: string;
}

export interface ConnectEngine {
  /** Allocates the dapp's address and queues its funding. Sends nothing; run `fund` next. */
  open(input: OpenInput): Promise<ConnectAccount>;
  /** Runs queued funding to the end. Safe to call again after any stop. */
  fund(accountId: string, opts?: { signal?: AbortSignal }): Promise<ConnectAccount>;
  /** Queues and runs a top-up (asset and/or gas). */
  topUp(accountId: string, input: { asset: BurnerAssetKey; amount: string; gasWei: string }, opts?: { signal?: AbortSignal }): Promise<ConnectAccount>;
  /** Handles one dapp request and returns its JSON-RPC result. Throws ConnectError (see `toRpcError`). */
  handle(accountId: string, request: { method: string; params?: unknown; rpcId?: string | number }, source: RequestSource, opts?: { signal?: AbortSignal }): Promise<unknown>;
  /** Settles, sweeps back and retires. Safe to call again after any stop. */
  close(accountId: string, opts?: { signal?: AbortSignal }): Promise<ConnectAccount>;
  get(id: string): Promise<ConnectAccount | null>;
  list(): Promise<ConnectAccount[]>;
  /** The open account bound to this origin, if any. */
  findOpen(origin: string): Promise<ConnectAccount | null>;
  /** The account that owns this address, if any. */
  byAddress(address: string): Promise<ConnectAccount | null>;
}

export function createConnectEngine(deps: ConnectDeps): ConnectEngine {
  const o: ConnectOptions = { ...DEFAULTS, ...deps.options };
  const now = deps.now ?? (() => new Date());
  const random = deps.random ?? ((n: number) => crypto.getRandomValues(new Uint8Array(n)));
  const hex = (n: number) => [...random(n)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const iso = () => now().toISOString();
  const roundUp = (wei: bigint) => ((wei + o.gasRoundWei - 1n) / o.gasRoundWei) * o.gasRoundWei;

  // ---------- one-at-a-time per account ----------

  const queues = new Map<string, Promise<unknown>>();
  function serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = queues.get(id) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    queues.set(id, settled);
    void settled.then(() => {
      if (queues.get(id) === settled) queues.delete(id);
    });
    return next;
  }

  interface Ctx {
    a: ConnectAccount;
    rev: number;
    signal?: AbortSignal;
  }

  async function load(id: string): Promise<Ctx> {
    const s = await deps.store.get(id);
    if (!s) throw new ConnectError("not_found", `no Connect account ${id}`);
    if (s.account.owner !== deps.owner) throw new ConnectError("validation", `account ${id} belongs to ${s.account.owner}, not ${deps.owner}`);
    return { a: s.account, rev: s.rev };
  }

  async function save(ctx: Ctx) {
    ctx.a.updatedAt = iso();
    ctx.rev = (await deps.store.update(ctx.a, ctx.rev)).rev;
  }

  function note(ctx: Ctx, message: string) {
    ctx.a.events.push({ at: iso(), message });
    deps.onEvent?.(ctx.a, message);
  }

  // ---------- identity ----------

  async function identityFor(self: `0x${string}`): Promise<Identity> {
    const linked = await deps.linked();
    const evm = new Map(linked.evm);
    for (const r of await deps.book.list()) {
      const k = r.address.toLowerCase();
      if (k !== self.toLowerCase() && !evm.has(k)) evm.set(k, `your Shelter ${r.purpose} address #${r.index}`);
    }
    return { evm, near: [...new Set([...linked.near, deps.owner.toLowerCase()])] };
  }

  // ---------- funding ----------

  async function defaultGas(): Promise<bigint> {
    const fees = await deps.chain.fees();
    return roundUp(o.gasPerTx * BigInt(o.initialTxs) * fees.maxFeePerGas * o.gasHeadroom);
  }

  /** Queues a fund job for the account and records it; does not run it. */
  async function queueFunding(ctx: Ctx, reason: Funding["reason"], f: { asset: BurnerAssetKey; amount: string; gasWei: string }) {
    const job = await deps.burner.create({
      kind: "fund",
      target: ctx.a.address,
      asset: f.asset,
      amount: f.amount,
      gasWei: f.gasWei,
      payWith: ctx.a.budget.payWith,
    });
    ctx.a.fundings.push({ jobId: job.id, at: iso(), reason });
    note(ctx, `queued ${reason} funding ${job.id}`);
    await save(ctx);
  }

  /** Runs every funding job of the account that is not finished. */
  async function runFundings(ctx: Ctx) {
    for (const f of ctx.a.fundings) {
      const job = await deps.burner.get(f.jobId);
      if (!job) throw new ConnectError("needs_attention", `funding job ${f.jobId} is missing`);
      if (job.status === "done" || job.status === "cancelled") continue;
      try {
        await deps.burner.run(f.jobId, { signal: ctx.signal });
      } catch (e) {
        if (isBurnerError(e, "rejected")) throw new ConnectError("rejected", `funding ${f.jobId} was not approved`, { cause: e });
        if (isBurnerError(e, "pending")) throw new ConnectError("pending", e.message, { cause: e });
        if (isBurnerError(e, "needs_attention")) throw new ConnectError("needs_attention", `funding ${f.jobId}: ${e.message}`, { cause: e });
        throw e;
      }
      note(ctx, `funding ${f.jobId} delivered`);
      await save(ctx);
    }
  }

  async function topUpNow(ctx: Ctx, reason: Funding["reason"], f: { asset: BurnerAssetKey; amount: string; gasWei: string }, ask: boolean) {
    if (ask) {
      const ok = await deps.approve({ kind: "top_up", accountId: ctx.a.id, reason, ...f, payWith: ctx.a.budget.payWith });
      if (!ok) throw new ConnectError("rejected", `${reason} top-up declined`);
    }
    await queueFunding(ctx, reason, f);
    await runFundings(ctx);
  }

  // ---------- transactions ----------

  async function priceTx(tx: TxRequest, gasHint?: bigint) {
    const fees = await deps.chain.fees();
    let gas: bigint;
    try {
      gas = ((await deps.chain.estimateGas(tx)) * 12n) / 10n;
    } catch (e) {
      // The chain client reports a revert (and an RPC failure) as a BurnerError "chain"; anything else is not ours to rename.
      if (isBurnerError(e, "chain")) throw new ConnectError("chain", `the transaction would fail: ${e.message}`, { cause: e });
      throw e;
    }
    if (gasHint && gasHint > gas) gas = gasHint;
    const nonce = await deps.chain.nonce(tx.from);
    const l1 = await deps.chain.l1Fee({ ...tx, gas, nonce, ...fees });
    return { fees, gas, nonce, maxFee: gas * fees.maxFeePerGas + l1 };
  }

  async function signTx(ctx: Ctx, tx: TxRequest, p: Awaited<ReturnType<typeof priceTx>>, description: string): Promise<SignedTx & { value: string }> {
    const account = deps.vault.account(ctx.a.address.index);
    if (account.address !== ctx.a.address.address) throw new ConnectError("needs_attention", "vault account does not match the dapp address");
    const raw = (await account.signTransaction({
      type: "eip1559",
      chainId: deps.chain.chainId,
      nonce: p.nonce,
      to: tx.to,
      data: tx.data,
      value: tx.value ?? 0n,
      gas: p.gas,
      maxFeePerGas: p.fees.maxFeePerGas,
      maxPriorityFeePerGas: p.fees.maxPriorityFeePerGas,
    })) as Hex;
    return {
      raw,
      hash: keccak256(raw),
      nonce: p.nonce,
      gas: p.gas.toString(),
      maxFeePerGas: p.fees.maxFeePerGas.toString(),
      to: tx.to,
      value: (tx.value ?? 0n).toString(),
      description,
      signedAt: iso(),
    };
  }

  /** Broadcasts a persisted signed transaction unless the node already has it. */
  async function broadcast(ctx: Ctx, tx: SignedTx) {
    if (tx.receipt || (await deps.chain.knows(tx.hash))) return;
    try {
      await deps.chain.sendRaw(tx.raw);
    } catch (e) {
      if (!isBurnerError(e, "chain")) throw e;
      // "already known" / "nonce too low" after a lost response: the node decides.
      if (!(await deps.chain.knows(tx.hash))) throw new ConnectError("chain", `broadcast failed: ${e.message}`, { cause: e });
    }
    tx.broadcastAt ??= iso();
    note(ctx, `broadcast ${tx.hash}`);
    await save(ctx);
  }

  async function waitReceipt(ctx: Ctx, tx: SignedTx) {
    if (tx.receipt) return tx.receipt;
    const stopAt = now().getTime() + o.receiptTimeoutMs;
    let r = await deps.chain.receipt(tx.hash);
    while (!r && now().getTime() < stopAt) {
      await o.sleep(o.receiptIntervalMs, ctx.signal);
      r = await deps.chain.receipt(tx.hash);
    }
    if (!r) throw new ConnectError("pending", `transaction ${tx.hash} is not mined yet; run it again`);
    tx.receipt = { status: r.status, blockNumber: r.blockNumber.toString(), gasUsed: r.gasUsed.toString(), feeWei: r.feeWei.toString() };
    await save(ctx);
    return tx.receipt;
  }

  async function sendTransaction(ctx: Ctx, rec: RequestRecord, req: Extract<DappRequest, { method: "eth_sendTransaction" }>, warnings: Finding[]): Promise<Hex> {
    const self = ctx.a.address.address;
    const tx: TxRequest = { from: self, to: req.tx.to!, data: req.tx.data, value: req.tx.value };
    const value = tx.value ?? 0n;

    // Price it. Until the address holds the value, the estimate may fail, so
    // price the approval at the typical gas and estimate again after.
    let eth = await deps.chain.nativeBalance(self);
    const fees = await deps.chain.fees();
    let firstPrice: Awaited<ReturnType<typeof priceTx>> | undefined;
    if (eth >= value) firstPrice = await priceTx(tx, req.tx.gas);
    const maxFee = firstPrice?.maxFee ?? o.gasPerTx * fees.maxFeePerGas;
    const short = value + maxFee > eth ? value + maxFee - eth : 0n;
    const topUpWei = short > 0n ? roundUp(value > eth ? value - eth + maxFee * o.gasHeadroom : short * o.gasHeadroom) : 0n;

    const ok = await deps.approve({
      kind: "dapp_transaction",
      accountId: ctx.a.id,
      dapp: ctx.a.dapp,
      summary: rec.summary,
      to: tx.to,
      value: value.toString(),
      maxFeeWei: maxFee.toString(),
      ...(topUpWei > 0n ? { topUpWei: topUpWei.toString() } : {}),
      warnings,
    });
    if (!ok) throw new ConnectError("rejected", "transaction declined");

    if (topUpWei > 0n) {
      // The value is ETH from the confidential balance; gas rides along in the same withdrawal.
      const valuePart = value > eth ? value - eth : 0n;
      await topUpNow(ctx, valuePart > 0n ? "value" : "gas", { asset: "eth", amount: valuePart.toString(), gasWei: (topUpWei - valuePart).toString() }, false);
      eth = await deps.chain.nativeBalance(self);
    }
    let p = await priceTx(tx, req.tx.gas);
    if (eth < value + p.maxFee) {
      // Fees rose between the approval and now: one more top-up, asked for.
      await topUpNow(ctx, "gas", { asset: "eth", amount: "0", gasWei: roundUp((value + p.maxFee - eth) * o.gasHeadroom).toString() }, true);
      p = await priceTx(tx, req.tx.gas);
    }

    rec.tx = await signTx(ctx, tx, p, rec.summary);
    note(ctx, `request ${rec.seq}: signed ${rec.tx.hash}`);
    await save(ctx);
    try {
      await broadcast(ctx, rec.tx);
    } catch (e) {
      rec.decision = "failed";
      rec.error = e instanceof Error ? e.message : String(e);
      await save(ctx);
      throw e;
    }
    rec.decision = "sent";
    await save(ctx);
    return rec.tx.hash;
  }

  async function signRequest(ctx: Ctx, rec: RequestRecord, req: Extract<DappRequest, { method: "personal_sign" | "eth_signTypedData_v4" }>, warnings: Finding[]): Promise<Hex> {
    const text = req.method === "personal_sign" ? describeRequest(req) : JSON.stringify(req.typedData, null, 2);
    const ok = await deps.approve({ kind: "dapp_signature", accountId: ctx.a.id, dapp: ctx.a.dapp, method: req.method, summary: rec.summary, text, warnings });
    if (!ok) throw new ConnectError("rejected", "signature declined");
    const account = deps.vault.account(ctx.a.address.index);
    if (account.address !== ctx.a.address.address) throw new ConnectError("needs_attention", "vault account does not match the dapp address");
    let sig: Hex;
    try {
      sig =
        req.method === "personal_sign"
          ? await account.signMessage({ message: isHex(req.message) ? { raw: req.message } : req.message })
          : await account.signTypedData(req.typedData);
    } catch (e) {
      throw new ConnectError("validation", `could not sign: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`, { cause: e });
    }
    rec.signature = sig;
    rec.decision = "signed";
    await save(ctx);
    return sig;
  }

  // ---------- close and sweep ----------

  /** Requests whose transaction was signed but whose outcome was not recorded (a crash between save and broadcast). */
  async function reconcile(ctx: Ctx) {
    for (const r of ctx.a.requests) {
      if (!r.tx || r.decision) continue;
      const known = r.tx.receipt || (await deps.chain.knows(r.tx.hash)) || (await deps.chain.receipt(r.tx.hash));
      r.decision = known ? "sent" : "not_sent";
      note(ctx, `request ${r.seq}: ${r.tx.hash} ${known ? "was sent" : "was never sent; the dapp did not get a hash"}`);
      await save(ctx);
    }
    for (const r of ctx.a.requests) if (r.tx && r.decision === "sent") await waitReceipt(ctx, r.tx);
  }

  async function mapLimit<T, R>(xs: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(xs.length);
    let i = 0;
    await Promise.all(
      Array.from({ length: Math.min(n, xs.length) }, async () => {
        while (i < xs.length) {
          const k = i++;
          out[k] = await fn(xs[k]!);
        }
      }),
    );
    return out;
  }

  async function planSweep(ctx: Ctx) {
    const sw = ctx.a.sweep!;
    const self = ctx.a.address.address;
    const tokens = (await deps.intents.tokens({ signal: ctx.signal })).filter(
      (t: TokenInfo) => t.blockchain === "base" && t.assetId !== ETH_BASE.assetId && t.contractAddress && isAddress(t.contractAddress),
    );
    const balances = await mapLimit(tokens, o.balanceReadConcurrency, (t) => deps.chain.tokenBalance(getAddress(t.contractAddress!), self));
    sw.items = tokens
      .map((t, k) => ({ t, bal: balances[k]! }))
      .filter((x) => x.bal > 0n)
      .map(({ t, bal }) => ({
        assetId: t.assetId,
        symbol: t.symbol,
        decimals: t.decimals,
        token: getAddress(t.contractAddress!),
        balance: bal.toString(),
        decision: "deposit" as const,
      }));
    const eth = await deps.chain.nativeBalance(self);
    const ok = await deps.approve({
      kind: "sweep",
      accountId: ctx.a.id,
      address: self,
      items: [
        ...sw.items.map((x) => ({ symbol: x.symbol, amount: formatBaseUnits(x.balance, x.decimals), decision: x.decision })),
        ...(eth > 0n ? [{ symbol: "ETH", amount: `${formatBaseUnits(eth.toString(), 18)} (less the fee of its own transfer)`, decision: "deposit" as const }] : []),
      ],
      unsupported: sw.unsupported ?? [],
    });
    if (!ok) throw new ConnectError("rejected", "sweep declined; the account stays closing, run close again to sweep");
    sw.planned = true;
    note(ctx, `sweep planned: ${sw.items.length} token(s)${eth > 0n ? " and ETH" : ""}`);
    await save(ctx);
  }

  async function sweepQuote(ctx: Ctx, item: SweepItem, amount: bigint): Promise<boolean> {
    if (item.quote) {
      try {
        assertFundable(item.quote, now());
        return true;
      } catch {
        /* requote */
      }
    }
    try {
      item.quote = await deps.intents.getQuote(
        privateDepositRequest({ asset: { assetId: item.assetId, amount: amount.toString() }, owner: ctx.a.owner, slippageBps: o.slippageBps, dry: false }),
        { signal: ctx.signal },
      );
    } catch (e) {
      if (isIntentsError(e, "bad_request") || isIntentsError(e, "unsupported")) {
        item.decision = "dust";
        item.note = `1Click will not take ${formatBaseUnits(amount.toString(), item.decimals)} ${item.symbol}: ${e.message}`;
        note(ctx, item.note);
        await save(ctx);
        return false;
      }
      throw e;
    }
    if (!item.quote.depositAddress || !isAddress(item.quote.depositAddress)) throw new ConnectError("needs_attention", `sweep quote for ${item.symbol} has no EVM deposit address`);
    note(ctx, `sweep ${item.symbol}: quote ${item.quote.quoteId}, deposit address ${item.quote.depositAddress}`);
    await save(ctx);
    return true;
  }

  async function sweepItem(ctx: Ctx, item: SweepItem) {
    const self = ctx.a.address.address;
    if (item.outcome || item.decision !== "deposit") return;
    if (!item.tx) {
      const isEth = !item.token;
      let amount = BigInt(item.balance);
      if (isEth) {
        // Native ETH pays its own fee: send what is left after the fee of this transfer, with headroom.
        const bal = await deps.chain.nativeBalance(self);
        const probe = await priceTx({ from: self, to: self, value: 1n });
        amount = bal - probe.maxFee * o.gasHeadroom;
        item.balance = bal.toString();
        if (amount <= 0n) {
          item.decision = "dust";
          item.note = "ETH left is below the fee of sending it";
          await save(ctx);
          return;
        }
      }
      if (!(await sweepQuote(ctx, item, amount))) return;
      const q = item.quote!;
      const to = getAddress(q.depositAddress!);
      const tx: TxRequest = isEth
        ? { from: self, to, value: BigInt(q.amountIn) }
        : { from: self, to: item.token!, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, BigInt(q.amountIn)] }), value: 0n };
      let p = await priceTx(tx);
      const eth = await deps.chain.nativeBalance(self);
      if (eth < p.maxFee + (tx.value ?? 0n)) {
        if (isEth) {
          item.decision = "dust";
          item.note = "fees rose above what the ETH left can pay";
          await save(ctx);
          return;
        }
        try {
          await topUpNow(ctx, "sweep_gas", { asset: "eth", amount: "0", gasWei: roundUp((p.maxFee - eth) * o.gasHeadroom).toString() }, true);
        } catch (e) {
          if (!isConnectError(e, "rejected")) throw e;
          item.decision = "no_gas";
          item.note = `no gas to sweep ${item.symbol}; it stays on the retired address, whose key the seed can recover`;
          note(ctx, item.note);
          await save(ctx);
          return;
        }
        p = await priceTx(tx);
      }
      item.tx = await signTx(ctx, tx, p, `return ${formatBaseUnits(q.amountIn, item.decimals)} ${item.symbol} to the confidential balance`);
      note(ctx, `sweep ${item.symbol}: signed ${item.tx.hash}`);
      await save(ctx);
    }
    await broadcast(ctx, item.tx);
    const r = await waitReceipt(ctx, item.tx);
    if (r.status === "reverted") throw new ConnectError("needs_attention", `sweep of ${item.symbol} reverted (${item.tx.hash})`);
    if (!item.depositNotified) {
      try {
        await deps.intents.submitDeposit(item.quote!, item.tx.hash, { signal: ctx.signal });
      } catch (e) {
        note(ctx, `deposit notice for ${item.symbol} failed (1Click also watches the chain): ${e instanceof Error ? e.message : String(e)}`);
      }
      item.depositNotified = true;
      await save(ctx);
    }
    const st = await deps.intents.waitForStatus(item.quote!.depositAddress!, {
      timeoutMs: o.statusTimeoutMs,
      intervalMs: o.statusIntervalMs,
      signal: ctx.signal,
    });
    item.status = st.status;
    if (st.status === "SUCCESS") item.outcome = "returned";
    else if (st.status === "REFUNDED") item.outcome = "refunded";
    else if (st.status === "FAILED") throw new ConnectError("needs_attention", `sweep deposit of ${item.symbol} FAILED at 1Click (${item.quote!.depositAddress})`);
    else {
      await save(ctx);
      throw new ConnectError("pending", `sweep deposit of ${item.symbol} is still ${st.status}; run close again`);
    }
    note(ctx, `sweep ${item.symbol}: ${item.outcome} to the confidential balance`);
    await save(ctx);
  }

  async function closeAccount(ctx: Ctx) {
    const { a } = ctx;
    if (a.status === "closed") return;
    if (a.status === "open") {
      a.status = "closing";
      note(ctx, "closing: no more dapp requests");
      await save(ctx);
    }
    // Funding not yet signed is cancelled; anything in flight finishes first.
    for (const f of a.fundings) {
      const job = await deps.burner.get(f.jobId);
      if (!job || job.status === "done" || job.status === "cancelled") continue;
      try {
        await deps.burner.cancel(f.jobId);
        note(ctx, `funding ${f.jobId} cancelled`);
        await save(ctx);
      } catch (e) {
        if (!isBurnerError(e, "validation")) throw e;
      }
    }
    await runFundings(ctx);
    await reconcile(ctx);
    a.sweep ??= { startedAt: iso(), items: [] };
    if (!a.sweep.planned) await planSweep(ctx);
    for (const item of a.sweep.items.filter((x) => x.token)) await sweepItem(ctx, item);
    // ETH last: it pays for the token transfers above.
    let ethItem = a.sweep.items.find((x) => !x.token);
    if (!ethItem && (await deps.chain.nativeBalance(a.address.address)) > 0n) {
      ethItem = { assetId: ETH_BASE.assetId, symbol: "ETH", decimals: 18, balance: "0", decision: "deposit" };
      a.sweep.items.push(ethItem);
      await save(ctx);
    }
    if (ethItem) await sweepItem(ctx, ethItem);
    await deps.book.retire(a.address.address);
    a.status = "closed";
    note(ctx, `closed; ${a.address.address} retired`);
    await save(ctx);
  }

  // ---------- public API ----------

  async function handleOne(ctx: Ctx, request: { method: string; params?: unknown; rpcId?: string | number }, source: RequestSource): Promise<unknown> {
    const { a } = ctx;
    if (a.status !== "open") throw new ConnectError("busy", `this dapp's account is ${a.status}`);
    const req = parseRequest(request.method, request.params);
    if (req.method === "eth_chainId") return `0x${BASE_CHAIN_ID.toString(16)}`;
    if (req.method === "eth_accounts") return [a.address.address];
    if (req.method === "wallet_switchEthereumChain") {
      if (req.chainId === BASE_CHAIN_ID) return null;
      throw new ConnectError("unsupported", `Shelter Connect only serves Base (chain ${BASE_CHAIN_ID}), not chain ${req.chainId}`);
    }

    const findings: Finding[] = [];
    let origin = source.origin;
    try {
      origin = originOf(source.origin);
    } catch {
      /* reported below */
    }
    if (origin !== a.dapp.origin) {
      findings.push({ level: "block", code: "origin_mismatch", message: `the request comes from ${source.origin}, but this address belongs to ${a.dapp.origin}` });
    }
    if (source.scam) findings.push({ level: "block", code: "dapp_scam", message: "WalletConnect Verify flags this domain as a scam" });
    if (source.verified === "invalid") findings.push({ level: "block", code: "dapp_unverified", message: "the dapp's domain does not match what it registered with WalletConnect" });
    else if (source.verified !== "valid") findings.push({ level: "warn", code: "dapp_unverified", message: "WalletConnect could not verify the dapp's domain" });
    findings.push(...inspect(req, { self: a.address.address, identity: await identityFor(a.address.address), origin: a.dapp.origin }));

    const rec: RequestRecord = {
      seq: a.requests.length + 1,
      at: iso(),
      ...(request.rpcId !== undefined ? { rpcId: String(request.rpcId) } : {}),
      method: req.method,
      origin: source.origin,
      summary: describeRequest(req),
      ...(request.params !== undefined ? { params: request.params } : {}),
      findings,
    };
    a.requests.push(rec);
    await save(ctx);

    const refused = blocks(findings);
    if (refused.length) {
      rec.decision = "blocked";
      note(ctx, `request ${rec.seq} blocked: ${refused.map((f) => f.code).join(", ")}`);
      await save(ctx);
      throw new ConnectError("blocked", refused.map((f) => f.message).join("; "));
    }
    const warnings = findings.filter((f) => f.level === "warn");
    try {
      // Funding still in flight (the opening budget) lands before anything is signed.
      await runFundings(ctx);
      if (req.method === "eth_sendTransaction") return await sendTransaction(ctx, rec, req, warnings);
      return await signRequest(ctx, rec, req, warnings);
    } catch (e) {
      if (!rec.decision && !rec.tx) {
        rec.decision = isConnectError(e, "rejected") ? "rejected" : "failed";
        rec.error = e instanceof Error ? e.message : String(e);
        try {
          await save(ctx);
        } catch {
          /* keep the original error */
        }
      }
      throw e;
    }
  }

  const engine: ConnectEngine = {
    async open(input) {
      const dapp: DappInfo = { origin: originOf(input.dapp.origin), ...(input.dapp.name ? { name: input.dapp.name } : {}), ...(input.dapp.url ? { url: input.dapp.url } : {}) };
      const b = input.budget;
      if (!BURNER_ASSETS[b.asset as BurnerAssetKey] || !BURNER_ASSETS[b.payWith as BurnerAssetKey]) throw new ConnectError("validation", "unsupported budget asset");
      if (typeof b.amount !== "string" || !/^(0|[1-9][0-9]*)$/.test(b.amount)) throw new ConnectError("validation", "budget amount must be base units");
      if (await engine.findOpen(dapp.origin)) throw new ConnectError("busy", `an account for ${dapp.origin} is already open`);
      const gasWei = input.gasWei ?? (await defaultGas()).toString();
      if (!/^(0|[1-9][0-9]*)$/.test(gasWei)) throw new ConnectError("validation", "gasWei must be wei");

      const ok = await deps.approve({ kind: "open", dapp, budget: b, gasWei });
      if (!ok) throw new ConnectError("rejected", "opening declined");
      const id = `ca_${hex(8)}`;
      const rec = await deps.book.allocate({ purpose: "connect", chain: "base", label: `connect:${id}:${dapp.origin}` });
      if (deps.vault.address(rec.index) !== rec.address) throw new ConnectError("needs_attention", `address book record ${rec.index} does not match the seed`);
      const [nonce, eth] = await Promise.all([deps.chain.nonce(rec.address), deps.chain.nativeBalance(rec.address)]);
      if (nonce !== 0 || eth !== 0n) {
        await deps.book.retire(rec.address);
        throw new ConnectError("needs_attention", `derived address ${rec.address} already has on-chain history; it was retired, open again to use a new one`);
      }
      const at = iso();
      const account: ConnectAccount = {
        v: ACCOUNT_FORMAT_VERSION,
        id,
        createdAt: at,
        updatedAt: at,
        status: "open",
        owner: deps.owner,
        chain: "base",
        dapp,
        address: { index: rec.index, address: rec.address },
        budget: { asset: b.asset, amount: b.amount, payWith: b.payWith },
        fundings: [],
        requests: [],
        events: [{ at, message: `opened for ${dapp.origin} at ${rec.address} (index ${rec.index})` }],
      };
      const s = await deps.store.create(account);
      const ctx: Ctx = { a: s.account, rev: s.rev };
      // A zero budget with zero gas is a sign-in-only account: nothing is withdrawn until a transaction needs it.
      if (b.amount !== "0" || gasWei !== "0") await queueFunding(ctx, "open", { asset: b.asset, amount: b.amount, gasWei });
      return ctx.a;
    },

    fund: (id, opts = {}) =>
      serial(id, async () => {
        const ctx = await load(id);
        ctx.signal = opts.signal;
        await runFundings(ctx);
        return ctx.a;
      }),

    topUp: (id, input, opts = {}) =>
      serial(id, async () => {
        const ctx = await load(id);
        ctx.signal = opts.signal;
        if (ctx.a.status !== "open") throw new ConnectError("busy", `account ${id} is ${ctx.a.status}`);
        await topUpNow(ctx, "manual", input, true);
        return ctx.a;
      }),

    handle: (id, request, source, opts = {}) =>
      serial(id, async () => {
        const ctx = await load(id);
        ctx.signal = opts.signal;
        return handleOne(ctx, request, source);
      }),

    close: (id, opts = {}) =>
      serial(id, async () => {
        const ctx = await load(id);
        ctx.signal = opts.signal;
        try {
          await closeAccount(ctx);
          delete ctx.a.attention;
          await save(ctx);
        } catch (e) {
          if (isConnectError(e, "needs_attention")) {
            ctx.a.attention = e.message;
            note(ctx, `stopped: ${e.message}`);
            try {
              await save(ctx);
            } catch {
              /* keep the original error */
            }
          }
          throw e;
        }
        return ctx.a;
      }),

    get: async (id) => (await deps.store.get(id))?.account ?? null,
    list: async () => (await deps.store.list()).map((s) => s.account),
    async findOpen(origin) {
      const o2 = originOf(origin);
      return (await engine.list()).find((a) => a.status === "open" && a.dapp.origin === o2) ?? null;
    },
    async byAddress(address) {
      const k = address.toLowerCase();
      return (await engine.list()).find((a) => a.address.address.toLowerCase() === k) ?? null;
    },
  };
  return engine;
}
