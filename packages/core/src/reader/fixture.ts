import type { ChainId } from "../index.js";
import type {
  ApprovalRecord,
  ChainReader,
  NearAccountInfo,
  TokenTransferRecord,
  TxRecord,
} from "./types.js";

/** Recorded data for one address inside a fixture profile. */
export interface FixtureAccount {
  chain: ChainId;
  balanceWei?: string;
  nonce?: number;
  ensName?: string | null;
  transactions?: TxRecord[];
  tokenTransfers?: TokenTransferRecord[];
  approvals?: ApprovalRecord[];
}

/** A recorded scan: fictional wallets plus everything the reader would return. */
export interface FixtureProfile {
  name: string;
  wallets: { chain: ChainId; address: string; label?: string }[];
  /** Keyed by lowercased address. */
  accounts: Record<string, FixtureAccount>;
  /** Keyed by NEAR account id. */
  nearAccounts?: Record<
    string,
    { exists: boolean; balanceYocto?: string; storageUsage?: number }
  >;
}

const EMPTY_ACCOUNT = (chain: ChainId): FixtureAccount => ({ chain });

/**
 * Serves recorded JSON instead of touching the network. Contains no I/O at
 * all, so tests and the demo can scan sample wallets offline.
 */
export class FixtureReader implements ChainReader {
  private readonly accounts: Map<string, FixtureAccount>;

  constructor(private readonly profile: FixtureProfile) {
    this.accounts = new Map(
      Object.entries(profile.accounts).map(([k, v]) => [k.toLowerCase(), v]),
    );
  }

  private account(chain: ChainId, address: string): FixtureAccount {
    return this.accounts.get(address.toLowerCase()) ?? EMPTY_ACCOUNT(chain);
  }

  async getBalance(chain: ChainId, address: string): Promise<string> {
    return this.account(chain, address).balanceWei ?? "0";
  }

  async getNonce(chain: ChainId, address: string): Promise<number> {
    return this.account(chain, address).nonce ?? 0;
  }

  async getEnsName(chain: ChainId, address: string): Promise<string | null> {
    return this.account(chain, address).ensName ?? null;
  }

  async getTransactions(chain: ChainId, address: string): Promise<TxRecord[]> {
    return this.account(chain, address).transactions ?? [];
  }

  async getTokenTransfers(
    chain: ChainId,
    address: string,
  ): Promise<TokenTransferRecord[]> {
    return this.account(chain, address).tokenTransfers ?? [];
  }

  async getApprovals(
    chain: ChainId,
    address: string,
  ): Promise<ApprovalRecord[]> {
    return this.account(chain, address).approvals ?? [];
  }

  async getNearAccount(accountId: string): Promise<NearAccountInfo> {
    const rec = this.profile.nearAccounts?.[accountId];
    if (!rec) return { accountId, exists: false };
    return { accountId, ...rec };
  }
}
