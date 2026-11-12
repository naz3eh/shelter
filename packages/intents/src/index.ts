/**
 * NEAR Intents 1Click client, confidential balance, and status tracking.
 *
 * Implemented: token list, validated and signature-checked quotes for both
 * Shelter legs, status reads and polling (G4.1); NEP-413 User-Session
 * sign-in, confidential balances, deposit notification and checked
 * signed-intent withdrawals on intents.far (G4.2), and one-call burner
 * funding (`fundBurner`, G4.3). Wire details: docs/backend/ONECLICK.md.
 * Crash-safe multi-step flows live in @shelter/burner.
 */

import { createIntentsClient as create, type IntentsClient } from "./client.js";
import type { IntentSummary, WithdrawResult } from "./execution.js";
import type { Nep413Signer } from "./nep413.js";
import { privateWithdrawRequest } from "./legs.js";
import type { AssetAmount, Quote, QuoteRequest, StatusResult } from "./types.js";

export { createIntentsClient } from "./client.js";
export type { CallOptions, IntentsClient, IntentsClientOptions, WaitOptions } from "./client.js";
export {
  checkGeneratedIntent,
  CONFIDENTIAL_INTENTS_CONTRACT,
  CONFIDENTIAL_INTENTS_SALT,
  CONFIDENTIAL_TREASURY,
  confidentialTokenId,
  executeSignedIntent,
  getBalances,
  prepareSignedIntent,
  submitDeposit,
  submitSignedIntent,
} from "./execution.js";
export type { Balance, ExecutionDeps, IntentExpectation, IntentSummary, PreparedIntent, SubmittedIntent, WithdrawResult } from "./execution.js";
export { createNearView, DEFAULT_NEAR_RPC_URL, INTENTS_CONTRACT } from "./near-rpc.js";
export type { NearView, NearViewOptions } from "./near-rpc.js";
export {
  formatEd25519Signature,
  nep413Bytes,
  nep413Hash,
  parseEd25519PublicKey,
  signNep413Checked,
  verifyNep413,
} from "./nep413.js";
export type { Nep413Payload, Nep413Signature, Nep413Signer } from "./nep413.js";
export { decodeVersionedNonce, encodeVersionedNonce, timestampedRandomBytes } from "./nonce.js";
export type { DecodedNonce } from "./nonce.js";
export { assertKeyRegistered, loginPayload, signIn, toSignedData } from "./session.js";
export type { SignedNep413, SignInOptions, UserSession } from "./session.js";
export { IntentsError, isIntentsError } from "./errors.js";
export type { IntentsErrorKind } from "./errors.js";
export { assertPositiveBaseUnits, formatBaseUnits, parseBaseUnits, toBaseUnits } from "./amount.js";
export { isEvmAddress, isIntentsAccountId, SUPPORTED_EVM_CHAINS } from "./accounts.js";
export { privateDepositRequest, privateWithdrawRequest } from "./legs.js";
export type { PrivateDepositLeg, PrivateWithdrawLeg } from "./legs.js";
export { assertFundable, DEFAULT_DEADLINE_MS, DEFAULT_SLIPPAGE_BPS } from "./quote.js";
export { ONE_CLICK_MANAGER_PUBLIC_KEY, quoteDigest, verifyQuoteSignature } from "./signature.js";
export { isTerminalStatus } from "./status.js";
export { createFetchTransport, DEFAULT_BASE_URL } from "./transport.js";
export type { FetchLike, FetchTransportOptions, Transport, TransportRequest } from "./transport.js";
export type {
  AssetAmount,
  ChainTx,
  Confidentiality,
  DepositType,
  IntentStatus,
  Quote,
  QuoteProvenance,
  QuoteRequest,
  RecipientType,
  RefundType,
  StatusResult,
  SwapType,
  TokenInfo,
} from "./types.js";
export type { WireQuoteRequest, WireQuoteResponse, WireStatusResponse } from "./wire.js";

/** Deposit leg: the verified execution quote and the hash of the on-chain transfer into its depositAddress. */
export interface DepositRequest {
  quote: Quote;
  txHash: string;
}

/** Withdrawal leg: a verified CONFIDENTIAL_INTENTS execution quote and the balance owner's wallet. */
export interface WithdrawRequest {
  quote: Quote;
  signer: Nep413Signer;
  /** Sees exactly what will be signed; must resolve true. */
  approve?: (s: IntentSummary) => Promise<boolean> | boolean;
  signal?: AbortSignal;
}

/** One confidential withdrawal into a burner (or any fresh address). */
export interface FundBurnerRequest {
  /** The fresh EVM address on Base to fund. */
  burnerAddress: string;
  /** Exactly what the address must receive (EXACT_OUTPUT). */
  amount: AssetAmount;
  /** Balance asset that pays, when different (for example USDC paying for ETH gas). */
  payWithAssetId?: string;
  /** The balance owner's wallet; it signs the withdrawal. */
  signer: Nep413Signer;
  approve?: (s: IntentSummary) => Promise<boolean> | boolean;
  /** Client to use; it must carry the partner key. Default: the module's default client (no key). */
  client?: IntentsClient;
  slippageBps?: number;
  signal?: AbortSignal;
}

let defaultClient: IntentsClient | undefined;
const client = () => (defaultClient ??= create());

/** Quote through a default client (no partner JWT, dry and "advanced" unless the request says otherwise). */
export function getQuote(req: QuoteRequest): Promise<Quote> {
  return client().getQuote(req);
}

export function status(depositAddress: string): Promise<StatusResult> {
  return client().status(depositAddress);
}

/** Deposit leg through a default client: notifies 1Click and returns the current status. */
export function deposit(req: DepositRequest): Promise<StatusResult> {
  return client().submitDeposit(req.quote, req.txHash);
}

/** Withdrawal leg through a default client (no partner JWT). */
export function withdraw(req: WithdrawRequest): Promise<WithdrawResult> {
  return client().executeSignedIntent(req.quote, req.signer, { approve: req.approve, signal: req.signal });
}

/**
 * Funds a burner from the confidential balance in one call: an execution
 * quote, the checked and signed intent, the submit, and the first status.
 * Nothing is persisted between the steps, so a crash after signing cannot be
 * resumed; `@shelter/burner`'s engine runs the same legs crash-safely and is
 * what Shelter's flows use.
 */
export async function fundBurner(req: FundBurnerRequest): Promise<WithdrawResult> {
  const c = req.client ?? client();
  const quote = await c.getQuote(
    privateWithdrawRequest({
      asset: req.amount,
      payWithAssetId: req.payWithAssetId,
      owner: req.signer.accountId,
      destination: req.burnerAddress,
      slippageBps: req.slippageBps,
      dry: false,
    }),
    { signal: req.signal },
  );
  return c.executeSignedIntent(quote, req.signer, { approve: req.approve, signal: req.signal });
}
