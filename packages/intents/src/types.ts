/**
 * Application-facing types. These are what the CLI and the web app use; the
 * client maps them to and from the wire format in ./wire.ts.
 */

import type {
  WireConfidentiality,
  WireDepositType,
  WireExecutionStatus,
  WireQuoteResponse,
  WireRecipientType,
  WireRefundType,
} from "./wire.js";

/** 1Click confidentiality level. Shelter defaults to "advanced" and never falls back to "public" silently. */
export type Confidentiality = WireConfidentiality;
export type DepositType = WireDepositType;
export type RecipientType = WireRecipientType;
export type RefundType = WireRefundType;
/** How `amount` is read: the exact input, or the exact output the recipient must get. */
export type SwapType = "EXACT_INPUT" | "EXACT_OUTPUT";

export interface AssetAmount {
  /** 1Click asset id, e.g. "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near" */
  assetId: string;
  /** Amount in the asset's smallest unit, as a decimal string. */
  amount: string;
}

/**
 * A quote request. Field names follow the API so nothing is lost in
 * translation; prefer the leg builders in ./legs.ts, which set the
 * deposit/recipient/refund types correctly for each Shelter leg.
 */
export interface QuoteRequest {
  originAssetId: string;
  destinationAssetId: string;
  swapType: SwapType;
  /** Base units of the origin asset (EXACT_INPUT) or of the destination asset (EXACT_OUTPUT). */
  amount: string;
  depositType: DepositType;
  recipient: string;
  recipientType: RecipientType;
  refundTo: string;
  refundType: RefundType;
  /** Default 50 (0.5 %). Integer basis points, 0-1000. */
  slippageBps?: number;
  /** Default "advanced". "public" is rejected unless the client was created with allowPublic. */
  confidentiality?: Confidentiality;
  /** Default true. A dry quote reserves no deposit address and can never be funded. */
  dry?: boolean;
  /** When refunds start if the swap has not completed. Default: now + 30 minutes. */
  deadline?: string;
}

export interface QuoteProvenance {
  correlationId: string;
  /** Timestamp 1Click used to derive the deposit address. */
  timestamp: string;
  /** ed25519 signature by the 1Click quote manager key. */
  signature: string;
  /** True when the signature was checked against `signerPublicKey`. */
  signatureVerified: boolean;
  signerPublicKey: string;
}

export interface Quote {
  /**
   * The API has no quote id. This is the quote response's correlationId,
   * useful for support and logs. To bind an approval to a quote, use
   * `depositAddress` together with `provenance.signature`.
   */
  quoteId: string;
  dry: boolean;
  /** Absent on dry quotes. */
  depositAddress?: string;
  depositMemo?: string;
  amountIn: string;
  minAmountIn: string;
  amountOut: string;
  minAmountOut: string;
  /** USD values as 1Click reports them. For display only. */
  amountInUsd: string;
  amountOutUsd: string;
  /**
   * When the full deposit must have arrived: the earlier of the requested
   * deadline and the deposit address expiry (1Click refunds anything still
   * incomplete after the requested one). Absent on dry quotes.
   */
  deadline?: string;
  /** The deposit address expiry as 1Click sent it (`quote.timeWhenInactive`). */
  timeWhenInactive?: string;
  /** Estimated seconds from confirmed deposit to completion. */
  timeEstimateSec: number;
  /** Destination-asset base units, already deducted from amountOut. */
  withdrawFee?: string;
  /** Origin-asset base units charged if a refund happens. */
  refundFee?: string;
  confidentiality: Confidentiality;
  /** The normalised request that produced this quote (deadline filled in). */
  request: Required<QuoteRequest>;
  provenance: QuoteProvenance;
  /** The complete wire response. 1Click asks integrators to keep it for disputes. Contains no secrets. */
  wire: WireQuoteResponse;
}

/** The documented execution states, plus UNKNOWN for anything new. */
export type IntentStatus = WireExecutionStatus | "UNKNOWN";

export interface ChainTx {
  hash: string;
  explorerUrl: string;
}

export interface StatusResult {
  depositAddress: string;
  status: IntentStatus;
  /** The status string exactly as 1Click sent it (differs from `status` only when UNKNOWN). */
  rawStatus: string;
  /** Every hash 1Click reported: origin-chain, destination-chain and NEAR. */
  txHashes: string[];
  originChainTxs: ChainTx[];
  destinationChainTxs: ChainTx[];
  nearTxHashes: string[];
  intentHashes: string[];
  updatedAt: string;
  correlationId: string;
  /** Settled amounts, when 1Click reports them. */
  amountIn?: string;
  amountOut?: string;
  depositedAmount?: string;
  refundedAmount?: string;
  refundReason?: string;
  /**
   * Whether the quote embedded in the status response parsed and its 1Click
   * signature verified. A status read never fails on this; callers decide.
   */
  quoteVerified: boolean;
}

export interface TokenInfo {
  assetId: string;
  decimals: number;
  /** 1Click chain id, e.g. "base", "eth", "near". */
  blockchain: string;
  symbol: string;
  contractAddress?: string;
}
