import type { ChainId } from "../index.js";

export type { ChainId };

/** Normalized native-currency transaction. Amounts are decimal strings in wei. */
export interface TxRecord {
  hash: string;
  chain: ChainId;
  from: string;
  to: string | null;
  valueWei: string;
  /** Unix seconds. */
  timestamp: number;
  /** Decoded method name when the indexer knows it (e.g. "approve"). */
  method?: string;
}

export interface TokenTransferRecord {
  hash: string;
  chain: ChainId;
  token: string;
  symbol?: string;
  from: string;
  to: string | null;
  /** Raw token amount in the token's smallest unit. */
  value: string;
  timestamp: number;
}

export interface ApprovalRecord {
  txHash: string;
  chain: ChainId;
  token: string;
  owner: string;
  spender: string;
}

export interface NearAccountInfo {
  accountId: string;
  exists: boolean;
  balanceYocto?: string;
  storageUsage?: number;
}

/**
 * Everything the exposure engine needs to see about a wallet. Reads go through
 * the user's own endpoints (RPC, a Blockscout instance, NEAR RPC); the bundled
 * FixtureReader serves recorded JSON instead.
 */
export interface ChainReader {
  /** Native balance as a decimal wei string. */
  getBalance(chain: ChainId, address: string): Promise<string>;
  /** Outgoing transaction count; >0 means the public key is exposed. */
  getNonce(chain: ChainId, address: string): Promise<number>;
  /** Reverse-resolved ENS or Basename, or null. */
  getEnsName(chain: ChainId, address: string): Promise<string | null>;
  /** Native-currency transactions to and from the address. */
  getTransactions(chain: ChainId, address: string): Promise<TxRecord[]>;
  /** ERC-20 token transfers to and from the address. */
  getTokenTransfers(chain: ChainId, address: string): Promise<TokenTransferRecord[]>;
  /** Token approvals granted by the address. */
  getApprovals(chain: ChainId, address: string): Promise<ApprovalRecord[]>;
  /** NEAR account lookup via view_account. */
  getNearAccount(accountId: string): Promise<NearAccountInfo>;
}

export interface ChainReaderConfig {
  /** Per-chain JSON-RPC URL overrides (ETH_RPC_URL, BASE_RPC_URL). */
  rpcUrls?: Partial<Record<ChainId, string>>;
  /**
   * Per-chain Blockscout base URLs. Defaults to the public instances;
   * point at a self-hosted instance to keep queries off third parties.
   */
  blockscoutUrls?: Partial<Record<ChainId, string>>;
  /** NEAR RPC URL; defaults to https://rpc.mainnet.near.org. */
  nearRpcUrl?: string;
}
