/**
 * Dapp requests as Connect understands them: parsed from EIP-1193 JSON-RPC
 * (method + params), checked for shape, and described in plain words for
 * the approval prompt.
 *
 * Connect serves one chain (Base) and one account per dapp. It signs
 * transactions, personal messages and EIP-712 typed data. It never signs a
 * raw hash (`eth_sign`) or an unsent transaction (`eth_signTransaction`):
 * both hand the dapp something it could use anywhere, unseen.
 */

import {
  decodeFunctionData,
  erc20Abi,
  formatUnits,
  getAddress,
  hexToBytes,
  isAddress,
  isHex,
  maxUint160,
  type Hex,
  type TypedDataDefinition,
} from "viem";
import { ConnectError } from "./errors.js";

export const BASE_CHAIN_ID = 8453;

export interface TxParams {
  from?: `0x${string}`;
  /** Absent for a contract creation, which Connect refuses. */
  to?: `0x${string}`;
  data?: Hex;
  value: bigint;
  gas?: bigint;
  chainId?: number;
}

export type TypedData = TypedDataDefinition & { domain?: Record<string, unknown> };

export type DappRequest =
  | { method: "eth_sendTransaction"; tx: TxParams }
  | { method: "personal_sign"; address: `0x${string}`; message: Hex | string }
  | { method: "eth_signTypedData_v4"; address: `0x${string}`; typedData: TypedData }
  | { method: "wallet_switchEthereumChain"; chainId: number }
  | { method: "eth_chainId" }
  | { method: "eth_accounts" };

export const SIGNING_METHODS = ["eth_sendTransaction", "personal_sign", "eth_signTypedData_v4"] as const;
export const SERVED_METHODS = [...SIGNING_METHODS, "wallet_switchEthereumChain", "eth_chainId", "eth_accounts"] as const;

const REFUSED: Record<string, string> = {
  eth_sign: "eth_sign signs a raw hash the user cannot read; Shelter never signs one",
  eth_signTransaction: "Shelter only signs transactions it sends itself",
  eth_signTypedData: "only eth_signTypedData_v4 is supported",
  eth_signTypedData_v3: "only eth_signTypedData_v4 is supported",
  wallet_addEthereumChain: "Shelter Connect only serves Base",
};

const addr = (v: unknown, what: string): `0x${string}` => {
  if (typeof v !== "string" || !isAddress(v, { strict: false })) throw new ConnectError("validation", `${what} is not an address`);
  return getAddress(v);
};

const quantity = (v: unknown, what: string): bigint | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === "string" && /^0x[0-9a-fA-F]+$/.test(v)) return BigInt(v);
  if (typeof v === "string" && /^[0-9]+$/.test(v)) return BigInt(v);
  throw new ConnectError("validation", `${what} is not a quantity`);
};

const chainIdOf = (v: unknown): number => {
  const n = quantity(v, "chainId");
  if (n === undefined || n > BigInt(Number.MAX_SAFE_INTEGER)) throw new ConnectError("validation", "chainId is missing");
  return Number(n);
};

/** Parses one JSON-RPC request. Throws `unsupported` or `validation`. */
export function parseRequest(method: string, params: unknown): DappRequest {
  if (REFUSED[method]) throw new ConnectError("unsupported", REFUSED[method]);
  const p = Array.isArray(params) ? params : [];
  switch (method) {
    case "eth_chainId":
    case "eth_accounts":
      return { method };
    case "wallet_switchEthereumChain": {
      const o = p[0] as { chainId?: unknown } | undefined;
      return { method, chainId: chainIdOf(o?.chainId) };
    }
    case "eth_sendTransaction": {
      const t = p[0] as Record<string, unknown> | undefined;
      if (!t || typeof t !== "object") throw new ConnectError("validation", "transaction is missing");
      const data = t.data ?? t.input;
      if (data !== undefined && data !== null && (typeof data !== "string" || !isHex(data) || data.length % 2 !== 0)) {
        throw new ConnectError("validation", "transaction data is not hex");
      }
      return {
        method,
        tx: {
          from: t.from === undefined ? undefined : addr(t.from, "from"),
          to: t.to === undefined || t.to === null ? undefined : addr(t.to, "to"),
          data: (data as Hex | undefined) ?? undefined,
          value: quantity(t.value, "value") ?? 0n,
          gas: quantity(t.gas ?? t.gasLimit, "gas"),
          chainId: t.chainId === undefined ? undefined : chainIdOf(t.chainId),
        },
      };
    }
    case "personal_sign": {
      // The spec order is [message, address]; some dapps send [address, message].
      const [a, b] = p;
      const swapped = typeof a === "string" && isAddress(a, { strict: false }) && !(typeof b === "string" && isAddress(b, { strict: false }));
      const message = swapped ? b : a;
      const address = swapped ? a : b;
      if (typeof message !== "string") throw new ConnectError("validation", "message is missing");
      return { method, address: addr(address, "signing address"), message };
    }
    case "eth_signTypedData_v4": {
      const [a, raw] = p;
      let typedData: unknown = raw;
      if (typeof raw === "string") {
        try {
          typedData = JSON.parse(raw);
        } catch {
          throw new ConnectError("validation", "typed data is not JSON");
        }
      }
      const td = typedData as { types?: unknown; primaryType?: unknown; message?: unknown; domain?: unknown } | null;
      if (!td || typeof td !== "object" || typeof td.types !== "object" || typeof td.primaryType !== "string" || typeof td.message !== "object") {
        throw new ConnectError("validation", "typed data needs types, primaryType and message");
      }
      return { method, address: addr(a, "signing address"), typedData: td as unknown as TypedData };
    }
    default:
      throw new ConnectError("unsupported", `method ${method} is not supported`);
  }
}

/** The message as text when it is UTF-8, else its hex. */
export function messageText(message: Hex | string): string {
  if (!isHex(message)) return message;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(hexToBytes(message));
  } catch {
    return message;
  }
}

const UNLIMITED = (v: bigint) => v >= maxUint160;

/** Known ERC-20 calls, decoded. */
export function decodeErc20(data: Hex | undefined):
  | { fn: "transfer"; to: `0x${string}`; amount: bigint }
  | { fn: "approve"; spender: `0x${string}`; amount: bigint }
  | { fn: "transferFrom"; from: `0x${string}`; to: `0x${string}`; amount: bigint }
  | null {
  if (!data || data.length < 10) return null;
  try {
    const d = decodeFunctionData({ abi: erc20Abi, data });
    if (d.functionName === "transfer") return { fn: "transfer", to: getAddress(d.args[0]), amount: d.args[1] };
    if (d.functionName === "approve") return { fn: "approve", spender: getAddress(d.args[0]), amount: d.args[1] };
    if (d.functionName === "transferFrom") return { fn: "transferFrom", from: getAddress(d.args[0]), to: getAddress(d.args[1]), amount: d.args[2] };
  } catch {
    /* not an ERC-20 call */
  }
  return null;
}

/** One line for the approval prompt and the account log. */
export function describeRequest(req: DappRequest): string {
  switch (req.method) {
    case "eth_sendTransaction": {
      const t = req.tx;
      const value = t.value > 0n ? `, sending ${formatUnits(t.value, 18)} ETH` : "";
      const e = decodeErc20(t.data);
      if (e?.fn === "transfer") return `token transfer on ${t.to}: ${e.amount} base units to ${e.to}${value}`;
      if (e?.fn === "approve") {
        return `token approval on ${t.to}: lets ${e.spender} spend ${UNLIMITED(e.amount) ? "an UNLIMITED amount" : `${e.amount} base units`}${value}`;
      }
      if (e?.fn === "transferFrom") return `token transferFrom on ${t.to}: ${e.amount} base units from ${e.from} to ${e.to}${value}`;
      if (!t.data || t.data === "0x") return `send ${formatUnits(t.value, 18)} ETH to ${t.to}`;
      return `contract call ${t.data.slice(0, 10)} on ${t.to} (${(t.data.length - 2) / 2} bytes of data)${value}`;
    }
    case "personal_sign": {
      const text = messageText(req.message);
      const oneLine = text.replace(/\s+/g, " ").trim();
      return `sign message: "${oneLine.length > 160 ? `${oneLine.slice(0, 157)}...` : oneLine}"`;
    }
    case "eth_signTypedData_v4": {
      const td = req.typedData;
      const dom = (td.domain ?? {}) as { name?: unknown; verifyingContract?: unknown };
      const m = td.message as Record<string, unknown>;
      const spender = typeof m.spender === "string" ? `, spender ${m.spender}` : "";
      const value = typeof m.value === "string" || typeof m.value === "number" ? `, value ${String(m.value)}` : "";
      return `sign typed data ${String(td.primaryType)} for ${String(dom.name ?? "an unnamed domain")}${dom.verifyingContract ? ` (${String(dom.verifyingContract)})` : ""}${spender}${value}`;
    }
    case "wallet_switchEthereumChain":
      return `switch to chain ${req.chainId}`;
    default:
      return req.method;
  }
}

