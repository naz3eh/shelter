/**
 * Verifies the ed25519 signature 1Click attaches to every quote, so a
 * tampered `depositAddress` or amount is caught before anything is funded.
 *
 * Documented at
 * https://docs.near-intents.org/integration/distribution-channels/1click-api/verify-quote-signature
 * (retrieved 2026-11-07). The exact field selection and the manager public key
 * mirror `verifyQuoteSignature()` in @defuse-protocol/one-click-sdk-typescript
 * 0.1.26 (ISC), which the docs recommend. That SDK is not a dependency because
 * it pulls axios and form-data into browser bundles. Serialisation is
 * ./canonical.ts, tested equal to the SDK's json-stable-stringify.
 *
 * Note: the signed payload does not include `confidentiality`. The client
 * therefore checks the echoed confidentiality level separately.
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58 } from "@scure/base";
import { canonicalJson } from "./canonical.js";
import type { WireQuoteResponse } from "./wire.js";

/** 1Click quote manager key, as shipped in one-click-sdk-typescript 0.1.26. */
export const ONE_CLICK_MANAGER_PUBLIC_KEY = "ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc";

const ED25519_PREFIX = "ed25519:";

function signedRequestFields(r: WireQuoteResponse["quoteRequest"]): Record<string, unknown> {
  return {
    dry: r.dry,
    swapType: r.swapType,
    slippageTolerance: r.slippageTolerance,
    originAsset: r.originAsset,
    depositType: r.depositType,
    destinationAsset: r.destinationAsset,
    amount: r.amount,
    refundTo: r.refundTo,
    refundType: r.refundType,
    recipient: r.recipient,
    recipientType: r.recipientType,
    deadline: r.deadline,
    quoteWaitingTimeMs: r.quoteWaitingTimeMs ? r.quoteWaitingTimeMs : undefined,
    referral: r.referral ? r.referral : undefined,
    virtualChainRecipient: r.virtualChainRecipient ? r.virtualChainRecipient : undefined,
    virtualChainRefundRecipient: r.virtualChainRefundRecipient ? r.virtualChainRefundRecipient : undefined,
    customRecipientMsg: r.customRecipientMsg ? r.customRecipientMsg : undefined,
    sessionId: undefined,
    connectedWallets: undefined,
    correlationId: undefined,
    appFees: undefined,
    partnerId: undefined,
    userAccountId: undefined,
    depositMode: undefined,
  };
}

function signedQuoteFields(resp: WireQuoteResponse): Record<string, unknown> {
  const q = resp.quote;
  const amounts = {
    amountIn: q.amountIn,
    amountInFormatted: q.amountInFormatted,
    amountInUsd: q.amountInUsd,
    minAmountIn: q.minAmountIn,
    amountOut: q.amountOut,
    amountOutFormatted: q.amountOutFormatted,
    amountOutUsd: q.amountOutUsd,
    minAmountOut: q.minAmountOut,
  };
  if (resp.quoteRequest.dry) return amounts;
  return {
    ...amounts,
    depositAddress: q.depositAddress || undefined,
    depositMemo: q.depositMemo || undefined,
    deadline: q.deadline || undefined,
    timeWhenInactive: q.timeWhenInactive || undefined,
    timeEstimate: q.timeEstimate || undefined,
    refundFee: q.refundFee || undefined,
    withdrawFee: q.withdrawFee || undefined,
  };
}

/** The base58 SHA-256 digest 1Click signs. Exported for tests and evidence records. */
export function quoteDigest(resp: WireQuoteResponse): string {
  const data = canonicalJson({ ...signedRequestFields(resp.quoteRequest), ...signedQuoteFields(resp), timestamp: resp.timestamp });
  if (data === undefined) throw new Error("quote payload could not be serialised");
  return base58.encode(sha256(new TextEncoder().encode(data)));
}

/** True only when `resp.signature` is a valid ed25519 signature by `publicKey` over the quote digest. */
export function verifyQuoteSignature(resp: WireQuoteResponse, publicKey = ONE_CLICK_MANAGER_PUBLIC_KEY): boolean {
  try {
    const sig = base58.decode(stripPrefix(resp.signature));
    const pub = base58.decode(stripPrefix(publicKey));
    const msg = new TextEncoder().encode(quoteDigest(resp));
    return ed25519.verify(sig, msg, pub);
  } catch {
    return false;
  }
}

function stripPrefix(v: string): string {
  return v.startsWith(ED25519_PREFIX) ? v.slice(ED25519_PREFIX.length) : v;
}
