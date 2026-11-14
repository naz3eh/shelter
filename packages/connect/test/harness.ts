/**
 * Test world for Connect: a fake 1Click and a Base ledger that applies real
 * signed transactions (parsed and sender-recovered with viem). The ledger
 * knows ETH, ERC-20 transfers and approvals, and one dapp: a swap router
 * that pulls an approved token and pays another to a recipient named in
 * its calldata. Crashes can be injected before or after any outside call.
 *
 * The vault, address book, burner engine and Connect engine are the real
 * code on memory stores; only the network is simulated.
 */

import { BURNER_ASSETS, BurnerError, createBurnerEngine, createMemoryJobStore, type ApprovalRequest, type ChainClient, type JobStore, type Receipt } from "@shelter/burner";
import { IntentsError, type IntentsClient, type IntentStatus, type PreparedIntent, type Quote, type QuoteRequest, type StatusResult, type TokenInfo } from "@shelter/intents";
import { createAddressBook, createMemoryStore, createSeedVault, type AddressBook, type SeedVault } from "@shelter/keys";
import { decodeFunctionData, erc20Abi, getAddress, keccak256, parseAbi, parseTransaction, recoverTransactionAddress, type Hex } from "viem";
import { createMemoryAccountStore, type AccountStore, type ConnectAccount } from "../src/account.js";
import { createConnectEngine, type ConnectApproval, type ConnectEngine, type ConnectOptions } from "../src/engine.js";
import { buildIdentity, type Identity } from "../src/linkage.js";

export const OWNER = "owner.near";
export const ORIGIN = "https://app.swap.example";
export const MAIN = getAddress("0x00000000000000000000000000000000000a11ce");
export const ROUTER = getAddress("0x2626664c2603336e57b271c5c0b26f421741e481");
export const USDC = BURNER_ASSETS.usdc.token!;
export const OUT = getAddress("0x4ed4e862860bed51a9570b96d89af5e1b0efefed");
/** A token 1Click does not list: it cannot be swept back. */
export const UNLISTED = getAddress("0x9999999999999999999999999999999999999999");
const ETH_ID = BURNER_ASSETS.eth.assetId;
const USDC_ID = BURNER_ASSETS.usdc.assetId;
const OUT_ID = "nep141:base-0x4ed4e862860bed51a9570b96d89af5e1b0efefed.omft.near";

export const routerAbi = parseAbi(["function swap(address tokenIn, uint256 amountIn, address tokenOut, address recipient)"]);

const TOKENS: TokenInfo[] = [
  { assetId: USDC_ID, decimals: 6, blockchain: "base", symbol: "USDC", contractAddress: USDC },
  { assetId: OUT_ID, decimals: 18, blockchain: "base", symbol: "OUT", contractAddress: OUT },
  { assetId: ETH_ID, decimals: 18, blockchain: "base", symbol: "ETH" },
  { assetId: "nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near", decimals: 6, blockchain: "eth", symbol: "USDT", contractAddress: "0xdAC17F958D2ee523a2206206994597C13D831ec7" },
];
const MIN_DEPOSIT: Record<string, bigint> = { [USDC_ID]: 150_000n, [OUT_ID]: 1_000n, [ETH_ID]: 1_000_000_000_000n };

export class Crash extends Error {
  override name = "Crash";
}

export class Faults {
  calls = 0;
  dead = false;
  log: string[] = [];
  constructor(
    public at = Infinity,
    public phase: "before" | "after" = "before",
  ) {}
  hit(name: string, phase: "before" | "after") {
    if (phase === "before") {
      this.calls++;
      this.log.push(name);
    }
    if (this.calls === this.at && phase === this.phase) {
      this.at = Infinity;
      this.dead = true;
      throw new Crash(`crash ${phase} ${name} (#${this.calls})`);
    }
  }
}

export class Clock {
  t = Date.parse("2026-11-12T12:00:00.000Z");
  now = () => new Date(this.t);
  advance(ms: number) {
    this.t += ms;
  }
}

interface Settlement {
  quote: Quote;
  submitted: number;
  intents: Set<string>;
  reads: number;
  delivered: boolean;
  /** On-chain transfers into this deposit address (sweeps). */
  deposits: number;
  outcome?: IntentStatus;
}

export class World {
  clock = new Clock();
  faults = new Faults();
  eth = new Map<string, bigint>();
  tokens = new Map<string, Map<string, bigint>>();
  allowances = new Map<string, bigint>();
  nonces = new Map<string, number>();
  txs = new Map<string, { raw: Hex; receipt: Receipt }>();
  settlements = new Map<string, Settlement>();
  quotes = 0;
  private signatures = 0;
  broadcasts = 0;
  /** Paid out of the confidential balance, per asset id. */
  spent = new Map<string, bigint>();
  /** Swept back into the confidential balance, per asset id. */
  returned = new Map<string, bigint>();
  /** ERC-20 transfers made by the transaction being applied (its receipt's logs). */
  private transfers: NonNullable<Receipt["tokenTransfers"]> = [];
  /** Base fee for estimates; tests raise it to force top-ups. */
  maxFeePerGas = 7_000_000n;

  private f<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
    return (async () => {
      this.faults.hit(name, "before");
      const r = await fn();
      this.faults.hit(name, "after");
      return r;
    })();
  }

  private add(m: Map<string, bigint>, k: string, v: bigint) {
    m.set(k, (m.get(k) ?? 0n) + v);
  }

  bal(token: string, who: string): bigint {
    return this.tokens.get(getAddress(token))?.get(getAddress(who)) ?? 0n;
  }
  setBal(token: string, who: string, v: bigint) {
    const t = getAddress(token);
    if (!this.tokens.has(t)) this.tokens.set(t, new Map());
    this.tokens.get(t)!.set(getAddress(who), v);
  }

  private tokenOf(assetId: string): `0x${string}` | undefined {
    if (assetId === USDC_ID) return USDC;
    if (assetId === OUT_ID) return OUT;
    return undefined;
  }

  private quote(req: QuoteRequest): Quote {
    const isWithdraw = req.depositType === "CONFIDENTIAL_INTENTS";
    const amt = BigInt(req.amount);
    if (!isWithdraw && amt < (MIN_DEPOSIT[req.originAssetId] ?? 0n)) {
      throw new IntentsError("bad_request", "Amount is too low for bridge, try at least ...", { status: 400 });
    }
    const n = ++this.quotes;
    const fee = req.destinationAssetId === ETH_ID ? 1_120_000_000_000n : 4_800n;
    const amountIn = isWithdraw ? (req.destinationAssetId === req.originAssetId ? amt + fee : 7_000n + amt / 1_000_000_000n) : amt;
    const depositAddress = isWithdraw ? `${n.toString(16).padStart(64, "a")}` : getAddress(`0x${n.toString(16).padStart(40, "d")}`);
    const deadline = new Date(this.clock.t + 30 * 60_000).toISOString();
    return {
      quoteId: `q${n}`,
      dry: req.dry ?? true,
      depositAddress: req.dry ? undefined : depositAddress,
      amountIn: amountIn.toString(),
      minAmountIn: amountIn.toString(),
      amountOut: amt.toString(),
      minAmountOut: amt.toString(),
      amountInUsd: "0",
      amountOutUsd: "0",
      deadline,
      timeEstimateSec: 12,
      withdrawFee: isWithdraw ? fee.toString() : "0",
      refundFee: "0",
      confidentiality: "advanced",
      request: { slippageBps: 50, confidentiality: "advanced", dry: true, deadline, ...req } as Required<QuoteRequest>,
      provenance: { correlationId: `c${n}`, timestamp: deadline, signature: "ed25519:x", signatureVerified: true, signerPublicKey: "ed25519:y" },
      wire: {} as Quote["wire"],
    };
  }

  private statusOf(dep: string): StatusResult {
    const s = this.settlements.get(dep);
    let status: IntentStatus = "PENDING_DEPOSIT";
    if (s && s.submitted > 0) {
      if (s.outcome) status = s.outcome;
      else if (s.reads++ === 0) status = "PROCESSING";
      else {
        s.outcome = status = "SUCCESS";
        this.deliver(s);
      }
    }
    return {
      depositAddress: dep,
      status,
      rawStatus: status,
      txHashes: [],
      originChainTxs: [],
      destinationChainTxs: [],
      nearTxHashes: [],
      intentHashes: s?.submitted ? [`ih-${dep.slice(0, 6)}`] : [],
      updatedAt: this.clock.now().toISOString(),
      correlationId: "c",
      quoteVerified: true,
    };
  }

  private deliver(s: Settlement) {
    if (s.delivered) throw new Error("BUG: settled twice");
    s.delivered = true;
    const q = s.quote;
    if (q.request.recipientType === "CONFIDENTIAL_INTENTS") {
      this.add(this.returned, q.request.originAssetId, BigInt(q.amountIn));
      return;
    }
    const to = getAddress(q.request.recipient);
    const amt = BigInt(q.amountOut);
    const token = this.tokenOf(q.request.destinationAssetId);
    if (token) this.setBal(token, to, this.bal(token, to) + amt);
    else this.add(this.eth, to, amt);
  }

  intents(): IntentsClient {
    const self = this;
    const c: Partial<IntentsClient> = {
      tokens: () => self.f("tokens", () => TOKENS),
      getQuote: (req) =>
        self.f("getQuote", () => {
          const q = self.quote(req);
          if (q.depositAddress) self.settlements.set(q.depositAddress.toLowerCase(), { quote: q, submitted: 0, intents: new Set(), reads: 0, delivered: false, deposits: 0 });
          return q;
        }),
      prepareSignedIntent: (quote, signer, o = {}) =>
        self.f("prepareSignedIntent", async () => {
          const summary = {
            signerId: signer.accountId,
            deadline: new Date(self.clock.t + 3 * 86_400_000).toISOString(),
            transfers: [{ receiverId: quote.depositAddress!, tokenId: `imt:t:${quote.request.originAssetId}`, amount: quote.amountIn }],
          };
          if (o.approve && !(await o.approve(summary))) throw new IntentsError("signer_rejected", "withdrawal was not approved");
          const p: PreparedIntent = {
            depositAddress: quote.depositAddress!,
            signedData: { standard: "nep413", payload: { message: "{}", nonce: `n${++self.signatures}`, recipient: "intents.far" }, public_key: "ed25519:k", signature: "ed25519:s" },
            summary,
            deadline: summary.deadline,
            quoteDeadline: quote.deadline!,
          };
          return p;
        }),
      submitSignedIntent: (prepared) =>
        self.f("submitSignedIntent", () => {
          const s = self.settlements.get(prepared.depositAddress.toLowerCase())!;
          s.submitted++;
          const nonce = prepared.signedData.payload.nonce;
          if (!s.intents.has(nonce)) {
            s.intents.add(nonce);
            self.add(self.spent, s.quote.request.originAssetId, BigInt(s.quote.amountIn));
          }
          return { intentHash: `ih-${prepared.depositAddress.slice(0, 6)}`, correlationId: "c" };
        }),
      status: (dep) => self.f("status", () => self.statusOf(dep.toLowerCase())),
      waitForStatus: async (dep, o = {}) => {
        let st: StatusResult;
        for (let i = 0; ; i++) {
          st = await self.f("status", () => self.statusOf(dep.toLowerCase()));
          o.onUpdate?.(st);
          if (["SUCCESS", "REFUNDED", "FAILED"].includes(st.status) || i >= 5) return st;
          self.clock.advance(o.intervalMs ?? 5_000);
        }
      },
      submitDeposit: (quote) => self.f("submitDeposit", () => self.statusOf(quote.depositAddress!.toLowerCase())),
    };
    return c as IntentsClient;
  }

  /** Applies a call's state change, or returns why it reverts. Pure check when `dry`. */
  private apply(from: string, to: string, data: Hex | undefined, value: bigint, dry: boolean): string | null {
    const eth = this.eth.get(from) ?? 0n;
    if (eth < value) return "insufficient funds for transfer";
    const credit = (who: string, v: bigint) => !dry && this.add(this.eth, getAddress(who), v);
    const depositTo = (addr: string) => this.settlements.get(addr.toLowerCase());
    if (!data || data === "0x") {
      if (!dry) {
        this.eth.set(from, eth - value);
        const dep = depositTo(to);
        if (dep && dep.quote.request.depositType === "ORIGIN_CHAIN") {
          if (dep.quote.request.originAssetId !== ETH_ID || BigInt(dep.quote.amountIn) !== value) throw new Error("BUG: wrong ETH deposit");
          dep.deposits++;
          dep.submitted++;
        } else credit(to, value);
      }
      return null;
    }
    if (value > 0n) return "this test ledger does not take ETH with calls";
    if (to === ROUTER) {
      const d = decodeFunctionData({ abi: routerAbi, data });
      const [tokenIn, amountIn, tokenOut, recipient] = d.args;
      const key = `${getAddress(tokenIn)}:${from}:${ROUTER}`;
      if ((this.allowances.get(key) ?? 0n) < amountIn) return "execution reverted: allowance";
      if (this.bal(tokenIn, from) < amountIn) return "execution reverted: balance";
      if (!dry) {
        this.allowances.set(key, this.allowances.get(key)! - amountIn);
        this.setBal(tokenIn, from, this.bal(tokenIn, from) - amountIn);
        this.setBal(tokenOut, recipient, this.bal(tokenOut, recipient) + amountIn * 3n);
        this.transfers.push({ token: getAddress(tokenIn), from: getAddress(from), to: ROUTER }, { token: getAddress(tokenOut), from: ROUTER, to: getAddress(recipient) });
      }
      return null;
    }
    if ([USDC, OUT, UNLISTED].includes(to as `0x${string}`)) {
      const d = decodeFunctionData({ abi: erc20Abi, data });
      if (d.functionName === "approve") {
        if (!dry) this.allowances.set(`${to}:${from}:${getAddress(d.args[0])}`, d.args[1]);
        return null;
      }
      if (d.functionName === "transfer") {
        const [rcpt, amt] = d.args;
        if (this.bal(to, from) < amt) return "execution reverted: balance";
        if (!dry) {
          this.setBal(to, from, this.bal(to, from) - amt);
          this.transfers.push({ token: getAddress(to), from: getAddress(from), to: getAddress(rcpt) });
          const dep = depositTo(rcpt);
          if (dep && dep.quote.request.depositType === "ORIGIN_CHAIN") {
            if (this.tokenOf(dep.quote.request.originAssetId) !== to || BigInt(dep.quote.amountIn) !== amt) throw new Error("BUG: wrong token deposit");
            dep.deposits++;
            dep.submitted++;
          } else this.setBal(to, rcpt, this.bal(to, rcpt) + amt);
        }
        return null;
      }
      return "execution reverted: unsupported token call";
    }
    return "execution reverted: no contract";
  }

  chain(): ChainClient {
    const self = this;
    const used = 100_000n;
    return {
      chainId: 8453,
      nativeBalance: (a) => self.f("nativeBalance", () => self.eth.get(getAddress(a)) ?? 0n),
      tokenBalance: (t, a) => self.f("tokenBalance", () => self.bal(t, a)),
      nonce: (a) => self.f("nonce", () => self.nonces.get(getAddress(a)) ?? 0),
      fees: () => self.f("fees", () => ({ maxFeePerGas: self.maxFeePerGas, maxPriorityFeePerGas: 1_000_000n })),
      estimateGas: (tx) =>
        self.f("estimateGas", () => {
          const why = self.apply(getAddress(tx.from), getAddress(tx.to), tx.data, tx.value ?? 0n, true);
          if (why) throw new BurnerError("chain", `Base RPC: estimateGas failed: ${why}`);
          return !tx.data || tx.data === "0x" ? 21_000n : used;
        }),
      l1Fee: () => self.f("l1Fee", () => 400_000_000n),
      sendRaw: (raw) =>
        self.f("sendRaw", () => self.send(raw).catch((e: unknown) => {
          throw e instanceof Crash ? e : new BurnerError("chain", `Base RPC: sendRawTransaction failed: ${e instanceof Error ? e.message : String(e)}`);
        })),
      receipt: (h) => self.f("receipt", () => self.txs.get(h)?.receipt ?? null),
      knows: (h) => self.f("knows", () => self.txs.has(h)),
    };
  }

  private async send(raw: Hex): Promise<Hex> {
    const self = this;
    const used = 100_000n;
    const hash = keccak256(raw);
    if (self.txs.has(hash)) throw new Error("already known");
    const tx = parseTransaction(raw);
    if (tx.chainId !== 8453) throw new Error("wrong chain");
    const from = getAddress(await recoverTransactionAddress({ serializedTransaction: raw as Hex & `0x02${string}` }));
    if ((self.nonces.get(from) ?? 0) !== tx.nonce) throw new Error("nonce too low");
    const eth = self.eth.get(from) ?? 0n;
    if (eth < tx.gas! * tx.maxFeePerGas! + 400_000_000n + (tx.value ?? 0n)) throw new Error("insufficient funds for gas * price + value");
    const gasUsed = !tx.data || tx.data === "0x" ? 21_000n : used;
    const fee = gasUsed * 1_500_000n + 400_000_000n;
    self.eth.set(from, eth - fee);
    self.nonces.set(from, tx.nonce! + 1);
    self.broadcasts++;
    self.transfers = [];
    const why = self.apply(from, getAddress(tx.to!), tx.data, tx.value ?? 0n, false);
    const tokenTransfers = why ? [] : self.transfers;
    self.txs.set(hash, { raw, receipt: { status: why ? "reverted" : "success", blockNumber: 2000n + BigInt(self.txs.size), gasUsed, feeWei: fee, tokenTransfers } });
    return hash;
  }

}

export interface Rig {
  world: World;
  vault: SeedVault;
  book: AddressBook;
  jobs: JobStore;
  accounts: AccountStore;
  approvals: (ConnectApproval | ApprovalRequest)[];
  /** Answer per approval; default yes. */
  answer: (a: ConnectApproval | ApprovalRequest) => boolean;
  identity: Identity;
  engine(options?: Partial<ConnectOptions>): ConnectEngine;
}

export async function rig(): Promise<Rig> {
  const world = new World();
  const vault = createSeedVault({ store: createMemoryStore(), kdf: { m: 19456, t: 2, p: 1 }, now: world.clock.now });
  await vault.importMnemonic("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about", "test-passphrase");
  const book = createAddressBook(vault);
  const dying = <S extends { update: (...a: never[]) => Promise<unknown> }>(inner: S): S => ({
    ...inner,
    update: async (...args: Parameters<S["update"]>) => {
      if (world.faults.dead) throw new Crash("the process is dead");
      const r = await (inner.update as (...a: unknown[]) => Promise<unknown>)(...args);
      world.faults.hit("store.update", "before");
      world.faults.hit("store.update", "after");
      return r;
    },
  });
  const jobs = dying(createMemoryJobStore());
  const accounts = dying(createMemoryAccountStore());
  const r: Rig = {
    world,
    vault,
    book,
    jobs,
    accounts,
    approvals: [],
    answer: () => true,
    identity: buildIdentity({ evm: [[MAIN, "your main wallet"]], near: ["carol.near"] }),
    engine: (options = {}) => {
      const ask = (a: ConnectApproval | ApprovalRequest) => {
        r.approvals.push(a);
        return r.answer(a);
      };
      const intents = world.intents();
      const chain = world.chain();
      const burner = createBurnerEngine({
        intents,
        vault,
        book,
        chain,
        store: jobs,
        owner: { accountId: OWNER, sign: () => Promise.reject(new Error("unused")) },
        approve: ask,
        now: world.clock.now,
        options: { sleep: async (ms) => world.clock.advance(ms) },
      });
      return createConnectEngine({
        burner,
        vault,
        book,
        chain,
        intents,
        store: accounts,
        owner: OWNER,
        linked: () => r.identity,
        approve: ask,
        now: world.clock.now,
        options: { sleep: async (ms) => world.clock.advance(ms), ...options },
      });
    },
  };
  return r;
}

/** Opens an account for ORIGIN with a USDC budget and funds it. */
export async function opened(r: Rig, budget = "5000000", gasWei?: string): Promise<ConnectAccount> {
  const e = r.engine();
  const a = await e.open({ dapp: { origin: ORIGIN, name: "Swap" }, budget: { asset: "usdc", amount: budget, payWith: "usdc" }, ...(gasWei ? { gasWei } : {}) });
  return e.fund(a.id);
}

/** Runs `fn` with a fresh engine after every Crash, as a restarted process would. */
export async function untilDone<T>(
  r: Rig,
  fn: (e: ConnectEngine) => Promise<T>,
  maxRestarts = 10,
  /** Runs before each restart; a test uses it to break the engine on purpose. */
  onRestart?: () => Promise<void>,
): Promise<{ value: T; crashes: number }> {
  let crashes = 0;
  for (;;) {
    try {
      return { value: await fn(r.engine()), crashes };
    } catch (e) {
      if (!(e instanceof Crash) || ++crashes > maxRestarts) throw e;
      r.world.faults.dead = false;
      r.world.clock.advance(11 * 60_000); // a dead burner runner's lease expires
      await onRestart?.();
    }
  }
}
