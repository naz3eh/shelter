/**
 * The few Base reads and the one write the burner engine needs, over viem.
 *
 * Every call goes to the user's own RPC (`rpcUrl`); each one reveals the
 * burner address to whoever runs it. The public default
 * (https://mainnet.base.org) is rate limited and sees the same addresses,
 * so the CLI asks for `BASE_RPC_URL`.
 */

import {
  createPublicClient,
  erc20Abi,
  http,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type Hex,
} from "viem";
import { base } from "viem/chains";
import { publicActionsL2 } from "viem/op-stack";
import { BASE_CHAIN_ID } from "./assets.js";
import { BurnerError } from "./errors.js";

export interface TxRequest {
  from: `0x${string}`;
  to: `0x${string}`;
  data?: Hex;
  value?: bigint;
}

export interface Fees {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

export interface Receipt {
  status: "success" | "reverted";
  blockNumber: bigint;
  gasUsed: bigint;
  /** L2 execution fee plus the L1 data fee, in wei. */
  feeWei: bigint;
}

export interface ChainClient {
  readonly chainId: number;
  nativeBalance(address: `0x${string}`): Promise<bigint>;
  tokenBalance(token: `0x${string}`, address: `0x${string}`): Promise<bigint>;
  /** Transaction count including pending transactions. */
  nonce(address: `0x${string}`): Promise<number>;
  fees(): Promise<Fees>;
  estimateGas(tx: TxRequest): Promise<bigint>;
  /** OP-stack L1 data fee for this transaction, in wei. */
  l1Fee(tx: TxRequest & { gas: bigint } & Fees & { nonce: number }): Promise<bigint>;
  sendRaw(raw: Hex): Promise<Hex>;
  receipt(hash: Hex): Promise<Receipt | null>;
  /** True when the node knows the transaction (pending or mined). */
  knows(hash: Hex): Promise<boolean>;
}

export interface BaseChainOptions {
  rpcUrl: string;
  timeoutMs?: number;
}

export function createBaseChain(opts: BaseChainOptions): ChainClient {
  if (!/^https:\/\//.test(opts.rpcUrl) && !/^http:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(opts.rpcUrl)) {
    throw new BurnerError("validation", "the Base RPC URL must be https (or http on localhost)");
  }
  const client = createPublicClient({
    chain: base,
    transport: http(opts.rpcUrl, { timeout: opts.timeoutMs ?? 15_000, retryCount: 2 }),
  }).extend(publicActionsL2());

  const wrap = async <T>(what: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (cause) {
      throw new BurnerError("chain", `Base RPC: ${what} failed: ${shortMessage(cause)}`, { cause });
    }
  };

  let checkedChain: Promise<void> | undefined;
  const ensureChain = () =>
    (checkedChain ??= wrap("eth_chainId", () => client.getChainId()).then((id) => {
      if (id !== BASE_CHAIN_ID) {
        checkedChain = undefined;
        throw new BurnerError("validation", `the RPC serves chain ${id}, not Base (${BASE_CHAIN_ID})`);
      }
    }));

  return {
    chainId: BASE_CHAIN_ID,
    async nativeBalance(address) {
      await ensureChain();
      return wrap("getBalance", () => client.getBalance({ address }));
    },
    async tokenBalance(token, address) {
      await ensureChain();
      return wrap("balanceOf", () => client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [address] }));
    },
    async nonce(address) {
      await ensureChain();
      return wrap("getTransactionCount", () => client.getTransactionCount({ address, blockTag: "pending" }));
    },
    async fees() {
      await ensureChain();
      const f = await wrap("fee estimate", () => client.estimateFeesPerGas({ type: "eip1559" }));
      return { maxFeePerGas: f.maxFeePerGas, maxPriorityFeePerGas: f.maxPriorityFeePerGas };
    },
    async estimateGas(tx) {
      await ensureChain();
      return wrap("estimateGas", () => client.estimateGas({ account: tx.from, to: tx.to, data: tx.data, value: tx.value }));
    },
    async l1Fee(tx) {
      await ensureChain();
      return wrap("L1 fee estimate", () =>
        client.estimateL1Fee({
          account: tx.from,
          to: tx.to,
          data: tx.data,
          value: tx.value,
          gas: tx.gas,
          nonce: tx.nonce,
          maxFeePerGas: tx.maxFeePerGas,
          maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
          chain: base,
        }),
      );
    },
    async sendRaw(raw) {
      await ensureChain();
      return wrap("sendRawTransaction", () => client.sendRawTransaction({ serializedTransaction: raw }));
    },
    async receipt(hash) {
      await ensureChain();
      try {
        const r = await client.getTransactionReceipt({ hash });
        const l1 = (r as { l1Fee?: bigint | null }).l1Fee ?? 0n;
        return { status: r.status, blockNumber: r.blockNumber, gasUsed: r.gasUsed, feeWei: r.gasUsed * r.effectiveGasPrice + l1 };
      } catch (e) {
        if (e instanceof TransactionReceiptNotFoundError) return null;
        throw new BurnerError("chain", `Base RPC: getTransactionReceipt failed: ${shortMessage(e)}`, { cause: e });
      }
    },
    async knows(hash) {
      await ensureChain();
      try {
        await client.getTransaction({ hash });
        return true;
      } catch (e) {
        if (e instanceof TransactionNotFoundError) return false;
        throw new BurnerError("chain", `Base RPC: getTransaction failed: ${shortMessage(e)}`, { cause: e });
      }
    },
  };
}

function shortMessage(e: unknown): string {
  const m = (e as { shortMessage?: string })?.shortMessage ?? (e instanceof Error ? e.message : String(e));
  return m.split("\n")[0]!.slice(0, 300);
}
