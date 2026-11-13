/**
 * Builds lib/fixtures/connect-recording.json, the "Recorded session" the web
 * demo replays.
 *
 * The four Base transactions are the real ones from the Shelter Connect
 * session documented in docs/backend/CONNECT.md (Uniswap on Base, 2026-11-12):
 * their raw bytes, nonces, receipts and hashes are public chain data. Quotes,
 * NEP-413 withdrawal intents and the NEAR-side deposit addresses are rebuilt
 * here and signed with a fixture ed25519 key whose public half is recorded in
 * each quote's provenance and each intent's public_key, so every offline
 * check the web app runs (quote signature, NEP-413 signature, tx hash and
 * sender, linkage re-check, sweep shape) verifies for real.
 *
 * The linked main wallet is a deterministic placeholder, not the real
 * address; the NEAR owner is a stand-in account id. Neither is the session's
 * real identity.
 *
 * Run: pnpm --filter web exec tsx scripts/build-connect-fixture.ts
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58, base64 } from "@scure/base";
import {
  encodeFunctionData,
  erc20Abi,
  getAddress,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  stringToHex,
  type Hex,
} from "viem";
import {
  CONFIDENTIAL_INTENTS_CONTRACT,
  CONFIDENTIAL_INTENTS_SALT,
  confidentialTokenId,
  encodeVersionedNonce,
  formatBaseUnits,
  nep413Hash,
  quoteDigest,
  timestampedRandomBytes,
  verifyNep413,
  verifyQuoteSignature,
  type IntentStatus,
  type PreparedIntent,
  type Quote,
  type QuoteRequest,
  type SubmittedIntent,
  type WireQuoteResponse,
} from "@shelter/intents";
import {
  BURNER_ASSETS,
  type BurnerJob,
  type FundingAttempt,
  type FundingLeg,
  type SignedTx,
} from "@shelter/burner";
import {
  blocks,
  buildIdentity,
  describeRequest,
  inspect,
  parseRequest,
  type ConnectAccount,
  type Finding,
  type RequestRecord,
  type SweepItem,
} from "@shelter/connect";

// ---------- public facts from docs/backend/CONNECT.md ----------

const OWNER = "shelter-demo.near";
const DAPP_ORIGIN = "https://app.uniswap.org";
const DAPP_NAME = "Uniswap";
/** The session's per-dapp Base address; public as the sender of the txs below. */
const DAPP = getAddress("0xe5bdd0651273b78b536fa027031ab65301d3ff9b");
const USDC = getAddress("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
const USDC_ASSET = BURNER_ASSETS.usdc.assetId;
const ETH_ASSET = BURNER_ASSETS.eth.assetId;
const PERMIT2 = getAddress("0x000000000022D473030F116dDEE9F6B43aC78BA3");

const TX_APPROVE = "0x585db734409d91ac9d042184c78f912b7b4c66fdd02cbf48839002daf6b207e9";
const TX_SWAP = "0x275f09eb16cd56aa956b3c197b79e21cb56bb4eb6ea3ef13ed88b89818e52f60";
const TX_SWEEP_USDC = "0xb349eb79941c5384c8bcd41b9b38f27e757ec463e9103916ea0afbb7c15bef6e";
const TX_SWEEP_ETH = "0xf06540278420fa2b906e1d9cacfb1162ee6a02f7b793c23274b45d2064171f7d";

/** Real 1Click Base deposit addresses the sweep transactions paid. */
const DEPOSIT_USDC = getAddress("0xF1054d05b2F5c02DB18bD953D35a5bA4FCDEF9aa");
const DEPOSIT_ETH = getAddress("0xb7d64ebcefecb2c235a26df0d4981963e3b8aaae");

// ---------- fixture-only identities (not the session's real ones) ----------

/** Stand-in for the user's linked main wallet. Deterministic, not a real address. */
const MAIN_WALLET = getAddress(
  `0x${keccak256(stringToHex("shelter connect demo fixture: main wallet")).slice(-40)}`,
);

// ---------- fixture signing key ----------

const SEED = sha256(new TextEncoder().encode("shelter connect web fixture ed25519 key v1"));
const PUB = ed25519.getPublicKey(SEED);
const PUB_KEY = `ed25519:${base58.encode(PUB)}`;
const sign = (msg: Uint8Array) => `ed25519:${base58.encode(ed25519.sign(msg, SEED))}`;

// ---------- tx inputs ----------

interface TxInput {
  raw: Hex;
  nonce: number;
  gas: string;
  maxFeePerGas: string;
  receipt: { status: "success" | "reverted"; blockNumber: string; gasUsed: string; feeWei: string };
}
const TXS = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "txs.json"), "utf8"),
) as Record<string, TxInput>;

function signedTx(hash: string, description: string, signedAt: string, broadcastAt: string): SignedTx & { value: string } {
  const t = TXS[hash];
  if (!t) throw new Error(`missing tx ${hash}`);
  const p = parseTransaction(t.raw);
  return {
    raw: t.raw,
    hash: hash as Hex,
    nonce: t.nonce,
    gas: BigInt(t.gas).toString(),
    maxFeePerGas: BigInt(t.maxFeePerGas).toString(),
    to: getAddress(p.to!),
    value: (p.value ?? 0n).toString(),
    description,
    signedAt,
    broadcastAt,
    receipt: {
      status: t.receipt.status,
      blockNumber: BigInt(t.receipt.blockNumber).toString(),
      gasUsed: BigInt(t.receipt.gasUsed).toString(),
      feeWei: t.receipt.feeWei,
    },
  };
}

async function senderOf(tx: SignedTx): Promise<string> {
  return recoverTransactionAddress({ serializedTransaction: tx.raw as Hex & `0x02${string}` });
}

// ---------- quotes ----------

interface QuoteSpec {
  id: string;
  at: string;
  request: Omit<Required<QuoteRequest>, "slippageBps" | "confidentiality" | "dry" | "deadline"> & {
    slippageBps?: number;
    deadline?: string;
  };
  depositAddress: string;
  amountIn: string;
  minAmountIn: string;
  amountOut: string;
  minAmountOut: string;
  amountInUsd: string;
  amountOutUsd: string;
  timeEstimate: number;
  timeWhenInactive?: string;
  refundFee?: string;
  withdrawFee?: string;
}

const decOf = (assetId: string) =>
  assetId === USDC_ASSET ? 6 : assetId === ETH_ASSET ? 18 : 0;

function buildQuote(spec: QuoteSpec): Quote {
  const deadline = spec.request.deadline ?? new Date(Date.parse(spec.at) + 30 * 60_000).toISOString();
  const request: Required<QuoteRequest> = {
    ...spec.request,
    slippageBps: spec.request.slippageBps ?? 50,
    confidentiality: "advanced",
    dry: false,
    deadline,
  };
  const echo = {
    dry: false,
    swapType: request.swapType,
    slippageTolerance: request.slippageBps,
    originAsset: request.originAssetId,
    depositType: request.depositType,
    destinationAsset: request.destinationAssetId,
    amount: request.amount,
    refundTo: request.refundTo,
    refundType: request.refundType,
    recipient: request.recipient,
    recipientType: request.recipientType,
    deadline,
    confidentiality: "advanced" as const,
  };
  const wireQuote = {
    depositAddress: spec.depositAddress,
    amountIn: spec.amountIn,
    amountInFormatted: formatBaseUnits(spec.amountIn, decOf(request.originAssetId)),
    amountInUsd: spec.amountInUsd,
    minAmountIn: spec.minAmountIn,
    amountOut: spec.amountOut,
    amountOutFormatted: formatBaseUnits(spec.amountOut, decOf(request.destinationAssetId)),
    amountOutUsd: spec.amountOutUsd,
    minAmountOut: spec.minAmountOut,
    deadline,
    timeWhenInactive: spec.timeWhenInactive ?? new Date(Date.parse(spec.at) + 24 * 3600_000).toISOString(),
    timeEstimate: spec.timeEstimate,
    refundFee: spec.refundFee,
    withdrawFee: spec.withdrawFee,
  };
  const wire = {
    correlationId: spec.id,
    timestamp: spec.at,
    signature: "",
    quoteRequest: echo,
    quote: wireQuote,
  } as unknown as WireQuoteResponse;
  const signature = sign(new TextEncoder().encode(quoteDigest(wire)));
  wire.signature = signature;
  const quote: Quote = {
    quoteId: spec.id,
    dry: false,
    depositAddress: spec.depositAddress,
    amountIn: spec.amountIn,
    minAmountIn: spec.minAmountIn,
    amountOut: spec.amountOut,
    minAmountOut: spec.minAmountOut,
    amountInUsd: spec.amountInUsd,
    amountOutUsd: spec.amountOutUsd,
    deadline,
    timeWhenInactive: wireQuote.timeWhenInactive,
    timeEstimateSec: spec.timeEstimate,
    withdrawFee: spec.withdrawFee,
    refundFee: spec.refundFee,
    confidentiality: "advanced",
    request,
    provenance: {
      correlationId: spec.id,
      timestamp: spec.at,
      signature,
      signatureVerified: true,
      signerPublicKey: PUB_KEY,
    },
    wire,
  };
  if (!verifyQuoteSignature(wire, PUB_KEY)) throw new Error(`quote ${spec.id} signature does not verify`);
  return quote;
}

// ---------- NEP-413 withdrawal intents ----------

const FIXED_RANDOM = new Uint8Array([0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77]);

function makePrepared(quote: Quote, tokenId: string, amount: string, at: Date): PreparedIntent {
  const deadline = new Date(at.getTime() + 3 * 24 * 3600_000);
  const message = JSON.stringify({
    deadline: deadline.toISOString(),
    intents: [
      {
        intent: "transfer",
        receiver_id: quote.depositAddress,
        tokens: { [tokenId]: amount },
      },
    ],
    signer_id: OWNER,
  });
  const nonce = encodeVersionedNonce(
    CONFIDENTIAL_INTENTS_SALT,
    deadline,
    timestampedRandomBytes(at, () => FIXED_RANDOM),
  );
  const payload = { message, nonce, recipient: CONFIDENTIAL_INTENTS_CONTRACT };
  const signature = sign(nep413Hash(payload));
  const signedData = {
    standard: "nep413" as const,
    payload: { message, nonce: base64.encode(nonce), recipient: CONFIDENTIAL_INTENTS_CONTRACT },
    public_key: PUB_KEY,
    signature,
  };
  if (!verifyNep413(payload, PUB_KEY, signature)) throw new Error("NEP-413 self-check failed");
  return {
    depositAddress: quote.depositAddress!,
    signedData,
    summary: {
      signerId: OWNER,
      deadline: deadline.toISOString(),
      transfers: [{ receiverId: quote.depositAddress!, tokenId, amount }],
    },
    deadline: deadline.toISOString(),
    quoteDeadline: quote.deadline!,
  };
}

function makeAttempt(
  quote: Quote,
  tokenId: string,
  amount: string,
  at: string,
  statusAt: string,
): FundingAttempt {
  const prepared = makePrepared(quote, tokenId, amount, new Date(at));
  const submitted: SubmittedIntent & { at: string } = {
    intentHash: keccak256(stringToHex(`${quote.quoteId}:${prepared.signedData.payload.nonce}`)),
    correlationId: quote.quoteId,
    at: new Date(Date.parse(at) + 5_000).toISOString(),
  };
  return {
    quote,
    prepared,
    submitted,
    status: "SUCCESS" as IntentStatus,
    statusAt,
    outcome: "delivered",
  };
}

// ---------- session timeline (block times from the receipts) ----------

const T = {
  open: "2026-11-12T16:35:00.000Z",
  funded: "2026-11-12T16:36:40.000Z",
  reqApprove: "2026-11-12T16:37:55.000Z",
  reqSwap: "2026-11-12T16:38:32.000Z",
  reqBlocked: "2026-11-12T16:39:05.000Z",
  sweepStart: "2026-11-12T16:44:00.000Z",
  closed: "2026-11-12T16:47:00.000Z",
  recorded: "2026-11-12T16:50:00.000Z",
};
const iso = (s: string) => new Date(s).toISOString();

// ---------- funding quotes (confidential balance -> dapp address) ----------

/** NEAR-side deposit address for a CONFIDENTIAL_INTENTS quote: deterministic 64-hex implicit account. */
const nearDeposit = (label: string) => keccak256(stringToHex(`shelter connect fixture deposit ${label}`)).slice(2);

const GAS_WEI = "270000000000000"; // 0.00027 ETH opening gas
const BUDGET_USDC = "1000000"; // 1 USDC

const quoteGas = buildQuote({
  id: "cqr_gas_01",
  at: "2026-11-12T16:36:00.000Z",
  request: {
    originAssetId: USDC_ASSET,
    destinationAssetId: ETH_ASSET,
    swapType: "EXACT_OUTPUT",
    amount: GAS_WEI,
    depositType: "CONFIDENTIAL_INTENTS",
    recipient: DAPP,
    recipientType: "DESTINATION_CHAIN",
    refundTo: OWNER,
    refundType: "CONFIDENTIAL_INTENTS",
    deadline: "2026-11-12T17:06:00.000Z",
  },
  depositAddress: nearDeposit("gas"),
  amountIn: "16200000", // ~16.2 USDC pays for 0.00027 ETH at ~$3000
  minAmountIn: "16200000",
  amountOut: GAS_WEI,
  minAmountOut: "265500000000000",
  amountInUsd: "16.20",
  amountOutUsd: "0.81",
  timeEstimate: 25,
  refundFee: "162000",
});

const quoteAsset = buildQuote({
  id: "cqr_asset_01",
  at: "2026-11-12T16:36:05.000Z",
  request: {
    originAssetId: USDC_ASSET,
    destinationAssetId: USDC_ASSET,
    swapType: "EXACT_OUTPUT",
    amount: BUDGET_USDC,
    depositType: "CONFIDENTIAL_INTENTS",
    recipient: DAPP,
    recipientType: "DESTINATION_CHAIN",
    refundTo: OWNER,
    refundType: "CONFIDENTIAL_INTENTS",
    deadline: "2026-11-12T17:06:05.000Z",
  },
  depositAddress: nearDeposit("asset"),
  amountIn: "1010000", // 1.01 USDC in for exactly 1 USDC out
  minAmountIn: "1010000",
  amountOut: BUDGET_USDC,
  minAmountOut: "995000",
  amountInUsd: "1.01",
  amountOutUsd: "1.00",
  timeEstimate: 20,
  refundFee: "10100",
});

const gasLeg: FundingLeg = {
  asset: "eth",
  payWith: "usdc",
  amount: GAS_WEI,
  balanceBefore: "0",
  attempts: [makeAttempt(quoteGas, confidentialTokenId(USDC_ASSET), quoteGas.amountIn, "2026-11-12T16:36:10.000Z", "2026-11-12T16:36:38.000Z")],
  confirmedBalance: GAS_WEI,
};

const assetLeg: FundingLeg = {
  asset: "usdc",
  amount: BUDGET_USDC,
  balanceBefore: "0",
  attempts: [makeAttempt(quoteAsset, confidentialTokenId(USDC_ASSET), quoteAsset.amountIn, "2026-11-12T16:36:15.000Z", "2026-11-12T16:36:39.000Z")],
  confirmedBalance: BUDGET_USDC,
};

// ---------- sweep quotes (dapp address -> confidential balance) ----------

const SWEEP_USDC_AMOUNT = "500000"; // 0.5 USDC
const quoteSweepUsdc = buildQuote({
  id: "cqr_sweep_usdc",
  at: "2026-11-12T16:44:10.000Z",
  request: {
    originAssetId: USDC_ASSET,
    destinationAssetId: USDC_ASSET,
    swapType: "EXACT_INPUT",
    amount: SWEEP_USDC_AMOUNT,
    depositType: "ORIGIN_CHAIN",
    recipient: OWNER,
    recipientType: "CONFIDENTIAL_INTENTS",
    refundTo: OWNER,
    refundType: "CONFIDENTIAL_INTENTS",
    deadline: "2026-11-12T17:14:10.000Z",
  },
  depositAddress: DEPOSIT_USDC,
  amountIn: SWEEP_USDC_AMOUNT,
  minAmountIn: SWEEP_USDC_AMOUNT,
  amountOut: "499000",
  minAmountOut: "497000",
  amountInUsd: "0.50",
  amountOutUsd: "0.499",
  timeEstimate: 55,
  refundFee: "500",
});

const txSweepUsdc = signedTx(
  TX_SWEEP_USDC,
  "return 0.5 USDC to the confidential balance",
  "2026-11-12T16:45:20.000Z",
  "2026-11-12T16:45:28.000Z",
);
if (txSweepUsdc.to !== USDC) throw new Error("USDC sweep tx does not call the USDC contract");

const txSweepEthRaw = signedTx(
  TX_SWEEP_ETH,
  "", // description set after the amount is known
  "2026-11-12T16:45:40.000Z",
  "2026-11-12T16:45:50.000Z",
);
const ETH_SWEEP_VALUE = txSweepEthRaw.value;
const ETH_SWEEP_BALANCE = "269000000000000"; // balance read at sweep time (value + fee headroom)

const quoteSweepEth = buildQuote({
  id: "cqr_sweep_eth",
  at: "2026-11-12T16:44:15.000Z",
  request: {
    originAssetId: ETH_ASSET,
    destinationAssetId: ETH_ASSET,
    swapType: "EXACT_INPUT",
    amount: ETH_SWEEP_VALUE,
    depositType: "ORIGIN_CHAIN",
    recipient: OWNER,
    recipientType: "CONFIDENTIAL_INTENTS",
    refundTo: OWNER,
    refundType: "CONFIDENTIAL_INTENTS",
    deadline: "2026-11-12T17:14:15.000Z",
  },
  depositAddress: DEPOSIT_ETH,
  amountIn: ETH_SWEEP_VALUE,
  minAmountIn: ETH_SWEEP_VALUE,
  amountOut: "268000000000000",
  minAmountOut: "266000000000000",
  amountInUsd: "0.81",
  amountOutUsd: "0.80",
  timeEstimate: 50,
  refundFee: "268276874850",
});
txSweepEthRaw.description = `return ${formatBaseUnits(ETH_SWEEP_VALUE, 18)} ETH to the confidential balance`;
if (txSweepEthRaw.to !== DEPOSIT_ETH) {
  throw new Error(`ETH sweep tx pays ${txSweepEthRaw.to}, not the recorded deposit address ${DEPOSIT_ETH}`);
}

// ---------- dapp requests ----------

const txApprove = signedTx(
  TX_APPROVE,
  "", // set from describeRequest below
  "2026-11-12T16:38:10.000Z",
  "2026-11-12T16:38:18.000Z",
);
const txSwap = signedTx(
  TX_SWAP,
  "",
  "2026-11-12T16:38:35.000Z",
  "2026-11-12T16:38:38.000Z",
);

const approveP = parseTransaction(txApprove.raw);
const swapP = parseTransaction(txSwap.raw);
const approveData = approveP.data!;
const swapData = swapP.data!;

const blockedData = encodeFunctionData({
  abi: erc20Abi,
  functionName: "transfer",
  args: [MAIN_WALLET, 100_000n],
});

const identity = buildIdentity({
  evm: [[MAIN_WALLET, "your main wallet"]],
  // The replay adds the confidential-balance owner to the NEAR side; match it.
  near: [OWNER],
});
const ctx = { self: DAPP, identity, origin: DAPP_ORIGIN };

function requestRecord(
  seq: number,
  at: string,
  method: string,
  params: unknown[],
  decision: RequestRecord["decision"],
  tx?: SignedTx & { value: string },
): RequestRecord {
  const req = parseRequest(method, params);
  const findings: Finding[] = inspect(req, ctx);
  const summary = describeRequest(req);
  if (tx) tx.description = summary;
  return {
    seq,
    at,
    rpcId: String(seq),
    method,
    origin: DAPP_ORIGIN,
    summary,
    params,
    findings,
    decision,
    ...(tx ? { tx } : {}),
  };
}

const requests: RequestRecord[] = [
  requestRecord(
    1,
    T.reqApprove,
    "eth_sendTransaction",
    [{ from: DAPP, to: USDC, data: approveData, value: "0x0" }],
    "sent",
    txApprove,
  ),
  requestRecord(
    2,
    T.reqSwap,
    "eth_sendTransaction",
    [{ from: DAPP, to: swapP.to ? getAddress(swapP.to) : undefined, data: swapData, value: "0x0" }],
    "sent",
    txSwap,
  ),
  requestRecord(
    3,
    T.reqBlocked,
    "eth_sendTransaction",
    [{ from: DAPP, to: USDC, data: blockedData, value: "0x0" }],
    "blocked",
  ),
];

// The blocked request must actually block, and name the placeholder wallet.
const blockedReq = requests[2]!;
if (blockedReq.decision !== "blocked") throw new Error("unreachable");
if (!blocks(blockedReq.findings).some((f) => f.code === "calldata_linked")) {
  throw new Error(`blocked request did not produce calldata_linked: ${JSON.stringify(blockedReq.findings)}`);
}
if (!blocks(blockedReq.findings).some((f) => f.message.toLowerCase().includes(MAIN_WALLET.toLowerCase()))) {
  throw new Error("blocked request does not name the linked wallet");
}
// Sent requests must carry no block-level findings.
for (const r of requests.slice(0, 2)) {
  if (blocks(r.findings).length) throw new Error(`request ${r.seq} unexpectedly blocks: ${JSON.stringify(r.findings)}`);
}

// ---------- burner funding job ----------

const JOB_ID = "bj_uniswap_fund_01";
const fundJob: BurnerJob = {
  v: 1,
  id: JOB_ID,
  createdAt: T.open,
  updatedAt: T.funded,
  status: "done",
  step: "done",
  owner: OWNER,
  chain: "base",
  action: {
    kind: "fund",
    target: { index: 3, address: DAPP },
    asset: "usdc",
    amount: BUDGET_USDC,
    gasWei: GAS_WEI,
    payWith: "usdc",
  },
  burner: { index: 3, address: DAPP },
  gas: [gasLeg],
  asset: assetLeg,
  events: [
    { at: T.open, step: "allocate", message: `dapp address ${DAPP} allocated for ${DAPP_ORIGIN}` },
    { at: "2026-11-12T16:36:12.000Z", step: "fund_gas", message: "gas leg quoted and signed" },
    { at: "2026-11-12T16:36:18.000Z", step: "fund_asset", message: "asset leg quoted and signed" },
    { at: T.funded, step: "done", message: "funded: address kept for its dapp" },
  ],
};

// ---------- connect account ----------

const sweepUsdcItem: SweepItem = {
  assetId: USDC_ASSET,
  symbol: "USDC",
  decimals: 6,
  token: USDC,
  balance: SWEEP_USDC_AMOUNT,
  decision: "deposit",
  quote: quoteSweepUsdc,
  tx: txSweepUsdc,
  depositNotified: true,
  status: "SUCCESS",
  outcome: "returned",
};

const sweepEthItem: SweepItem = {
  assetId: ETH_ASSET,
  symbol: "ETH",
  decimals: 18,
  balance: ETH_SWEEP_BALANCE,
  decision: "deposit",
  quote: quoteSweepEth,
  tx: txSweepEthRaw,
  depositNotified: true,
  status: "SUCCESS",
  outcome: "returned",
};

const account: ConnectAccount = {
  v: 1,
  id: "ca_uniswap_demo",
  createdAt: T.open,
  updatedAt: T.closed,
  status: "closed",
  owner: OWNER,
  chain: "base",
  dapp: { origin: DAPP_ORIGIN, name: DAPP_NAME, url: DAPP_ORIGIN },
  address: { index: 3, address: DAPP },
  budget: { asset: "usdc", amount: BUDGET_USDC, payWith: "usdc" },
  fundings: [{ jobId: JOB_ID, at: T.funded, reason: "open" }],
  requests,
  sweep: {
    startedAt: T.sweepStart,
    planned: true,
    items: [sweepUsdcItem, sweepEthItem],
    unsupported: [],
  },
  events: [
    { at: T.open, message: `open: dapp address ${DAPP} bound to ${DAPP_ORIGIN}` },
    { at: T.funded, message: "funded 1 USDC and gas from the confidential balance" },
    { at: T.reqBlocked, message: "request 3 blocked by the linkage check" },
    { at: T.sweepStart, message: "close: sweeping balances back into the confidential balance" },
    { at: T.closed, message: "closed: dapp address retired" },
  ],
};

// ---------- recording ----------

const recording = {
  format: "shelter-demo-recording",
  v: 1,
  recordedAt: T.recorded,
  network: "mainnet",
  owner: OWNER,
  deposits: [],
  burners: [fundJob],
  connect: [
    {
      account,
      linked: [{ id: MAIN_WALLET, label: "your main wallet" }],
    },
  ],
};

// ---------- self-checks: every offline check the web app runs must pass ----------

for (const tx of [txApprove, txSwap, txSweepUsdc, txSweepEthRaw]) {
  const sender = await senderOf(tx);
  if (getAddress(sender) !== DAPP) throw new Error(`tx ${tx.hash} sender ${sender} is not the dapp address`);
  if (keccak256(tx.raw) !== tx.hash) throw new Error(`tx ${tx.hash} hash mismatch`);
}

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "fixtures", "connect-recording.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(recording, null, 2)}\n`);
console.log(`wrote ${out}`);
console.log(`dapp address ${DAPP}`);
console.log(`requests: ${requests.map((r) => `${r.seq}:${r.method}:${r.decision}`).join(", ")}`);
console.log(`fixture signer ${PUB_KEY}`);
