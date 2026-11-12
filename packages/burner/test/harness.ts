/**
 * Test doubles for the burner engine: a 1Click that settles each deposit
 * address at most once (as intents.far accepts each nonce once), a Base
 * ledger that applies real signed transactions (parsed and sender-recovered
 * with viem), and crash injection before or after any outside call.
 *
 * The vault and address book are the real @shelter/keys code on a memory
 * store; only the network is simulated.
 */

import type { IntentsClient, IntentStatus, PreparedIntent, Quote, QuoteRequest, StatusResult } from "@shelter/intents";
import { createAddressBook, createMemoryStore, createSeedVault, type AddressBook, type SeedVault } from "@shelter/keys";
import { decodeFunctionData, erc20Abi, getAddress, keccak256, parseTransaction, recoverTransactionAddress, type Hex } from "viem";
import { BURNER_ASSETS } from "../src/assets.js";
import type { ChainClient, Receipt } from "../src/chain.js";
import { createBurnerEngine, type ApprovalRequest, type BurnerEngine, type EngineOptions } from "../src/engine.js";
import { createMemoryJobStore, type BurnerJob, type JobStore } from "../src/job.js";

export const OWNER = "owner.near";
export const PAYEE = getAddress("0x1111111111111111111111111111111111111111");
const USDC = BURNER_ASSETS.usdc.token!;
const ETH_ID = BURNER_ASSETS.eth.assetId;

export class Crash extends Error {
  override name = "Crash";
}

/** Counts every outside call; throws `Crash` at call number `at` (before or after its effect). */
export class Faults {
  calls = 0;
  /** Set when a crash fires: a dead process writes nothing more, not even its error handler. */
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
      this.at = Infinity; // one crash per scenario
      this.dead = true;
      throw new Crash(`crash ${phase} ${name} (#${this.calls})`);
    }
  }
}

export class Clock {
  t = Date.parse("2026-11-09T12:00:00.000Z");
  now = () => new Date(this.t);
  advance(ms: number) {
    this.t += ms;
  }
}

interface Settlement {
  quote: Quote;
  submitted: number;
  /** Distinct signed intents submitted for this address. Each one spends from the balance. */
  intents: Set<string>;
  reads: number;
  delivered: boolean;
  outcome?: "SUCCESS" | "REFUNDED" | "FAILED";
}

export interface WorldOptions {
  /** Deposit addresses (by quote order, 1-based) that 1Click refunds instead of delivering. */
  refundQuotes?: number[];
  /** Quotes (1-based) whose intent 1Click never executes (stays PENDING_DEPOSIT). */
  stallQuotes?: number[];
  /** Gas a transfer really uses on chain. */
  gasUsed?: bigint;
  /** Make the action revert on chain. */
  revertAction?: boolean;
  /** Extra USDC delivered to the burner on top of the asset leg (to force a sweep). */
  extraUsdc?: bigint;
}

/** Fake 1Click + Base, sharing one ledger. */
export class World {
  clock = new Clock();
  faults = new Faults();
  eth = new Map<string, bigint>();
  usdc = new Map<string, bigint>();
  nonces = new Map<string, number>();
  txs = new Map<string, { raw: Hex; receipt: Receipt }>();
  settlements = new Map<string, Settlement>();
  quotes = 0;
  private signatures = 0;
  submits = 0;
  broadcasts = 0;
  depositNotices: string[] = [];
  /** Total paid out of the confidential balance, per asset id. */
  spent = new Map<string, bigint>();
  /** Total refunded to the confidential balance. */
  refunded = new Map<string, bigint>();
  /** Total deposited into the confidential balance (sweeps). */
  returned = 0n;

  constructor(public opts: WorldOptions = {}) {}

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

  private quote(req: QuoteRequest): Quote {
    const n = ++this.quotes;
    const isWithdraw = req.depositType === "CONFIDENTIAL_INTENTS";
    const out = BigInt(req.amount);
    const fee = req.destinationAssetId === ETH_ID ? 1_120_000_000_000n : 4_800n;
    const amountIn = isWithdraw ? (req.destinationAssetId === req.originAssetId ? out + fee : 7_000n) : out;
    const depositAddress = isWithdraw ? `${n.toString(16).padStart(64, "a")}` : getAddress(`0x${n.toString(16).padStart(40, "d")}`);
    const deadline = new Date(this.clock.t + 30 * 60_000).toISOString();
    return {
      quoteId: `q${n}`,
      dry: req.dry ?? true,
      depositAddress: req.dry ? undefined : depositAddress,
      amountIn: amountIn.toString(),
      minAmountIn: amountIn.toString(),
      amountOut: out.toString(),
      minAmountOut: out.toString(),
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
      const n = Number(s.quote.quoteId.slice(1));
      if (s.outcome) status = s.outcome;
      else if (this.opts.stallQuotes?.includes(n)) status = "PENDING_DEPOSIT";
      else if (s.reads++ === 0) status = "PROCESSING";
      else if (this.opts.refundQuotes?.includes(n)) {
        s.outcome = status = "REFUNDED";
        this.add(this.refunded, s.quote.request.originAssetId, BigInt(s.quote.amountIn));
      } else {
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
    if (s.quote.request.recipientType === "CONFIDENTIAL_INTENTS") return; // a deposit lands in the balance, not on chain
    const to = getAddress(s.quote.request.recipient);
    const amt = BigInt(s.quote.amountOut);
    if (s.quote.request.destinationAssetId === ETH_ID) this.add(this.eth, to, amt);
    else this.add(this.usdc, to, amt + (this.opts.extraUsdc ?? 0n));
  }

  intents(): IntentsClient {
    const self = this;
    const c: Partial<IntentsClient> = {
      getQuote: (req) => self.f("getQuote", () => {
        const q = self.quote(req);
        if (q.depositAddress) self.settlements.set(q.depositAddress, { quote: q, submitted: 0, intents: new Set(), reads: 0, delivered: false });
        return q;
      }),
      prepareSignedIntent: (quote, signer, o = {}) =>
        self.f("prepareSignedIntent", async () => {
          const tokenId = `imt:t:${quote.request.originAssetId}`;
          const summary = { signerId: signer.accountId, deadline: new Date(self.clock.t + 3 * 86_400_000).toISOString(), transfers: [{ receiverId: quote.depositAddress!, tokenId, amount: quote.amountIn }] };
          if (o.approve && !(await o.approve(summary))) {
            const { IntentsError } = await import("@shelter/intents");
            throw new IntentsError("signer_rejected", "withdrawal was not approved");
          }
          const p: PreparedIntent = {
            depositAddress: quote.depositAddress!,
            // Every signature is a new intent with its own nonce.
            signedData: { standard: "nep413", payload: { message: "{}", nonce: `n${++self.signatures}`, recipient: "intents.far" }, public_key: "ed25519:k", signature: "ed25519:s" },
            summary,
            deadline: summary.deadline,
            quoteDeadline: quote.deadline!,
          };
          return p;
        }),
      submitSignedIntent: (prepared) =>
        self.f("submitSignedIntent", () => {
          const s = self.settlements.get(prepared.depositAddress)!;
          self.submits++;
          s.submitted++;
          const nonce = prepared.signedData.payload.nonce;
          // The same signed intent again is a no-op (nonce used once); a new one spends again.
          if (!s.intents.has(nonce)) {
            s.intents.add(nonce);
            self.add(self.spent, s.quote.request.originAssetId, BigInt(s.quote.amountIn));
          }
          return { intentHash: `ih-${prepared.depositAddress.slice(0, 6)}`, correlationId: "c" };
        }),
      status: (dep) => self.f("status", () => self.statusOf(dep)),
      waitForStatus: async (dep, o = {}) => {
        let st: StatusResult;
        for (let i = 0; ; i++) {
          st = await self.f("status", () => self.statusOf(dep));
          o.onUpdate?.(st);
          if (["SUCCESS", "REFUNDED", "FAILED"].includes(st.status) || i >= 5) return st;
          self.clock.advance(o.intervalMs ?? 5_000);
        }
      },
      submitDeposit: (quote, txHash) =>
        self.f("submitDeposit", () => {
          self.depositNotices.push(txHash);
          return self.statusOf(quote.depositAddress!);
        }),
    };
    return c as IntentsClient;
  }

  chain(): ChainClient {
    const self = this;
    const gasUsed = () => this.opts.gasUsed ?? 52_000n;
    return {
      chainId: 8453,
      nativeBalance: (a) => self.f("nativeBalance", () => self.eth.get(getAddress(a)) ?? 0n),
      tokenBalance: (_t, a) => self.f("tokenBalance", () => self.usdc.get(getAddress(a)) ?? 0n),
      nonce: (a) => self.f("nonce", () => self.nonces.get(getAddress(a)) ?? 0),
      fees: () => self.f("fees", () => ({ maxFeePerGas: 7_000_000n, maxPriorityFeePerGas: 1_000_000n })),
      estimateGas: () => self.f("estimateGas", () => gasUsed()),
      l1Fee: () => self.f("l1Fee", () => 400_000_000n),
      sendRaw: (raw) =>
        self.f("sendRaw", async () => {
          const hash = keccak256(raw);
          if (self.txs.has(hash)) throw new Error("already known");
          const tx = parseTransaction(raw);
          const from = getAddress(await recoverTransactionAddress({ serializedTransaction: raw as Hex & `0x02${string}` }));
          if ((self.nonces.get(from) ?? 0) !== tx.nonce) throw new Error("nonce too low");
          const fee = gasUsed() * 1_500_000n + 400_000_000n;
          const eth = self.eth.get(from) ?? 0n;
          if (eth < tx.gas! * tx.maxFeePerGas! + 400_000_000n) throw new Error("insufficient funds for gas");
          self.eth.set(from, eth - fee);
          self.nonces.set(from, tx.nonce! + 1);
          self.broadcasts++;
          let status: Receipt["status"] = "success";
          const d = decodeFunctionData({ abi: erc20Abi, data: tx.data! });
          const [to, amt] = d.args as [`0x${string}`, bigint];
          const bal = self.usdc.get(from) ?? 0n;
          const toDeposit = [...self.settlements.values()].find(
            (s) => s.quote.request.depositType === "ORIGIN_CHAIN" && s.quote.depositAddress?.toLowerCase() === to.toLowerCase(),
          );
          if (getAddress(tx.to!) !== USDC || bal < amt || (self.opts.revertAction && !toDeposit)) status = "reverted";
          else {
            self.usdc.set(from, bal - amt);
            if (toDeposit) {
              // An on-chain deposit: 1Click sees it as submitted.
              self.returned += amt;
              toDeposit.submitted++;
            }
            else self.add(self.usdc, getAddress(to), amt);
          }
          self.txs.set(hash, { raw, receipt: { status, blockNumber: 1000n + BigInt(self.txs.size), gasUsed: gasUsed(), feeWei: fee } });
          return hash;
        }),
      receipt: (h) => self.f("receipt", () => self.txs.get(h)?.receipt ?? null),
      knows: (h) => self.f("knows", () => self.txs.has(h)),
    };
  }
}

export interface Rig {
  world: World;
  store: JobStore;
  vault: SeedVault;
  book: AddressBook;
  approvals: ApprovalRequest[];
  engine(opts?: { approve?: (r: ApprovalRequest) => boolean; options?: Partial<EngineOptions> }): BurnerEngine;
}

export async function rig(opts: WorldOptions = {}): Promise<Rig> {
  const world = new World(opts);
  const keyStore = createMemoryStore();
  const vault = createSeedVault({ store: keyStore, kdf: { m: 19456, t: 2, p: 1 }, now: world.clock.now });
  await vault.importMnemonic("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about", "test-passphrase");
  const book = createAddressBook(vault);
  const inner = createMemoryJobStore();
  // Crashes may also hit right after a job write lands.
  const store: JobStore = {
    get: (id) => inner.get(id),
    list: () => inner.list(),
    create: (j) => inner.create(j),
    update: async (j, rev) => {
      if (world.faults.dead) throw new Crash("the process is dead");
      const r = await inner.update(j, rev);
      world.faults.hit("store.update", "before");
      world.faults.hit("store.update", "after");
      return r;
    },
  };
  const approvals: ApprovalRequest[] = [];
  return {
    world,
    store,
    vault,
    book,
    approvals,
    engine: (e = {}) =>
      createBurnerEngine({
        intents: world.intents(),
        vault,
        book,
        chain: world.chain(),
        store,
        owner: { accountId: OWNER, sign: () => Promise.reject(new Error("unused")) },
        approve: (r) => {
          approvals.push(r);
          return e.approve ? e.approve(r) : true;
        },
        now: world.clock.now,
        options: {
          sleep: async (ms) => world.clock.advance(ms),
          statusIntervalMs: 5_000,
          ...e.options,
        },
      }),
  };
}

/** Runs a job to the end, restarting with a fresh engine (as after a process crash) on each Crash. */
export async function runToEnd(r: Rig, id: string, maxRestarts = 10): Promise<{ job: BurnerJob; crashes: number }> {
  let crashes = 0;
  for (;;) {
    try {
      const job = await r.engine().run(id);
      return { job, crashes };
    } catch (e) {
      if (!(e instanceof Crash) || ++crashes > maxRestarts) throw e;
      r.world.faults.dead = false; // a new process
      r.world.clock.advance(11 * 60_000); // the dead runner's lease expires
    }
  }
}
