/**
 * 1Click wire format, mirrored from the official OpenAPI document.
 *
 * Source: https://1click.chaindefuser.com/docs/v0/openapi.yaml (info.version
 * 0.1.10), retrieved 2026-11-07. Only the fields Shelter sends or reads are
 * modelled. Response objects are parsed loosely (unknown fields pass through)
 * so additive API changes do not break the client, but every field the client
 * relies on is required and type-checked.
 *
 * Uses zod/mini: the classic zod entry bundles every locale (~260 KB) into
 * the browser build.
 */

import * as z from "zod/mini";

export const DEPOSIT_TYPES = ["ORIGIN_CHAIN", "INTENTS", "CONFIDENTIAL_INTENTS"] as const;
export const RECIPIENT_TYPES = ["DESTINATION_CHAIN", "INTENTS", "CONFIDENTIAL_INTENTS"] as const;
export const REFUND_TYPES = ["ORIGIN_CHAIN", "INTENTS", "CONFIDENTIAL_INTENTS"] as const;
export const CONFIDENTIALITY_LEVELS = ["public", "basic", "advanced"] as const;
/** ANY_INPUT is omitted on purpose: it is partner-only fee aggregation. */
export const SWAP_TYPES = ["EXACT_INPUT", "EXACT_OUTPUT", "FLEX_INPUT"] as const;
export const EXECUTION_STATUSES = [
  "KNOWN_DEPOSIT_TX",
  "PENDING_DEPOSIT",
  "INCOMPLETE_DEPOSIT",
  "PROCESSING",
  "SUCCESS",
  "REFUNDED",
  "FAILED",
] as const;

export type WireDepositType = (typeof DEPOSIT_TYPES)[number];
export type WireRecipientType = (typeof RECIPIENT_TYPES)[number];
export type WireRefundType = (typeof REFUND_TYPES)[number];
export type WireConfidentiality = (typeof CONFIDENTIALITY_LEVELS)[number];
export type WireSwapType = (typeof SWAP_TYPES)[number];
export type WireExecutionStatus = (typeof EXECUTION_STATUSES)[number];

/**
 * The exact request body Shelter sends to POST /v0/quote.
 *
 * Deliberately absent: `connectedWallets` and `sessionId` (they would hand
 * 1Click the user's address set or a cross-request identifier), `appFees`,
 * `referral`, `rebates`, `insured`, `virtualChain*` and `customRecipientMsg`.
 */
export interface WireQuoteRequest {
  dry: boolean;
  swapType: WireSwapType;
  slippageTolerance: number;
  originAsset: string;
  depositType: WireDepositType;
  destinationAsset: string;
  amount: string;
  refundTo: string;
  refundType: WireRefundType;
  recipient: string;
  recipientType: WireRecipientType;
  deadline: string;
  confidentiality: WireConfidentiality;
}

const str = () => z.string();
const nonEmpty = () => z.string().check(z.minLength(1, "must not be empty"));
const uint = () => z.string().check(z.regex(/^(0|[1-9][0-9]*)$/, "must be a base-unit integer string"));
const isoDate = () => z.string().check(z.refine((s) => !Number.isNaN(Date.parse(s)), "must be an ISO-8601 date-time"));
const opt = z.optional;

export const tokenSchema = z.looseObject({
  assetId: nonEmpty(),
  decimals: z.int().check(z.minimum(0), z.maximum(36)),
  blockchain: nonEmpty(),
  symbol: str(),
  price: z.number(),
  priceUpdatedAt: str(),
  contractAddress: opt(str()),
  coingeckoId: opt(str()),
});
export const tokensSchema = z.array(tokenSchema);
export type WireToken = z.infer<typeof tokenSchema>;

/** The request as 1Click echoes it back in `quoteRequest`. */
export const echoedQuoteRequestSchema = z.looseObject({
  dry: z.boolean(),
  swapType: str(),
  slippageTolerance: z.number(),
  originAsset: str(),
  depositType: str(),
  destinationAsset: str(),
  amount: str(),
  refundTo: str(),
  refundType: str(),
  recipient: str(),
  recipientType: str(),
  deadline: opt(str()),
  confidentiality: opt(str()),
  quoteWaitingTimeMs: opt(z.number()),
  referral: opt(str()),
  virtualChainRecipient: opt(str()),
  virtualChainRefundRecipient: opt(str()),
  customRecipientMsg: opt(str()),
});

export const quoteBodySchema = z.looseObject({
  depositAddress: opt(nonEmpty()),
  depositMemo: opt(str()),
  amountIn: uint(),
  amountInFormatted: str(),
  amountInUsd: str(),
  minAmountIn: uint(),
  amountOut: uint(),
  amountOutFormatted: str(),
  amountOutUsd: str(),
  minAmountOut: uint(),
  deadline: opt(isoDate()),
  timeWhenInactive: opt(isoDate()),
  timeEstimate: z.number(),
  refundFee: opt(uint()),
  withdrawFee: opt(uint()),
});

export const quoteResponseSchema = z.looseObject({
  correlationId: nonEmpty(),
  timestamp: isoDate(),
  signature: nonEmpty(),
  quoteRequest: echoedQuoteRequestSchema,
  quote: quoteBodySchema,
});
export type WireQuoteResponse = z.infer<typeof quoteResponseSchema>;

const txDetailsSchema = z.looseObject({ hash: nonEmpty(), explorerUrl: str() });

export const swapDetailsSchema = z.looseObject({
  intentHashes: z.array(str()),
  nearTxHashes: z.array(str()),
  amountIn: opt(uint()),
  amountOut: opt(uint()),
  slippage: opt(z.number()),
  originChainTxHashes: z.array(txDetailsSchema),
  destinationChainTxHashes: z.array(txDetailsSchema),
  refundedAmount: opt(uint()),
  refundReason: opt(str()),
  depositedAmount: opt(uint()),
  withdrawFee: opt(uint()),
});

/**
 * `status` is parsed as any string, not the documented enum, so a new state
 * is surfaced as UNKNOWN with its raw value instead of failing the read.
 * `quoteResponse` is parsed and verified separately: a status read tracks
 * real funds and must not fail just because the embedded quote is unusual.
 */
export const statusResponseSchema = z.looseObject({
  correlationId: str(),
  quoteResponse: z.unknown(),
  status: nonEmpty(),
  updatedAt: isoDate(),
  swapDetails: swapDetailsSchema,
});
export type WireStatusResponse = z.infer<typeof statusResponseSchema>;

/** One-line description of the first validation issue, e.g. "quote.amountOut: must be a base-unit integer string". */
export function describeIssue(error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] }): string {
  const issue = error.issues[0];
  if (!issue) return "invalid response";
  const path = issue.path.map(String).join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}
