/**
 * NEAR Intents 1Click client, confidential balance, and status tracking.
 *
 * DRAFT INTERFACE: the backend owner finalizes these types and signatures
 * against the live 1Click API. Everything here is a stub.
 */

export type Confidentiality = "none" | "advanced";

export interface AssetAmount {
  /** 1Click asset id, e.g. "nep141:base-0x....omft.near" */
  assetId: string;
  /** Amount in the asset's smallest unit, as a decimal string. */
  amount: string;
}

export interface QuoteRequest {
  from: AssetAmount;
  toAssetId: string;
  /** Where refunds go if the swap fails. */
  refundTo: string;
  /** Destination account or address. */
  recipient: string;
  slippageBps?: number;
  confidentiality?: Confidentiality;
  /** When true, ask 1Click for a quote without reserving a deposit address. */
  dry?: boolean;
}

export interface Quote {
  quoteId: string;
  depositAddress?: string;
  amountIn: string;
  amountOut: string;
  /** ISO-8601 time after which the deposit address is no longer valid. */
  deadline: string;
  confidentiality: Confidentiality;
}

export type IntentStatus =
  | "PENDING_DEPOSIT"
  | "KNOWN_DEPOSIT_TX"
  | "PROCESSING"
  | "SUCCESS"
  | "INCOMPLETE_DEPOSIT"
  | "REFUNDED"
  | "FAILED";

export interface StatusResult {
  depositAddress: string;
  status: IntentStatus;
  txHashes: string[];
  updatedAt: string;
}

export interface DepositRequest {
  quote: Quote;
  /** Hash of the on-chain transfer into quote.depositAddress. */
  txHash: string;
}

export interface WithdrawRequest {
  from: AssetAmount;
  /** Destination address on the target chain (typically a burner). */
  to: string;
  chain: string;
  confidentiality?: Confidentiality;
}

export interface FundBurnerRequest {
  /** One-time burner address from @shelter/burner. */
  burnerAddress: string;
  chain: string;
  amount: AssetAmount;
}

export interface IntentsClientOptions {
  /** 1Click JWT (ONECLICK_JWT). */
  jwt?: string;
  baseUrl?: string;
}

export interface IntentsClient {
  getQuote(req: QuoteRequest): Promise<Quote>;
  deposit(req: DepositRequest): Promise<StatusResult>;
  withdraw(req: WithdrawRequest): Promise<StatusResult>;
  fundBurner(req: FundBurnerRequest): Promise<StatusResult>;
  status(depositAddress: string): Promise<StatusResult>;
}

const notImplemented = (): never => {
  throw new Error("not implemented");
};

export function getQuote(_req: QuoteRequest): Promise<Quote> {
  return notImplemented();
}

export function deposit(_req: DepositRequest): Promise<StatusResult> {
  return notImplemented();
}

export function withdraw(_req: WithdrawRequest): Promise<StatusResult> {
  return notImplemented();
}

export function fundBurner(_req: FundBurnerRequest): Promise<StatusResult> {
  return notImplemented();
}

export function status(_depositAddress: string): Promise<StatusResult> {
  return notImplemented();
}

export function createIntentsClient(_opts: IntentsClientOptions = {}): IntentsClient {
  return { getQuote, deposit, withdraw, fundBurner, status };
}
