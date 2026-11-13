/**
 * Decodes a parsed dapp request into plain words for the approval sheet:
 * method, contract, token, amount, recipient, spender, allowance.
 *
 * Built on @shelter/connect's own parser and ERC-20 decoder, so the sheet
 * says exactly what the linkage check and the engine saw.
 */

import {
  decodeErc20,
  describeRequest,
  messageText,
  type DappRequest,
} from "@shelter/connect";
import { formatUnits, maxUint160 } from "viem";
import { formatEth, formatToken, shortAddress } from "./connect-format";

export interface DecodedField {
  label: string;
  value: string;
  /** Addresses, hashes and other machine strings render monospace. */
  mono?: boolean;
  /** Render with the warning color. */
  warn?: boolean;
}

export interface DecodedRequest {
  method: string;
  /** One-line summary, same wording the engine logs. */
  headline: string;
  fields: DecodedField[];
  /** Plain-words warnings, e.g. an unlimited approval. */
  warnings: string[];
}

/** Well-known Base contracts the sheet can name instead of showing raw addresses. */
const TOKEN_CONTRACTS: Record<string, { name: string; symbol: string; decimals: number }> = {
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": { name: "USDC", symbol: "USDC", decimals: 6 },
  "0x4200000000000000000000000000000000000006": { name: "WETH", symbol: "WETH", decimals: 18 },
  "0x50c5725949a6f0c72e6c4a641f24049a917db0cb": { name: "DAI", symbol: "DAI", decimals: 18 },
};

const CONTRACT_NAMES: Record<string, string> = {
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": "USDC token contract",
  "0x000000000022d473030f116ddee9f6b43ac78ba3": "Permit2",
  "0x2626664c2603336e57b271c5c0b26f421741e481": "Uniswap SwapRouter02",
  "0xd6145b2d3f379919e8cdeda7b97e37c4b2ca9c40": "Uniswap Universal Router",
  "0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad": "Uniswap Universal Router",
  "0x6ff5693b99212da76ad316178a184ab56d299b43": "Uniswap Universal Router",
  "0xe592427a0aece92de3edee1f18e0157c05861564": "Uniswap Universal Router",
};

function contractLabel(addr: string): string {
  const name = CONTRACT_NAMES[addr.toLowerCase()];
  return name ? `${name} (${shortAddress(addr)})` : shortAddress(addr);
}

function tokenOf(addr: string | undefined): { name: string; symbol: string; decimals: number } | undefined {
  if (!addr) return undefined;
  return TOKEN_CONTRACTS[addr.toLowerCase()];
}

const METHOD_NAMES: Record<string, string> = {
  eth_sendTransaction: "Send transaction",
  personal_sign: "Sign message",
  eth_signTypedData_v4: "Sign typed data",
  wallet_switchEthereumChain: "Switch network",
  eth_chainId: "Read chain id",
  eth_accounts: "Read accounts",
};

function baseUnits(amount: bigint, token: { decimals: number } | undefined): string {
  return token ? formatUnits(amount, token.decimals) : amount.toString();
}

function decodeTransaction(req: Extract<DappRequest, { method: "eth_sendTransaction" }>): DecodedRequest {
  const t = req.tx;
  const fields: DecodedField[] = [
    { label: "Method", value: METHOD_NAMES[req.method] ?? req.method },
    { label: "Network", value: t.chainId === undefined ? "Base (8453)" : `chain ${t.chainId}` },
  ];
  const warnings: string[] = [];

  if (!t.to) {
    fields.push({ label: "Contract", value: "new contract (creation)", warn: true });
    warnings.push("Contract creation is not supported and is blocked.");
  } else {
    fields.push({ label: "Contract", value: contractLabel(t.to), mono: true });
  }

  if (t.value > 0n) fields.push({ label: "Value", value: formatEth(t.value.toString()) });

  const e = decodeErc20(t.data);
  if (e?.fn === "transfer") {
    const token = tokenOf(t.to);
    fields.push({ label: "Action", value: "Send tokens" });
    fields.push({ label: "Token", value: token ? `${token.name} (${contractLabel(t.to!)})` : contractLabel(t.to!), mono: !token });
    fields.push({ label: "Amount", value: token ? formatToken(e.amount.toString(), token.decimals, token.symbol) : `${e.amount} base units` });
    fields.push({ label: "Recipient", value: shortAddress(e.to), mono: true });
  } else if (e?.fn === "approve") {
    const token = tokenOf(t.to);
    const unlimited = e.amount >= maxUint160;
    fields.push({ label: "Action", value: "Approve tokens" });
    fields.push({ label: "Token", value: token ? `${token.name} (${contractLabel(t.to!)})` : contractLabel(t.to!), mono: !token });
    fields.push({ label: "Spender", value: contractLabel(e.spender), mono: true });
    fields.push({
      label: "Allowance",
      value: unlimited ? "Unlimited" : token ? formatToken(e.amount.toString(), token.decimals, token.symbol) : `${e.amount} base units`,
      warn: unlimited,
    });
    if (unlimited) {
      warnings.push("Unlimited approval: the spender can move any amount of this token, now and later.");
    }
  } else if (e?.fn === "transferFrom") {
    const token = tokenOf(t.to);
    fields.push({ label: "Action", value: "Move tokens" });
    fields.push({ label: "Token", value: token ? `${token.name} (${contractLabel(t.to!)})` : contractLabel(t.to!), mono: !token });
    fields.push({ label: "Amount", value: token ? formatToken(e.amount.toString(), token.decimals, token.symbol) : `${e.amount} base units` });
    fields.push({ label: "From", value: shortAddress(e.from), mono: true });
    fields.push({ label: "To", value: shortAddress(e.to), mono: true });
  } else if (t.data && t.data !== "0x") {
    const bytes = (t.data.length - 2) / 2;
    fields.push({ label: "Action", value: "Contract call" });
    fields.push({ label: "Call data", value: `${t.data.slice(0, 10)} (${bytes} bytes)`, mono: true });
  } else if (t.value === 0n) {
    fields.push({ label: "Action", value: "Send 0 ETH (likely a failed request)" });
  }

  return { method: req.method, headline: describeRequest(req), fields, warnings };
}

function decodeMessage(req: Extract<DappRequest, { method: "personal_sign" }>): DecodedRequest {
  const text = messageText(req.message);
  const oneLine = text.replace(/\s+/g, " ").trim();
  const shown = oneLine.length > 280 ? `${oneLine.slice(0, 277)}...` : oneLine;
  return {
    method: req.method,
    headline: describeRequest(req),
    fields: [
      { label: "Method", value: METHOD_NAMES[req.method] ?? req.method },
      { label: "Account", value: shortAddress(req.address), mono: true },
      { label: "Message", value: shown || "(empty)", mono: false },
    ],
    warnings: [],
  };
}

function decodeTypedData(req: Extract<DappRequest, { method: "eth_signTypedData_v4" }>): DecodedRequest {
  const td = req.typedData;
  const dom = (td.domain ?? {}) as { name?: unknown; verifyingContract?: unknown; chainId?: unknown };
  const m = td.message as Record<string, unknown>;
  const fields: DecodedField[] = [
    { label: "Method", value: METHOD_NAMES[req.method] ?? req.method },
    { label: "Type", value: String(td.primaryType) },
    { label: "Account", value: shortAddress(req.address), mono: true },
  ];
  if (dom.name) fields.push({ label: "Domain", value: String(dom.name) });
  if (dom.verifyingContract) fields.push({ label: "Verifying contract", value: contractLabel(String(dom.verifyingContract)), mono: true });
  if (dom.chainId !== undefined) fields.push({ label: "Chain", value: `chain ${String(dom.chainId)}` });
  const spender = typeof m.spender === "string" ? m.spender : undefined;
  if (spender) fields.push({ label: "Spender", value: contractLabel(spender), mono: true });
  const value = m.value ?? (m.details as Record<string, unknown> | undefined)?.amount ?? (m.permitted as Record<string, unknown> | undefined)?.amount;
  if (typeof value === "string" || typeof value === "number") {
    const unlimited = /^[0-9]+$/.test(String(value)) && BigInt(String(value)) >= maxUint160;
    fields.push({ label: "Amount", value: unlimited ? "Unlimited" : String(value), warn: unlimited });
  }
  const warnings: string[] = [];
  if (spender && spender.toLowerCase() === String(dom.verifyingContract ?? "").toLowerCase()) {
    warnings.push("The signature lets the contract spend tokens itself.");
  }
  return { method: req.method, headline: describeRequest(req), fields, warnings };
}

function decodeOther(req: DappRequest): DecodedRequest {
  const fields: DecodedField[] = [{ label: "Method", value: METHOD_NAMES[req.method] ?? req.method }];
  if (req.method === "wallet_switchEthereumChain") {
    fields.push({ label: "Chain", value: req.chainId === 8453 ? "Base (8453)" : `chain ${req.chainId}` });
  }
  if (req.method === "eth_chainId") fields.push({ label: "Result", value: "0x2105 (Base)" });
  if (req.method === "eth_accounts") fields.push({ label: "Result", value: "this dapp's address only" });
  return { method: req.method, headline: describeRequest(req), fields, warnings: [] };
}

/** Plain-words decode of any parsed dapp request. */
export function decodeDappRequest(req: DappRequest): DecodedRequest {
  switch (req.method) {
    case "eth_sendTransaction":
      return decodeTransaction(req);
    case "personal_sign":
      return decodeMessage(req);
    case "eth_signTypedData_v4":
      return decodeTypedData(req);
    default:
      return decodeOther(req);
  }
}
