/**
 * The before/after link diagrams for Shelter Connect, expressed in the scan
 * graph's own types (packages/core/src/graph). Positions are hand-laid-out:
 * these are small fixed diagrams, not a force layout.
 */

import type { GraphEdge, GraphNode, LinkGraph } from "@shelter/core";

export interface GraphSpecNode {
  node: GraphNode;
  x: number;
  y: number;
  /** Second line under the label (address, role). */
  sublabel?: string;
  /** Rendered faded: present but not connected. */
  ghost?: boolean;
}

export interface GraphSpecEdge {
  edge: GraphEdge;
  label?: string;
  /** "blocked" draws the dashed red line with a cross: the request was refused. */
  tone?: "normal" | "blocked" | "warn";
  /** Curve offset for parallel edges, -1..1. */
  bend?: number;
}

export interface LinkDiagram {
  title: string;
  caption: string;
  viewBox: string;
  nodes: GraphSpecNode[];
  edges: GraphSpecEdge[];
}

const node = (id: string, kind: GraphNode["kind"], label: string): GraphNode => ({ id, kind, label });
const edge = (from: string, to: string, kind: GraphEdge["kind"], chain: GraphEdge["chain"] = "base"): GraphEdge => ({
  from,
  to,
  kind,
  chain,
});

/** "Today": wallets tied to each other and visible to the dapp. */
export const TODAY: LinkDiagram = {
  title: "Today",
  caption: "Your wallets are linked to each other, and the dapp sees your main wallet.",
  viewBox: "0 0 380 250",
  nodes: [
    { node: node("near", "wallet", "Your NEAR account"), x: 60, y: 60, sublabel: "owns the confidential balance" },
    { node: node("conf", "entity", "Confidential balance"), x: 60, y: 185, sublabel: "intents.far" },
    { node: node("main", "wallet", "Your main wallet"), x: 195, y: 60, sublabel: "EVM, exchanges, history" },
    { node: node("dapp", "counterparty", "Uniswap"), x: 315, y: 122, sublabel: "the dapp" },
  ],
  edges: [
    { edge: edge("near", "conf", "funding"), label: "deposit", bend: -0.4 },
    { edge: edge("near", "main", "transfer"), label: "same owner: linkable", tone: "warn", bend: 0.5 },
    { edge: edge("main", "dapp", "transfer"), label: "dapp sees this address", tone: "warn", bend: -0.4 },
    { edge: edge("conf", "dapp", "transfer"), tone: "blocked", bend: 0.8, label: "no way to spend privately" },
  ],
};

/** "After Connect": the dapp address stands alone; the confidential balance is its only funder. */
export const AFTER: LinkDiagram = {
  title: "After Connect",
  caption: "Each dapp gets its own address. The confidential balance is the only funder, and the link back is blocked.",
  viewBox: "0 0 420 260",
  nodes: [
    { node: node("conf", "entity", "Confidential balance"), x: 60, y: 130, sublabel: "intents.far" },
    { node: node("dappaddr", "wallet", "Dapp address"), x: 205, y: 60, sublabel: "0xe5bd…f9b, this dapp only" },
    { node: node("dapp", "counterparty", "Uniswap"), x: 205, y: 200, sublabel: "the dapp" },
    { node: node("near", "wallet", "Your NEAR account"), x: 365, y: 55, ghost: true },
    { node: node("main", "wallet", "Your main wallet"), x: 365, y: 205, ghost: true },
  ],
  edges: [
    { edge: edge("conf", "dappaddr", "funding"), label: "1Click withdraw", bend: -0.6 },
    { edge: edge("dappaddr", "dapp", "transfer"), label: "signed requests", bend: 0 },
    { edge: edge("dappaddr", "conf", "funding"), label: "sweep back", bend: 0.6 },
    { edge: edge("dappaddr", "near", "transfer"), tone: "blocked", bend: -0.5, label: "blocked" },
    { edge: edge("dappaddr", "main", "transfer"), tone: "blocked", bend: 0.5, label: "blocked" },
  ],
};

export const DIAGRAMS: LinkDiagram[] = [TODAY, AFTER];
