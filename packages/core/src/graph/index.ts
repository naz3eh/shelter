import type { ChainId } from "../index.js";
import type {
  ApprovalRecord,
  TokenTransferRecord,
  TxRecord,
} from "../reader/types.js";

/** Plain-JSON link graph. No rendering library lives in core. */

export interface GraphNode {
  id: string;
  kind: "wallet" | "counterparty" | "entity";
  label?: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: "transfer" | "token-transfer" | "funding" | "approval";
  chain: ChainId;
  txHash?: string;
  /** Amount in wei or token units, decimal string. */
  amount?: string;
  timestamp?: number;
}

export interface LinkGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphWalletData {
  address: string;
  chain: ChainId;
  transactions: TxRecord[];
  tokenTransfers: TokenTransferRecord[];
  approvals: ApprovalRecord[];
}

/**
 * Build the link graph over the user's scanned wallets and every counterparty
 * they touched. `labelOf` maps an address to an entity label (exchange,
 * OFAC entry, user tag) so those counterparties become labelled nodes.
 */
export function buildLinkGraph(
  wallets: GraphWalletData[],
  labelOf: (chain: ChainId, address: string) => string | null = () => null,
): LinkGraph {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const walletAddrs = new Set(wallets.map((w) => w.address.toLowerCase()));

  const node = (id: string, kind: GraphNode["kind"], label?: string) => {
    const key = id.toLowerCase();
    const existing = nodes.get(key);
    if (existing) {
      if (label && !existing.label) existing.label = label;
      if (existing.kind === "counterparty" && kind === "wallet")
        existing.kind = "wallet";
      return existing;
    }
    const n: GraphNode = { id: key, kind, ...(label ? { label } : {}) };
    nodes.set(key, n);
    return n;
  };

  for (const w of wallets) node(w.address, "wallet");

  for (const w of wallets) {
    const self = w.address.toLowerCase();
    let firstFundingSeen = false;
    const incoming = [...w.transactions, ...w.tokenTransfers]
      .filter((t) => t.to?.toLowerCase() === self)
      .sort((a, b) => a.timestamp - b.timestamp);

    for (const t of w.transactions) {
      if (!t.to) continue;
      const other = t.to.toLowerCase() === self ? t.from : t.to;
      const label = labelOf(w.chain, other) ?? undefined;
      node(other, walletAddrs.has(other) ? "wallet" : label ? "entity" : "counterparty", label);
      const isFunding =
        !firstFundingSeen &&
        t.to.toLowerCase() === self &&
        incoming[0]?.hash === t.hash;
      if (isFunding) firstFundingSeen = true;
      edges.push({
        from: t.from.toLowerCase(),
        to: t.to.toLowerCase(),
        kind: isFunding ? "funding" : "transfer",
        chain: w.chain,
        txHash: t.hash,
        amount: t.valueWei,
        timestamp: t.timestamp,
      });
    }
    for (const t of w.tokenTransfers) {
      if (!t.to) continue;
      const other = t.to.toLowerCase() === self ? t.from : t.to;
      const label = labelOf(w.chain, other) ?? undefined;
      node(other, walletAddrs.has(other) ? "wallet" : label ? "entity" : "counterparty", label);
      edges.push({
        from: t.from.toLowerCase(),
        to: t.to.toLowerCase(),
        kind: "token-transfer",
        chain: w.chain,
        txHash: t.hash,
        amount: t.value,
        timestamp: t.timestamp,
      });
    }
    for (const a of w.approvals) {
      const label = labelOf(w.chain, a.spender) ?? undefined;
      node(a.spender, walletAddrs.has(a.spender.toLowerCase()) ? "wallet" : label ? "entity" : "counterparty", label);
      edges.push({
        from: a.owner.toLowerCase(),
        to: a.spender.toLowerCase(),
        kind: "approval",
        chain: w.chain,
        txHash: a.txHash,
      });
    }
  }

  return { nodes: [...nodes.values()], edges };
}
