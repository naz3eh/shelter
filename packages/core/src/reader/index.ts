import { createPublicClient, http, type PublicClient } from "viem";
import { base, mainnet } from "viem/chains";
import type { ChainId } from "../index.js";
import { BlockscoutClient } from "./blockscout.js";
import type {
  ApprovalRecord,
  ChainReader,
  ChainReaderConfig,
  NearAccountInfo,
  TokenTransferRecord,
  TxRecord,
} from "./types.js";

const EVM_CHAINS = new Set(["ethereum", "base"]);

const DEFAULT_BLOCKSCOUT: Record<string, string> = {
  ethereum: "https://eth.blockscout.com/api/v2",
  base: "https://base.blockscout.com/api/v2",
};

const DEFAULT_NEAR_RPC = "https://rpc.mainnet.near.org";

const chainFor = (chain: ChainId) =>
  chain === "base" ? base : chain === "ethereum" ? mainnet : undefined;

/**
 * Live chain reader: viem for balances/nonces/ENS, a Blockscout instance for
 * history and approvals, NEAR RPC for .near accounts.
 */
export function createChainReader(config: ChainReaderConfig = {}): ChainReader {
  const rpcUrls: Record<string, string | undefined> = {
    ethereum: config.rpcUrls?.ethereum ?? process.env.ETH_RPC_URL,
    base: config.rpcUrls?.base ?? process.env.BASE_RPC_URL,
    ...config.rpcUrls,
  };

  const clients = new Map<ChainId, PublicClient>();
  const clientFor = (chain: ChainId): PublicClient => {
    let c = clients.get(chain);
    if (!c) {
      const def = chainFor(chain);
      const rpc = rpcUrls[chain];
      c = createPublicClient({
        ...(def ? { chain: def } : {}),
        transport: rpc ? http(rpc) : http(),
      }) as PublicClient;
      clients.set(chain, c);
    }
    return c;
  };

  const blockscoutFor = (chain: ChainId): BlockscoutClient => {
    const base = config.blockscoutUrls?.[chain] ?? DEFAULT_BLOCKSCOUT[chain];
    if (!base) throw new Error(`no Blockscout URL configured for ${chain}`);
    return new BlockscoutClient(chain, base);
  };
  const blockscouts = new Map<ChainId, BlockscoutClient>();
  const bs = (chain: ChainId) => {
    let b = blockscouts.get(chain);
    if (!b) {
      b = blockscoutFor(chain);
      blockscouts.set(chain, b);
    }
    return b;
  };

  const requireEvm = (chain: ChainId) => {
    if (!EVM_CHAINS.has(chain)) throw new Error(`unsupported EVM chain: ${chain}`);
  };

  return {
    async getBalance(chain, address) {
      requireEvm(chain);
      const wei = await clientFor(chain).getBalance({
        address: address as `0x${string}`,
      });
      return wei.toString();
    },

    async getNonce(chain, address) {
      requireEvm(chain);
      return clientFor(chain).getTransactionCount({
        address: address as `0x${string}`,
      });
    },

    async getEnsName(chain, address) {
      requireEvm(chain);
      try {
        // Basenames resolve through the Base ENS universal resolver; ENS
        // names through mainnet. Failure means "no name", not an error.
        return await clientFor(chain).getEnsName({
          address: address as `0x${string}`,
        });
      } catch {
        return null;
      }
    },

    getTransactions: (chain, address): Promise<TxRecord[]> => {
      requireEvm(chain);
      return bs(chain).getTransactions(address);
    },

    getTokenTransfers: (chain, address): Promise<TokenTransferRecord[]> => {
      requireEvm(chain);
      return bs(chain).getTokenTransfers(address);
    },

    getApprovals: (chain, address): Promise<ApprovalRecord[]> => {
      requireEvm(chain);
      return bs(chain).getApprovals(address);
    },

    async getNearAccount(accountId): Promise<NearAccountInfo> {
      const res = await fetch(config.nearRpcUrl ?? DEFAULT_NEAR_RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "shelter",
          method: "query",
          params: {
            request_type: "view_account",
            finality: "final",
            account_id: accountId,
          },
        }),
      });
      if (!res.ok) throw new Error(`near rpc ${res.status}`);
      const body = (await res.json()) as {
        result?: { amount?: string; storage_usage?: number };
        error?: { data?: string };
      };
      if (body.error || !body.result) return { accountId, exists: false };
      return {
        accountId,
        exists: true,
        ...(body.result.amount !== undefined
          ? { balanceYocto: body.result.amount }
          : {}),
        ...(body.result.storage_usage !== undefined
          ? { storageUsage: body.result.storage_usage }
          : {}),
      };
    },
  };
}

export { BlockscoutClient } from "./blockscout.js";
export { FixtureReader } from "./fixture.js";
export type { FixtureAccount, FixtureProfile } from "./fixture.js";
export type {
  ApprovalRecord,
  ChainReader,
  ChainReaderConfig,
  NearAccountInfo,
  TokenTransferRecord,
  TxRecord,
} from "./types.js";
