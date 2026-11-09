/**
 * Burner engine (G6): one public action from a one-time address, funded
 * from the confidential balance (gas plan A), then retired.
 *
 *   allocate   derive a fresh address from the seed, check it never acted
 *   fund_gas   confidential withdrawal paid in the action's asset (USDC),
 *              delivered as native ETH for the action's gas
 *   fund_asset confidential withdrawal of the exact action amount
 *   act        the burner signs and sends its one transaction
 *   sweep      anything left above the 1Click minimum goes back to the
 *              confidential balance through a deposit
 *   retire     the address is marked retired and never handed out again
 *
 * Gas comes first so the asset never sits on an address that cannot move
 * it. All funding and refunds route through the owner's confidential
 * balance; nothing touches a known address.
 *
 * Crash safety: see ./job.ts. A run can stop at any point (crash, Ctrl-C,
 * a status that has not settled yet) and `run(id)` continues from the last
 * saved state without repeating a payment. Only one runner holds a job at a
 * time (lease plus compare-and-swap on every save).
 *
 * Every spend waits for `approve`: each withdrawal (after the generated
 * intent has been checked, before the wallet is asked) and each burner
 * transaction (before it is signed).
 */

import {
  assertFundable,
  formatBaseUnits,
  isIntentsError,
  privateDepositRequest,
  privateWithdrawRequest,
  type IntentsClient,
  type IntentSummary,
  type Nep413Signer,
  type Quote,
  type StatusResult,
} from "@shelter/intents";
import { isKeysError, type AddressBook, type SeedVault } from "@shelter/keys";
import { encodeFunctionData, erc20Abi, getAddress, isAddress, keccak256, zeroAddress, type Hex } from "viem";
import { BURNER_ASSETS, type BurnerAsset } from "./assets.js";
import type { ChainClient, Fees, Receipt, TxRequest } from "./chain.js";
import { BurnerError, isBurnerError } from "./errors.js";
import {
  JOB_FORMAT_VERSION,
  type BurnerAction,
  type BurnerJob,
  type FundingLeg,
  type JobStep,
  type JobStore,
  type SignedTx,
  type StoredJob,
} from "./job.js";

/** Gas budgeted for a USDC transfer before the burner holds USDC (real use is about 40k-62k). */
const ERC20_TRANSFER_GAS_BUDGET = 90_000n;

export type ApprovalRequest =
  | {
      kind: "withdraw";
      jobId: string;
      leg: "gas" | "asset";
      /** What the burner receives. */
      asset: BurnerAsset;
      /** What the confidential balance pays with (differs for gas paid in USDC). */
      payAsset: BurnerAsset;
      to: `0x${string}`;
      /** Exact amount the burner receives, base units. */
      amountOut: string;
      /** Most the confidential balance pays, in `payAsset` base units (includes fees and slippage buffer). */
      maxAmountIn: string;
      withdrawFee?: string;
      /** The checked intent the wallet is about to sign. */
      intent: IntentSummary;
    }
  | {
      kind: "transaction";
      jobId: string;
      purpose: "action" | "sweep";
      from: `0x${string}`;
      to: `0x${string}`;
      description: string;
      /** Upper bound on the fee, in wei (L2 gas at max fee plus L1 data fee). */
      maxFeeWei: string;
    };

export interface EngineOptions {
  /** Slippage for the 1Click quotes. Default 50 bps. */
  slippageBps: number;
  /** Gas is funded at this multiple of the estimated cost. Default 2. */
  gasHeadroom: bigint;
  /** Gas amounts are rounded up to a multiple of this (wei). Default 1e12 (0.000001 ETH). */
  gasRoundWei: bigint;
  maxFundingAttempts: number;
  maxGasTopUps: number;
  statusTimeoutMs: number;
  statusIntervalMs: number;
  receiptTimeoutMs: number;
  receiptIntervalMs: number;
  /** How long to wait for the chain to show a delivery 1Click reported. */
  deliveryTimeoutMs: number;
  /** After a quote's deadline, wait this long before treating an unexecuted attempt as dead. */
  expiryGraceMs: number;
  leaseMs: number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const DEFAULTS: EngineOptions = {
  slippageBps: 50,
  gasHeadroom: 2n,
  gasRoundWei: 10n ** 12n,
  maxFundingAttempts: 3,
  maxGasTopUps: 2,
  statusTimeoutMs: 15 * 60_000,
  statusIntervalMs: 5_000,
  receiptTimeoutMs: 3 * 60_000,
  receiptIntervalMs: 2_000,
  deliveryTimeoutMs: 2 * 60_000,
  expiryGraceMs: 2 * 60_000,
  leaseMs: 10 * 60_000,
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

export interface BurnerEngineDeps {
  intents: IntentsClient;
  vault: SeedVault;
  book: AddressBook;
  chain: ChainClient;
  store: JobStore;
  /** Wallet of the NEAR account that owns the confidential balance. */
  owner: Nep413Signer;
  approve(req: ApprovalRequest): Promise<boolean> | boolean;
  onEvent?(job: BurnerJob, message: string): void;
  now?: () => Date;
  random?: (n: number) => Uint8Array;
  options?: Partial<EngineOptions>;
}

export interface Preview {
  gasWei: string;
  gasQuote: Quote;
  assetQuote: Quote;
  /** What the confidential balance pays at most, per asset id, base units. */
  maxSpend: Record<string, string>;
}

export interface BurnerEngine {
  /** Validates the action and stores a new job. Sends nothing. */
  create(action: BurnerAction, opts?: { notBefore?: string; planRef?: string }): Promise<BurnerJob>;
  /** Dry quotes and a gas estimate for an action, using a throwaway address. Allocates and stores nothing. */
  preview(action: BurnerAction, opts?: { signal?: AbortSignal }): Promise<Preview>;
  /** Advances the job as far as it can. Safe to call again after any stop. */
  run(id: string, opts?: { signal?: AbortSignal }): Promise<BurnerJob>;
  /** Cancels a job that has not submitted any withdrawal yet; retires its address if one was allocated. */
  cancel(id: string): Promise<BurnerJob>;
  get(id: string): Promise<BurnerJob | null>;
  list(): Promise<BurnerJob[]>;
}

export function createBurnerEngine(deps: BurnerEngineDeps): BurnerEngine {
  const o: EngineOptions = { ...DEFAULTS, ...deps.options };
  const now = deps.now ?? (() => new Date());
  const random = deps.random ?? ((n: number) => crypto.getRandomValues(new Uint8Array(n)));
  const hex = (n: number) => [...random(n)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const holder = hex(8);
  const iso = () => now().toISOString();

  // ---------- validation ----------

  async function validateAction(action: BurnerAction): Promise<BurnerAction> {
    if (action?.kind !== "erc20_transfer" && action?.kind !== "hold") throw new BurnerError("validation", "action must be erc20_transfer or hold");
    const asset = BURNER_ASSETS[action.asset as keyof typeof BURNER_ASSETS];
    if (!asset?.token) throw new BurnerError("validation", `unsupported asset ${String(action.asset)}`);
    if (typeof action.amount !== "string" || !/^[1-9][0-9]*$/.test(action.amount)) {
      throw new BurnerError("validation", "amount must be a positive integer in base units");
    }
    if (action.kind === "hold") return { kind: "hold", asset: action.asset, amount: action.amount };
    if (typeof action.to !== "string" || !isAddress(action.to, { strict: false })) throw new BurnerError("validation", "recipient is not an EVM address");
    const to = getAddress(action.to);
    if (to === zeroAddress) throw new BurnerError("validation", "recipient is the zero address");
    if (to.toLowerCase() === asset.token.toLowerCase()) throw new BurnerError("validation", "recipient is the token contract");
    // Paying one of the user's own derived addresses from a burner would link the two.
    if (await deps.book.get(to)) {
      throw new BurnerError("validation", "recipient is one of your own Shelter addresses; paying it from a burner links them");
    }
    return { kind: "erc20_transfer", asset: action.asset, to, amount: action.amount };
  }

  /** The transfer the address will make: the action itself, or for a held address its later move (priced as a transfer to itself). */
  const transferTx = (
    action: BurnerAction,
    from: `0x${string}`,
    to: `0x${string}` = action.kind === "erc20_transfer" ? action.to : from,
    amount = BigInt(action.amount),
  ): TxRequest => ({
    from,
    to: BURNER_ASSETS[action.asset].token!,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] }),
    value: 0n,
  });

  const roundUp = (wei: bigint) => {
    const r = o.gasRoundWei;
    return ((wei + r - 1n) / r) * r;
  };

  async function gasBudget(action: BurnerAction, from: `0x${string}`): Promise<{ wei: bigint; fees: Fees; l1: bigint }> {
    const fees = await deps.chain.fees();
    const tx = transferTx(action, from);
    const l1 = await deps.chain.l1Fee({ ...tx, gas: ERC20_TRANSFER_GAS_BUDGET, nonce: 0, ...fees });
    const cost = ERC20_TRANSFER_GAS_BUDGET * fees.maxFeePerGas + l1;
    return { wei: roundUp(cost * o.gasHeadroom), fees, l1 };
  }

  const balanceOf = (asset: BurnerAsset, address: `0x${string}`) =>
    asset.token ? deps.chain.tokenBalance(asset.token, address) : deps.chain.nativeBalance(address);

  // ---------- persistence ----------

  interface Ctx {
    job: BurnerJob;
    rev: number;
    signal?: AbortSignal;
  }

  async function save(ctx: Ctx) {
    ctx.job.updatedAt = iso();
    ctx.job.lease = { holder, until: new Date(now().getTime() + o.leaseMs).toISOString() };
    const s = await deps.store.update(ctx.job, ctx.rev);
    ctx.rev = s.rev;
  }

  function note(ctx: Ctx, message: string) {
    ctx.job.events.push({ at: iso(), step: ctx.job.step, message });
    deps.onEvent?.(ctx.job, message);
  }

  async function goto(ctx: Ctx, step: JobStep, message?: string) {
    ctx.job.step = step;
    if (message) note(ctx, message);
    await save(ctx);
  }

  const attention = (why: string): never => {
    throw new BurnerError("needs_attention", why);
  };

  // ---------- steps ----------

  async function stepAllocate(ctx: Ctx) {
    const { job } = ctx;
    if (!job.burner) {
      const label = `burner-job:${job.id}`;
      // A crash between allocating and saving the job leaves the record; find it by label.
      const rec =
        (await deps.book.list()).find((r) => r.label === label && r.status === "active") ??
        (await deps.book.allocate({ purpose: job.action.kind === "hold" ? "destination" : "burner", chain: "base", label }));
      if (deps.vault.address(rec.index) !== rec.address) attention(`address book record ${rec.index} does not match the seed`);
      const [nonce, eth, tok] = await Promise.all([
        deps.chain.nonce(rec.address),
        deps.chain.nativeBalance(rec.address),
        balanceOf(BURNER_ASSETS[job.action.asset], rec.address),
      ]);
      if (nonce !== 0 || eth !== 0n || tok !== 0n) {
        await deps.book.retire(rec.address);
        attention(`derived address ${rec.address} (index ${rec.index}) already has on-chain history; it was retired, and running the job again uses a new address`);
      }
      job.burner = { index: rec.index, address: rec.address };
      note(ctx, `allocated ${job.action.kind === "hold" ? "payout address" : "burner"} ${rec.address} (index ${rec.index})`);
    }
    await goto(ctx, "fund_gas");
  }

  async function stepFundGas(ctx: Ctx) {
    const { job } = ctx;
    const burner = job.burner!.address;
    let leg = job.gas.at(-1);
    if (!leg) {
      const b = await gasBudget(job.action, burner);
      leg = { asset: "eth", payWith: job.action.asset, amount: b.wei.toString(), attempts: [] };
      job.gas.push(leg);
      note(ctx, `gas budget ${b.wei} wei (max fee ${b.fees.maxFeePerGas} wei/gas, L1 fee ${b.l1} wei, x${o.gasHeadroom} headroom)`);
      await save(ctx);
    }
    await fundLeg(ctx, leg, "gas");
    await goto(ctx, job.asset?.confirmedBalance && job.action.kind !== "hold" ? "act" : "fund_asset");
  }

  async function stepFundAsset(ctx: Ctx) {
    const { job } = ctx;
    if (!job.asset) {
      job.asset = { asset: job.action.asset, amount: job.action.amount, attempts: [] };
      await save(ctx);
    }
    await fundLeg(ctx, job.asset, "asset");
    if (job.action.kind === "hold") {
      // A payout address is kept for later use: no action, no sweep, not retired.
      job.status = "done";
      await goto(ctx, "done", `payout address ${job.burner!.address} funded and kept`);
      return;
    }
    await goto(ctx, "act");
  }

  async function fundLeg(ctx: Ctx, leg: FundingLeg, which: "gas" | "asset") {
    const { job, signal } = ctx;
    if (leg.confirmedBalance) return;
    const asset = BURNER_ASSETS[leg.asset];
    const payAsset = BURNER_ASSETS[leg.payWith ?? leg.asset];
    const burner = job.burner!.address;
    if (leg.balanceBefore === undefined) {
      leg.balanceBefore = (await balanceOf(asset, burner)).toString();
      await save(ctx);
    }

    for (;;) {
      let a = leg.attempts.at(-1);
      if (a?.outcome === "delivered") break;
      if (!a || a.outcome) {
        if (leg.attempts.length >= o.maxFundingAttempts) {
          attention(`${which} funding did not complete after ${leg.attempts.length} attempts (last: ${a?.outcome})`);
        }
        const quote = await deps.intents.getQuote(
          privateWithdrawRequest({
            asset: { assetId: asset.assetId, amount: leg.amount },
            payWithAssetId: payAsset.assetId,
            owner: job.owner,
            destination: burner,
            slippageBps: o.slippageBps,
            dry: false,
          }),
          { signal },
        );
        a = { quote };
        leg.attempts.push(a);
        note(
          ctx,
          `${which}: quote ${quote.quoteId}, ${formatBaseUnits(quote.amountIn, payAsset.decimals)} ${payAsset.symbol} in for ${formatBaseUnits(quote.amountOut, asset.decimals)} ${asset.symbol} out, deposit address ${quote.depositAddress}`,
        );
        await save(ctx);
      }

      if (!a.prepared) {
        try {
          assertFundable(a.quote, now());
        } catch (e) {
          if (!isIntentsError(e, "quote_expired")) throw e;
          a.outcome = "expired";
          note(ctx, `${which}: quote expired before signing; requoting`);
          await save(ctx);
          continue;
        }
        const quote = a.quote;
        try {
          a.prepared = await deps.intents.prepareSignedIntent(quote, deps.owner, {
            signal,
            approve: (intent) =>
              deps.approve({
                kind: "withdraw",
                jobId: job.id,
                leg: which,
                asset,
                payAsset,
                to: burner,
                amountOut: quote.amountOut,
                maxAmountIn: quote.amountIn,
                withdrawFee: quote.withdrawFee,
                intent,
              }),
          });
        } catch (e) {
          if (isIntentsError(e, "signer_rejected")) throw new BurnerError("rejected", `${which} withdrawal not signed: ${e.message}`, { cause: e });
          throw e;
        }
        note(ctx, `${which}: intent signed; quote deadline ${a.prepared.quoteDeadline}`);
        await save(ctx);
      }

      const prepared = a.prepared;
      // Past the quote deadline 1Click refunds any late transfer into the
      // deposit address to the owner's balance, so an attempt that has not
      // executed by then is dead even though the signed intent lives longer.
      const deadlinePassed = () => now().getTime() > Date.parse(prepared.quoteDeadline) + o.expiryGraceMs;

      if (!a.submitted) {
        const before = await deps.intents.status(prepared.depositAddress, { signal });
        if (before.status !== "PENDING_DEPOSIT") {
          a.submitted = { intentHash: before.intentHashes[0] ?? "", correlationId: before.correlationId, at: iso() };
          note(ctx, `${which}: already submitted (status ${before.status})`);
        } else if (deadlinePassed()) {
          a.outcome = "expired";
          note(ctx, `${which}: quote deadline passed before submitting; requoting`);
          await save(ctx);
          continue;
        } else {
          try {
            const sub = await deps.intents.submitSignedIntent(prepared, { signal });
            a.submitted = { ...sub, at: iso() };
            note(ctx, `${which}: intent submitted, hash ${sub.intentHash}`);
          } catch (e) {
            a.submitError = e instanceof Error ? e.message.slice(0, 300) : String(e);
            await save(ctx);
            const after = await deps.intents.status(prepared.depositAddress, { signal });
            if (after.status === "PENDING_DEPOSIT") throw e;
            a.submitted = { intentHash: after.intentHashes[0] ?? "", correlationId: after.correlationId, at: iso() };
            note(ctx, `${which}: submit errored but 1Click shows ${after.status}; continuing`);
          }
        }
        await save(ctx);
      }

      const attempt = a;
      const st = await waitStatus(ctx, prepared.depositAddress);
      attempt.status = st.status;
      attempt.statusAt = iso();
      if (st.status === "SUCCESS") {
        attempt.outcome = "delivered";
        note(ctx, `${which}: 1Click reports delivered`);
        await save(ctx);
        break;
      }
      if (st.status === "REFUNDED" || st.status === "FAILED") {
        attempt.outcome = st.status === "REFUNDED" ? "refunded" : "failed";
        note(ctx, `${which}: ${st.status}${st.refundReason ? ` (${st.refundReason})` : ""}; funds return to the confidential balance`);
        await save(ctx);
        continue;
      }
      if (st.status === "PENDING_DEPOSIT" && deadlinePassed()) {
        attempt.outcome = "expired";
        note(ctx, `${which}: not executed by the quote deadline (1Click refunds anything late); requoting`);
        await save(ctx);
        continue;
      }
      await save(ctx);
      throw new BurnerError("pending", `${which} withdrawal is still ${st.status}; run the job again to keep waiting`);
    }

    // Trust the chain, not only 1Click.
    const want = BigInt(leg.balanceBefore) + BigInt(leg.amount);
    const stopAt = now().getTime() + o.deliveryTimeoutMs;
    let bal = await balanceOf(asset, burner);
    while (bal < want && now().getTime() < stopAt) {
      await o.sleep(o.receiptIntervalMs, signal);
      bal = await balanceOf(asset, burner);
    }
    if (bal < want) throw new BurnerError("pending", `${which}: 1Click reports delivery but the burner holds ${bal} < ${want}; run again`);
    leg.confirmedBalance = bal.toString();
    note(ctx, `${which}: burner balance ${bal} confirmed on chain`);
    await save(ctx);
  }

  /** Polls 1Click until a terminal status or the timeout. Changes are noted and saved by the caller afterwards. */
  async function waitStatus(ctx: Ctx, depositAddress: string): Promise<StatusResult> {
    let last = "";
    return deps.intents.waitForStatus(depositAddress, {
      timeoutMs: o.statusTimeoutMs,
      intervalMs: o.statusIntervalMs,
      signal: ctx.signal,
      onUpdate: (s) => {
        if (s.status !== last) {
          last = s.status;
          note(ctx, `1Click status ${s.status} for ${depositAddress}`);
        }
      },
    });
  }

  async function stepAct(ctx: Ctx) {
    const { job } = ctx;
    const burner = job.burner!;
    try {
      await deps.book.assertUsable(burner.address);
    } catch (e) {
      if (isKeysError(e)) attention(`burner ${burner.address} is not usable: ${e.message}`);
      throw e;
    }
    job.act ??= {};
    if (!job.act.tx) {
      const tx = transferTx(job.action, burner.address);
      const nonce = await deps.chain.nonce(burner.address);
      if (nonce !== 0) attention(`burner ${burner.address} already sent ${nonce} transaction(s) that this job did not record`);
      const signed = await signTx(ctx, tx, nonce, "action", describe(job.action));
      if (!signed) return; // a gas top-up was queued
      job.act.tx = signed;
      note(ctx, `action signed, tx ${signed.hash}`);
      await save(ctx);
    }
    const r = await broadcastAndConfirm(ctx, job.act.tx);
    job.act.outcome = r.status;
    await goto(
      ctx,
      "sweep",
      r.status === "success" ? `action confirmed in block ${r.blockNumber}` : `action REVERTED in block ${r.blockNumber}; sweeping the funds back`,
    );
  }

  /**
   * Prices, approves and signs a burner transaction. Returns null (after
   * queuing a gas top-up) when the burner cannot pay for it, for the action;
   * for a sweep the caller decides.
   */
  async function signTx(
    ctx: Ctx,
    tx: TxRequest,
    nonce: number,
    purpose: "action" | "sweep",
    description: string,
  ): Promise<SignedTx | null> {
    const { job } = ctx;
    const burner = job.burner!;
    const fees = await deps.chain.fees();
    const estimate = await deps.chain.estimateGas(tx);
    const gas = (estimate * 12n) / 10n;
    const l1 = await deps.chain.l1Fee({ ...tx, gas, nonce, ...fees });
    const maxFee = gas * fees.maxFeePerGas + l1;
    const eth = await deps.chain.nativeBalance(burner.address);
    if (eth < maxFee + (tx.value ?? 0n)) {
      if (purpose === "sweep") return null;
      if (job.gas.length > o.maxGasTopUps) attention(`burner still short of gas after ${job.gas.length - 1} top-up(s)`);
      const short = roundUp((maxFee - eth) * o.gasHeadroom);
      job.gas.push({ asset: "eth", payWith: job.action.asset, amount: short.toString(), attempts: [] });
      await goto(ctx, "fund_gas", `burner holds ${eth} wei but the action may cost ${maxFee}; topping up ${short} wei`);
      return null;
    }
    const ok = await deps.approve({
      kind: "transaction",
      jobId: job.id,
      purpose,
      from: burner.address,
      to: tx.to,
      description,
      maxFeeWei: maxFee.toString(),
    });
    if (!ok) throw new BurnerError("rejected", `${purpose} transaction not approved`);
    const account = deps.vault.account(burner.index);
    if (account.address !== burner.address) attention("vault account does not match the burner address");
    const raw = (await account.signTransaction({
      type: "eip1559",
      chainId: deps.chain.chainId,
      nonce,
      to: tx.to,
      data: tx.data,
      value: tx.value ?? 0n,
      gas,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    })) as Hex;
    return {
      raw,
      hash: keccak256(raw),
      nonce,
      gas: gas.toString(),
      maxFeePerGas: fees.maxFeePerGas.toString(),
      to: tx.to,
      description,
      signedAt: iso(),
    };
  }

  async function broadcastAndConfirm(ctx: Ctx, tx: SignedTx): Promise<Receipt> {
    if (tx.receipt) {
      return {
        status: tx.receipt.status,
        blockNumber: BigInt(tx.receipt.blockNumber),
        gasUsed: BigInt(tx.receipt.gasUsed),
        feeWei: BigInt(tx.receipt.feeWei),
      };
    }
    let r = await deps.chain.receipt(tx.hash);
    if (!r && !(await deps.chain.knows(tx.hash))) {
      try {
        await deps.chain.sendRaw(tx.raw);
      } catch (e) {
        // "already known" / "nonce too low" after a lost response: the node decides.
        if (!(await deps.chain.knows(tx.hash)) && !(await deps.chain.receipt(tx.hash))) throw e;
      }
      tx.broadcastAt ??= iso();
      note(ctx, `broadcast ${tx.hash}`);
      await save(ctx);
    }
    const stopAt = now().getTime() + o.receiptTimeoutMs;
    while (!r && now().getTime() < stopAt) {
      await o.sleep(o.receiptIntervalMs, ctx.signal);
      r = await deps.chain.receipt(tx.hash);
    }
    if (!r) throw new BurnerError("pending", `transaction ${tx.hash} is not mined yet; run the job again`);
    tx.receipt = { status: r.status, blockNumber: r.blockNumber.toString(), gasUsed: r.gasUsed.toString(), feeWei: r.feeWei.toString() };
    await save(ctx);
    return r;
  }

  async function stepSweep(ctx: Ctx) {
    const { job, signal } = ctx;
    const burner = job.burner!;
    const asset = BURNER_ASSETS[job.action.asset];
    const sw = (job.sweep ??= {});

    if (!sw.decision) {
      const [left, eth] = await Promise.all([balanceOf(asset, burner.address), deps.chain.nativeBalance(burner.address)]);
      sw.assetLeft = left.toString();
      sw.ethLeft = eth.toString();
      sw.decision = left === 0n ? "nothing_left" : left < asset.depositMinimum ? "dust" : "deposit";
      note(ctx, `after the action: ${left} ${asset.symbol} and ${eth} wei left; ${sw.decision}`);
      await save(ctx);
    }

    if (sw.decision === "deposit" && !sw.outcome) {
      if (!sw.tx) {
        let fundable = false;
        if (sw.quote) {
          try {
            assertFundable(sw.quote, now());
            fundable = true;
          } catch {
            /* requote below */
          }
        }
        if (!fundable) {
          sw.quote = await deps.intents.getQuote(
            privateDepositRequest({
              asset: { assetId: asset.assetId, amount: sw.assetLeft! },
              owner: job.owner,
              slippageBps: o.slippageBps,
              dry: false,
            }),
            { signal },
          );
          note(ctx, `sweep quote ${sw.quote.quoteId} to deposit address ${sw.quote.depositAddress}`);
          await save(ctx);
        }
        const q = sw.quote!;
        if (!q.depositAddress || !isAddress(q.depositAddress)) attention("sweep quote has no EVM deposit address");
        const nonce = await deps.chain.nonce(burner.address);
        const tx = transferTx(job.action, burner.address, getAddress(q.depositAddress!), BigInt(q.amountIn));
        const signed = await signTx(ctx, tx, nonce, "sweep", `return ${q.amountIn} ${asset.symbol} to the confidential balance`);
        if (!signed) {
          sw.decision = "no_gas";
          note(ctx, `not enough gas to sweep ${sw.assetLeft} ${asset.symbol}; it stays on the retired burner, whose key the seed can still recover`);
          await save(ctx);
          return goto(ctx, "retire");
        }
        sw.tx = signed;
        await save(ctx);
      }
      const r = await broadcastAndConfirm(ctx, sw.tx);
      if (r.status === "reverted") attention(`sweep transaction ${sw.tx.hash} reverted`);
      if (!sw.depositNotified) {
        try {
          await deps.intents.submitDeposit(sw.quote!, sw.tx.hash, { signal });
        } catch (e) {
          note(ctx, `deposit notification failed (1Click also watches the chain): ${e instanceof Error ? e.message : String(e)}`);
        }
        sw.depositNotified = true;
        await save(ctx);
      }
      const st = await waitStatus(ctx, sw.quote!.depositAddress!);
      sw.status = st.status;
      if (st.status === "SUCCESS") sw.outcome = "returned";
      else if (st.status === "REFUNDED") sw.outcome = "refunded";
      else if (st.status === "FAILED") attention(`sweep deposit FAILED at 1Click (deposit address ${sw.quote!.depositAddress})`);
      else {
        await save(ctx);
        throw new BurnerError("pending", `sweep deposit is still ${st.status}; run the job again`);
      }
      note(ctx, `sweep ${sw.outcome}`);
      await save(ctx);
    }
    await goto(ctx, "retire");
  }

  async function stepRetire(ctx: Ctx) {
    await deps.book.retire(ctx.job.burner!.address);
    ctx.job.status = "done";
    await goto(ctx, "done", `burner ${ctx.job.burner!.address} retired`);
  }

  // ---------- public API ----------

  async function acquire(id: string): Promise<Ctx> {
    const s = await deps.store.get(id);
    if (!s) throw new BurnerError("not_found", `no burner job ${id}`);
    const l = s.job.lease;
    if (l && l.holder !== holder && Date.parse(l.until) > now().getTime()) {
      throw new BurnerError("busy", `job ${id} is being run elsewhere until ${l.until}`);
    }
    const ctx: Ctx = { job: s.job, rev: s.rev };
    await save(ctx);
    return ctx;
  }

  async function release(ctx: Ctx) {
    delete ctx.job.lease;
    ctx.job.updatedAt = iso();
    try {
      ctx.rev = (await deps.store.update(ctx.job, ctx.rev)).rev;
    } catch {
      /* the lease expires on its own */
    }
  }

  return {
    async create(action, opts = {}) {
      const valid = await validateAction(action);
      const at = iso();
      if (opts.notBefore !== undefined && Number.isNaN(Date.parse(opts.notBefore))) throw new BurnerError("validation", "notBefore is not a date");
      const job: BurnerJob = {
        v: JOB_FORMAT_VERSION,
        id: `bj_${hex(8)}`,
        createdAt: at,
        updatedAt: at,
        status: "active",
        step: "allocate",
        owner: deps.owner.accountId,
        chain: "base",
        action: valid,
        ...(opts.notBefore ? { notBefore: new Date(opts.notBefore).toISOString() } : {}),
        ...(opts.planRef ? { planRef: opts.planRef } : {}),
        gas: [],
        events: [{ at, step: "allocate", message: `created: ${describe(valid)}${opts.notBefore ? `, not before ${opts.notBefore}` : ""}` }],
      };
      return (await deps.store.create(job)).job;
    },

    async preview(action, opts = {}) {
      const valid = await validateAction(action);
      const asset = BURNER_ASSETS[valid.asset];
      const throwaway = getAddress(`0x${hex(20)}`);
      const gas = await gasBudget(valid, throwaway);
      const leg = (a: BurnerAsset, amount: string) =>
        deps.intents.getQuote(
          privateWithdrawRequest({
            asset: { assetId: a.assetId, amount },
            payWithAssetId: asset.assetId,
            owner: deps.owner.accountId,
            destination: throwaway,
            slippageBps: o.slippageBps,
            dry: true,
          }),
          { signal: opts.signal },
        );
      const [gasQuote, assetQuote] = await Promise.all([leg(BURNER_ASSETS.eth, gas.wei.toString()), leg(asset, valid.amount)]);
      return {
        gasWei: gas.wei.toString(),
        gasQuote,
        assetQuote,
        maxSpend: { [asset.assetId]: (BigInt(gasQuote.amountIn) + BigInt(assetQuote.amountIn)).toString() },
      };
    },

    async run(id, opts = {}) {
      const ctx = await acquire(id);
      ctx.signal = opts.signal;
      try {
        if (ctx.job.owner !== deps.owner.accountId) {
          throw new BurnerError("validation", `job ${id} belongs to ${ctx.job.owner}, not ${deps.owner.accountId}`);
        }
        const nb = ctx.job.notBefore;
        if (nb && ctx.job.step === "allocate" && !ctx.job.burner && Date.parse(nb) > now().getTime()) {
          throw new BurnerError("pending", `job ${id} is scheduled for ${nb}; run it then`);
        }
        if (ctx.job.status === "needs_attention") {
          note(ctx, `retrying after: ${ctx.job.attention}`);
          ctx.job.status = "active";
          delete ctx.job.attention;
          await save(ctx);
        }
        while (ctx.job.status === "active") {
          opts.signal?.throwIfAborted();
          const step = ctx.job.step;
          if (step === "allocate") await stepAllocate(ctx);
          else if (step === "fund_gas") await stepFundGas(ctx);
          else if (step === "fund_asset") await stepFundAsset(ctx);
          else if (step === "act") await stepAct(ctx);
          else if (step === "sweep") await stepSweep(ctx);
          else if (step === "retire") await stepRetire(ctx);
          else throw new BurnerError("storage", `job ${id} is at unknown step ${String(step)}`);
        }
        return ctx.job;
      } catch (e) {
        if (isBurnerError(e, "busy")) throw e; // someone else owns the job now; write nothing
        const message = e instanceof Error ? e.message : String(e);
        if (isBurnerError(e, "needs_attention")) {
          ctx.job.status = "needs_attention";
          ctx.job.attention = message;
        }
        note(ctx, `stopped: ${message}`);
        try {
          await save(ctx);
        } catch {
          /* keep the original error */
        }
        throw e;
      } finally {
        await release(ctx);
      }
    },

    async cancel(id) {
      const ctx = await acquire(id);
      try {
        const { job } = ctx;
        if (job.status !== "active" && job.status !== "needs_attention") throw new BurnerError("validation", `job ${id} is ${job.status}`);
        const legs = [...job.gas, ...(job.asset ? [job.asset] : [])];
        if (legs.some((l) => l.attempts.some((a) => a.prepared))) {
          throw new BurnerError("validation", "a withdrawal was already signed; run the job to finish or sweep instead of cancelling");
        }
        if (job.burner) await deps.book.retire(job.burner.address);
        job.status = "cancelled";
        note(ctx, "cancelled");
        await save(ctx);
        return job;
      } finally {
        await release(ctx);
      }
    },

    get: async (id) => (await deps.store.get(id))?.job ?? null,
    list: async () => (await deps.store.list()).map((s: StoredJob) => s.job),
  };
}

function describe(a: BurnerAction): string {
  const asset = BURNER_ASSETS[a.asset];
  const amount = `${formatBaseUnits(a.amount, asset.decimals)} ${asset.symbol}`;
  return a.kind === "hold" ? `fund a fresh payout address with ${amount} plus gas` : `send ${amount} to ${a.to}`;
}
