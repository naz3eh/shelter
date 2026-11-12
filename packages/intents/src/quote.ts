/** Quote request validation, wire mapping and response verification. */

import { assertChainAddress, assertIntentsAccountId, SUPPORTED_EVM_CHAINS } from "./accounts.js";
import { assertPositiveBaseUnits } from "./amount.js";
import { IntentsError } from "./errors.js";
import { verifyQuoteSignature } from "./signature.js";
import type { TokenRegistry } from "./tokens.js";
import type { Quote, QuoteRequest } from "./types.js";
import { describeIssue, quoteResponseSchema, type WireQuoteRequest, type WireQuoteResponse } from "./wire.js";

export const DEFAULT_SLIPPAGE_BPS = 50;
export const DEFAULT_DEADLINE_MS = 30 * 60_000;
const MIN_DEADLINE_MS = 60_000;
const MAX_DEADLINE_MS = 24 * 60 * 60_000;
const MAX_SLIPPAGE_BPS = 1000;

export interface NormalizeOptions {
  now: Date;
  allowPublic: boolean;
  tokens: TokenRegistry;
  signal?: AbortSignal;
}

/** Validates a request against Shelter's rules and the live token list; fills defaults. */
export async function normalizeQuoteRequest(req: QuoteRequest, o: NormalizeOptions): Promise<Required<QuoteRequest>> {
  const confidentiality = req.confidentiality ?? "advanced";
  if (confidentiality === "public" && !o.allowPublic) {
    throw new IntentsError("confidentiality_required", 'confidentiality "public" needs a client created with allowPublic');
  }
  const usesPublicIntents = [req.depositType, req.recipientType, req.refundType].includes("INTENTS");
  if (usesPublicIntents && !o.allowPublic) {
    throw new IntentsError("confidentiality_required", "public INTENTS balances need a client created with allowPublic");
  }

  const slippageBps = req.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > MAX_SLIPPAGE_BPS) {
    throw new IntentsError("validation", `slippageBps must be an integer from 0 to ${MAX_SLIPPAGE_BPS}`);
  }
  if (req.swapType !== "EXACT_INPUT" && req.swapType !== "EXACT_OUTPUT") {
    throw new IntentsError("validation", "swapType must be EXACT_INPUT or EXACT_OUTPUT");
  }
  const amount = assertPositiveBaseUnits(req.amount);

  const deadline = req.deadline ?? new Date(o.now.getTime() + DEFAULT_DEADLINE_MS).toISOString();
  const deadlineAt = Date.parse(deadline);
  if (Number.isNaN(deadlineAt)) throw new IntentsError("validation", "deadline is not an ISO-8601 date-time");
  const ahead = deadlineAt - o.now.getTime();
  if (ahead < MIN_DEADLINE_MS || ahead > MAX_DEADLINE_MS) {
    throw new IntentsError("validation", "deadline must be between 1 minute and 24 hours from now");
  }

  const [origin, destination] = await Promise.all([
    o.tokens.get(req.originAssetId, o.signal),
    o.tokens.get(req.destinationAssetId, o.signal),
  ]);

  if (req.depositType !== "ORIGIN_CHAIN" && req.refundType === "ORIGIN_CHAIN") {
    throw new IntentsError("validation", "an ORIGIN_CHAIN refund needs an ORIGIN_CHAIN deposit");
  }
  if (req.recipientType === "DESTINATION_CHAIN") {
    assertChainAddress(req.recipient, destination.blockchain, "recipient");
  } else {
    assertIntentsAccountId(req.recipient, "recipient");
  }
  if (req.refundType === "ORIGIN_CHAIN") {
    assertChainAddress(req.refundTo, origin.blockchain, "refundTo");
  } else {
    assertIntentsAccountId(req.refundTo, "refundTo");
  }
  if (req.depositType === "ORIGIN_CHAIN" && !SUPPORTED_EVM_CHAINS.has(origin.blockchain)) {
    throw new IntentsError("unsupported", `originAssetId: chain "${origin.blockchain}" is not supported by Shelter`);
  }

  return {
    originAssetId: req.originAssetId,
    destinationAssetId: req.destinationAssetId,
    swapType: req.swapType,
    amount,
    depositType: req.depositType,
    recipient: req.recipient,
    recipientType: req.recipientType,
    refundTo: req.refundTo,
    refundType: req.refundType,
    slippageBps,
    confidentiality,
    dry: req.dry ?? true,
    deadline: new Date(deadlineAt).toISOString(),
  };
}

/** The exact body sent to POST /v0/quote. No optional or tracking fields are ever added. */
export function toWireQuoteRequest(r: Required<QuoteRequest>): WireQuoteRequest {
  return {
    dry: r.dry,
    swapType: r.swapType,
    slippageTolerance: r.slippageBps,
    originAsset: r.originAssetId,
    depositType: r.depositType,
    destinationAsset: r.destinationAssetId,
    amount: r.amount,
    refundTo: r.refundTo,
    refundType: r.refundType,
    recipient: r.recipient,
    recipientType: r.recipientType,
    deadline: r.deadline,
    confidentiality: r.confidentiality,
  };
}

export interface MapQuoteOptions {
  verifySignature: boolean;
  signerPublicKey: string;
}

/** Parses, cross-checks and verifies a quote response for the request that produced it. */
export function mapQuoteResponse(raw: unknown, request: Required<QuoteRequest>, o: MapQuoteOptions): Quote {
  const parsed = quoteResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new IntentsError("malformed_response", `/v0/quote: ${describeIssue(parsed.error)}`, { path: "/v0/quote" });
  }
  const resp: WireQuoteResponse = parsed.data;
  assertEchoMatches(resp, toWireQuoteRequest(request));

  const signatureVerified = o.verifySignature ? verifyQuoteSignature(resp, o.signerPublicKey) : false;
  if (o.verifySignature && !signatureVerified) {
    throw new IntentsError("signature_invalid", "1Click quote signature did not verify", {
      correlationId: resp.correlationId,
      path: "/v0/quote",
    });
  }

  const q = resp.quote;
  if (!request.dry && (!q.depositAddress || !q.deadline)) {
    throw new IntentsError("malformed_response", "execution quote has no deposit address or deadline", {
      correlationId: resp.correlationId,
      path: "/v0/quote",
    });
  }

  return {
    quoteId: resp.correlationId,
    dry: request.dry,
    depositAddress: request.dry ? undefined : q.depositAddress,
    depositMemo: request.dry ? undefined : q.depositMemo,
    amountIn: q.amountIn,
    minAmountIn: q.minAmountIn,
    amountOut: q.amountOut,
    minAmountOut: q.minAmountOut,
    amountInUsd: q.amountInUsd,
    amountOutUsd: q.amountOutUsd,
    deadline: q.deadline,
    timeWhenInactive: q.timeWhenInactive,
    timeEstimateSec: q.timeEstimate,
    withdrawFee: q.withdrawFee,
    refundFee: q.refundFee,
    confidentiality: request.confidentiality,
    request,
    provenance: {
      correlationId: resp.correlationId,
      timestamp: resp.timestamp,
      signature: resp.signature,
      signatureVerified,
      signerPublicKey: o.signerPublicKey,
    },
    wire: resp,
  };
}

/**
 * The echoed request must describe what was sent. A mismatch means a proxy,
 * a server default, or a bug changed the route, and the quote is not used.
 */
function assertEchoMatches(resp: WireQuoteResponse, sent: WireQuoteRequest): void {
  const echo = resp.quoteRequest;
  const same = (a: string, b: string) => (a.startsWith("0x") ? a.toLowerCase() === b.toLowerCase() : a === b);
  const checks: [string, boolean][] = [
    ["dry", echo.dry === sent.dry],
    ["swapType", echo.swapType === sent.swapType],
    ["slippageTolerance", echo.slippageTolerance === sent.slippageTolerance],
    ["originAsset", echo.originAsset === sent.originAsset],
    ["destinationAsset", echo.destinationAsset === sent.destinationAsset],
    ["amount", echo.amount === sent.amount],
    ["depositType", echo.depositType === sent.depositType],
    ["recipient", same(echo.recipient, sent.recipient)],
    ["recipientType", echo.recipientType === sent.recipientType],
    ["refundTo", same(echo.refundTo, sent.refundTo)],
    ["refundType", echo.refundType === sent.refundType],
    // Not covered by the signature, so it must be echoed explicitly.
    ["confidentiality", echo.confidentiality === sent.confidentiality],
  ];
  const bad = checks.filter(([, ok]) => !ok).map(([k]) => k);
  if (bad.length) {
    throw new IntentsError("response_mismatch", `quote response does not match the request: ${bad.join(", ")}`, {
      correlationId: resp.correlationId,
      path: "/v0/quote",
    });
  }
}

/**
 * Guards the step that would move funds: the quote must be an execution
 * quote with a deposit address, and its deadline must leave `marginMs` to act.
 */
export function assertFundable(quote: Quote, now: Date, marginMs = 5 * 60_000): void {
  if (quote.dry || !quote.depositAddress) {
    throw new IntentsError("not_fundable", "dry quotes and quotes without a deposit address can never be funded", {
      correlationId: quote.quoteId,
    });
  }
  if (!quote.provenance.signatureVerified) {
    throw new IntentsError("not_fundable", "quote signature was not verified", { correlationId: quote.quoteId });
  }
  const deadline = quote.deadline ? Date.parse(quote.deadline) : Number.NaN;
  if (Number.isNaN(deadline) || deadline - now.getTime() < marginMs) {
    throw new IntentsError("quote_expired", "quote deadline has passed or is too close to fund safely", {
      correlationId: quote.quoteId,
    });
  }
}
