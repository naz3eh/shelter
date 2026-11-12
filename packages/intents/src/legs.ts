/**
 * Quote requests for the two Shelter legs, with the deposit, recipient and
 * refund types set per leg. Uses the "embedded account" path from
 * https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/confidential-swaps
 * (retrieved 2026-11-07): funds stay in the owner's Confidential Intents
 * balance between the two legs.
 *
 * Refunds always target the owner's confidential balance. There is no
 * parameter to send a refund anywhere public; if 1Click rejects that for a
 * route, the quote fails and the caller must stop and report it.
 */

import type { AssetAmount, QuoteRequest } from "./types.js";

export interface PrivateDepositLeg {
  /** Asset on its origin chain and the exact amount the source wallet will send. */
  asset: AssetAmount;
  /** Intents account id that owns the confidential balance (e.g. "alice.near"). */
  owner: string;
  slippageBps?: number;
  dry?: boolean;
  deadline?: string;
}

/** Source wallet → owner's confidential balance. Same asset in and out. */
export function privateDepositRequest(leg: PrivateDepositLeg): QuoteRequest {
  return {
    originAssetId: leg.asset.assetId,
    destinationAssetId: leg.asset.assetId,
    swapType: "EXACT_INPUT",
    amount: leg.asset.amount,
    depositType: "ORIGIN_CHAIN",
    recipient: leg.owner,
    recipientType: "CONFIDENTIAL_INTENTS",
    refundTo: leg.owner,
    refundType: "CONFIDENTIAL_INTENTS",
    slippageBps: leg.slippageBps,
    confidentiality: "advanced",
    dry: leg.dry,
    deadline: leg.deadline,
  };
}

export interface PrivateWithdrawLeg {
  /** Asset and the exact amount the destination must receive (EXACT_OUTPUT). */
  asset: AssetAmount;
  /**
   * Balance asset to pay with, when it differs from what is delivered
   * (for example USDC paying for native ETH gas). Default: the same asset.
   */
  payWithAssetId?: string;
  owner: string;
  /** Fresh external address on the asset's chain. */
  destination: string;
  slippageBps?: number;
  dry?: boolean;
  deadline?: string;
}

/**
 * Owner's confidential balance → a fresh external address: the same asset,
 * or another one swapped on the way (`payWithAssetId`).
 * Executed later through a signed intent (generate-intent / submit-intent),
 * never through an on-chain deposit.
 */
export function privateWithdrawRequest(leg: PrivateWithdrawLeg): QuoteRequest {
  return {
    originAssetId: leg.payWithAssetId ?? leg.asset.assetId,
    destinationAssetId: leg.asset.assetId,
    swapType: "EXACT_OUTPUT",
    amount: leg.asset.amount,
    depositType: "CONFIDENTIAL_INTENTS",
    recipient: leg.destination,
    recipientType: "DESTINATION_CHAIN",
    refundTo: leg.owner,
    refundType: "CONFIDENTIAL_INTENTS",
    slippageBps: leg.slippageBps,
    confidentiality: "advanced",
    dry: leg.dry,
    deadline: leg.deadline,
  };
}
