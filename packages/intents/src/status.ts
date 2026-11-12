/** Maps GET /v0/status into StatusResult without ever turning an unknown state into success. */

import { IntentsError } from "./errors.js";
import { verifyQuoteSignature } from "./signature.js";
import type { IntentStatus, StatusResult } from "./types.js";
import { describeIssue, EXECUTION_STATUSES, quoteResponseSchema, statusResponseSchema } from "./wire.js";

const KNOWN = new Set<string>(EXECUTION_STATUSES);

export function mapStatusResponse(
  raw: unknown,
  depositAddress: string,
  o: { signerPublicKey: string },
): StatusResult {
  const parsed = statusResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new IntentsError("malformed_response", `/v0/status: ${describeIssue(parsed.error)}`, { path: "/v0/status" });
  }
  const s = parsed.data;
  const d = s.swapDetails;

  const quote = quoteResponseSchema.safeParse(s.quoteResponse);
  const quoteVerified =
    quote.success &&
    quote.data.quote.depositAddress === depositAddress &&
    verifyQuoteSignature(quote.data, o.signerPublicKey);

  const status: IntentStatus = KNOWN.has(s.status) ? (s.status as IntentStatus) : "UNKNOWN";
  const originChainTxs = d.originChainTxHashes.map((t) => ({ hash: t.hash, explorerUrl: t.explorerUrl }));
  const destinationChainTxs = d.destinationChainTxHashes.map((t) => ({ hash: t.hash, explorerUrl: t.explorerUrl }));

  return {
    depositAddress,
    status,
    rawStatus: s.status,
    txHashes: [...new Set([...originChainTxs.map((t) => t.hash), ...destinationChainTxs.map((t) => t.hash), ...d.nearTxHashes])],
    originChainTxs,
    destinationChainTxs,
    nearTxHashes: d.nearTxHashes,
    intentHashes: d.intentHashes,
    updatedAt: s.updatedAt,
    correlationId: s.correlationId,
    amountIn: d.amountIn,
    amountOut: d.amountOut,
    depositedAmount: d.depositedAmount,
    refundedAmount: d.refundedAmount,
    refundReason: d.refundReason,
    quoteVerified,
  };
}

/** True for states after which the status will not change. */
export function isTerminalStatus(s: IntentStatus): boolean {
  return s === "SUCCESS" || s === "REFUNDED" || s === "FAILED";
}
