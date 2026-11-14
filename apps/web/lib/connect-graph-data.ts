/**
 * The before/after link diagrams for Shelter Connect. Positions are
 * hand-laid-out in the 380x340 viewBox used by components/connect/diagrams.tsx:
 * nodes are 140x52 boxes at top-left (x, y); edges are straight lines whose
 * labels sit in a box at the midpoint.
 */

export interface GraphNodeSpec {
  id: string;
  x: number;
  y: number;
  title: string;
  sub: string;
  /** Drawn with the shelter accent ring: the node the session is about. */
  focus?: boolean;
}

export interface GraphEdgeSpec {
  a: string;
  b: string;
  /** May contain "\n" for a two-line label box. */
  label: string;
  /** Red dashed edge with a red label: the request was refused. */
  blocked?: boolean;
  /** Absolute centre of the label box in viewBox coords (default: edge midpoint). */
  labelPos?: [number, number];
}

export interface LinkDiagram {
  title: string;
  caption: string;
  nodes: GraphNodeSpec[];
  edges: GraphEdgeSpec[];
}

/** "Today": wallets tied to each other and visible to the dapp. */
export const TODAY: LinkDiagram = {
  title: "Today",
  caption: "Your wallets are linked to each other, and the dapp sees your main wallet.",
  nodes: [
    { id: "near", x: 10, y: 20, title: "Your NEAR account", sub: "owns the confidential balance" },
    { id: "main", x: 230, y: 20, title: "Your main wallet", sub: "EVM, exchanges, history" },
    { id: "conf", x: 10, y: 268, title: "Confidential balance", sub: "intents.far" },
    { id: "uni", x: 230, y: 268, title: "Uniswap", sub: "the dapp" },
  ],
  edges: [
    { a: "near", b: "main", label: "linked", blocked: true },
    { a: "near", b: "conf", label: "deposit" },
    { a: "main", b: "uni", label: "dapp sees\nthis address" },
    // Lifted into the clear band between the two rows: at the edge midpoint
    // the two-line box is wider than the gap between the conf and dapp nodes.
    { a: "conf", b: "uni", label: "no way to\nspend privately", blocked: true, labelPos: [190, 232] },
  ],
};

/** "After Connect": the dapp address stands alone; the confidential balance is its only funder. */
export const AFTER: LinkDiagram = {
  title: "After Connect",
  caption: "Each dapp gets its own address. The confidential balance is the only funder, and the link back is blocked.",
  nodes: [
    { id: "near", x: 10, y: 20, title: "Your NEAR account", sub: "owns the confidential balance" },
    { id: "main", x: 230, y: 20, title: "Your main wallet", sub: "EVM, exchanges, history" },
    // sub is filled from the recorded session's dapp address at render time.
    { id: "dapp", x: 120, y: 144, title: "Dapp address", sub: "", focus: true },
    { id: "conf", x: 10, y: 268, title: "Confidential balance", sub: "intents.far" },
    { id: "uni", x: 230, y: 268, title: "Uniswap", sub: "the dapp" },
  ],
  edges: [
    { a: "dapp", b: "near", label: "blocked", blocked: true },
    { a: "dapp", b: "main", label: "blocked", blocked: true },
    { a: "conf", b: "dapp", label: "1Click withdraw\nsweep back" },
    { a: "dapp", b: "uni", label: "signed requests" },
  ],
};

export const DIAGRAMS: LinkDiagram[] = [TODAY, AFTER];
