"use client";

import { useMemo, useState } from "react";
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { GraphEdge, GraphNode, LinkGraph } from "@shelter/core";
import { shortenAddress } from "@/lib/flow/money";
import { cn } from "@/lib/utils";

type FlowNodeData = {
  label: string;
  kind: GraphNode["kind"];
  address: string;
};

function GraphNodeView({ data, selected }: NodeProps<Node<FlowNodeData>>) {
  const kind = data.kind;
  return (
    <div
      className={cn(
        "rounded-lg border px-2.5 py-1.5 text-xs shadow-sm",
        kind === "wallet"
          ? "border-primary/50 bg-card"
          : kind === "entity"
            ? "border-emerald-500/40 bg-emerald-500/5"
            : "border-border bg-muted/60",
        selected && "ring-2 ring-primary/60",
      )}
    >
      <Handle type="target" position={Position.Left} className="!bg-border" />
      <div className="font-medium text-foreground">
        {data.label || shortenAddress(data.address, 4)}
      </div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {kind}
      </div>
      <Handle type="source" position={Position.Right} className="!bg-border" />
    </div>
  );
}

const nodeTypes = { graph: GraphNodeView };

const EDGE_STYLE: Record<GraphEdge["kind"], { stroke: string; dash?: string }> = {
  transfer: { stroke: "#64748b" },
  "token-transfer": { stroke: "#38bdf8" },
  funding: { stroke: "#f59e0b", dash: "6 4" },
  approval: { stroke: "#f87171", dash: "2 4" },
};

function layoutGraph(graph: LinkGraph): { nodes: Node<FlowNodeData>[]; edges: Edge[] } {
  const wallets = graph.nodes.filter((n) => n.kind === "wallet");
  const others = graph.nodes.filter((n) => n.kind !== "wallet");
  const COLS = 2;
  const ROW_H = 84;
  const COL_W = 300;
  const rows = Math.max(1, Math.ceil(others.length / COLS));

  const nodes: Node<FlowNodeData>[] = [];
  wallets.forEach((n, i) => {
    nodes.push({
      id: n.id,
      type: "graph",
      position: { x: 0, y: i * ROW_H },
      data: { label: n.label ?? "", kind: n.kind, address: n.id },
    });
  });
  others.forEach((n, i) => {
    nodes.push({
      id: n.id,
      type: "graph",
      position: { x: COL_W * (Math.floor(i / rows) + 1), y: (i % rows) * ROW_H },
      data: { label: n.label ?? "", kind: n.kind, address: n.id },
    });
  });

  const edges: Edge[] = graph.edges.map((e, i) => {
    const style = EDGE_STYLE[e.kind];
    return {
      id: `e${i}`,
      source: e.from,
      target: e.to,
      data: { kind: e.kind },
      style: { stroke: style.stroke, strokeDasharray: style.dash, strokeWidth: 1.5 },
    };
  });
  return { nodes, edges };
}

export interface LinkGraphViewProps {
  graph: LinkGraph;
  className?: string;
}

export function LinkGraphView({ graph, className }: LinkGraphViewProps) {
  const [selected, setSelected] = useState<{
    kind: "node" | "edge";
    node?: GraphNode;
    edge?: GraphEdge;
  } | null>(null);

  const { nodes, edges } = useMemo(() => layoutGraph(graph), [graph]);
  const edgeById = useMemo(() => {
    const m = new Map<string, GraphEdge>();
    graph.edges.forEach((e, i) => m.set(`e${i}`, e));
    return m;
  }, [graph]);
  const nodeById = useMemo(() => {
    const m = new Map<string, GraphNode>();
    for (const n of graph.nodes) m.set(n.id, n);
    return m;
  }, [graph]);

  const empty = graph.nodes.length <= 1 && graph.edges.length === 0;

  if (empty) {
    return (
      <div
        className={cn(
          "flex h-48 items-center justify-center rounded-xl border border-dashed border-border text-sm text-muted-foreground",
          className,
        )}
      >
        No links detected in this dataset — the graph is empty.
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <div className="h-[380px] w-full overflow-hidden rounded-xl border border-border bg-card/40">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          minZoom={0.4}
          maxZoom={1.6}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable
          onNodeClick={(_, node) => {
            const n = nodeById.get(node.id);
            if (n) setSelected({ kind: "node", node: n });
          }}
          onEdgeClick={(_, edge) => {
            const e = edgeById.get(edge.id);
            if (e) setSelected({ kind: "edge", edge: e });
          }}
          onPaneClick={() => setSelected(null)}
          proOptions={{ hideAttribution: false }}
        >
          <Background gap={20} size={1} color="var(--border)" />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>

      {selected ? (
        <div
          role="status"
          className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm"
        >
          {selected.kind === "node" && selected.node ? (
            <>
              <span className="font-medium">
                {selected.node.label ?? "Address"}
              </span>{" "}
              <span className="text-muted-foreground">
                ({selected.node.kind}) — {shortenAddress(selected.node.id, 8)}
              </span>
              <p className="mt-1 text-xs text-muted-foreground">
                {selected.node.kind === "wallet"
                  ? "One of the scanned wallets."
                  : selected.node.kind === "entity"
                    ? "A labelled entity (exchange, OFAC list or user tag)."
                    : "A counterparty address seen in the recorded history."}
              </p>
            </>
          ) : selected.edge ? (
            <>
              <span className="font-medium">{selected.edge.kind}</span>{" "}
              <span className="text-muted-foreground">
                {shortenAddress(selected.edge.from, 6)} →{" "}
                {shortenAddress(selected.edge.to, 6)} on {selected.edge.chain}
              </span>
              <p className="mt-1 text-xs text-muted-foreground">
                {[
                  selected.edge.amount
                    ? `amount ${selected.edge.amount}`
                    : null,
                  selected.edge.timestamp
                    ? `time ${new Date(selected.edge.timestamp * 1000).toISOString()}`
                    : null,
                  selected.edge.txHash
                    ? `tx ${shortenAddress(selected.edge.txHash, 8)}`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ") || "No extra detail recorded."}
              </p>
            </>
          ) : null}
        </div>
      ) : null}

      <details className="rounded-xl border border-border bg-card/40 px-3 py-2 text-sm">
        <summary className="cursor-pointer font-medium text-foreground">
          Graph data — keyboard accessible ({graph.nodes.length} nodes,{" "}
          {graph.edges.length} edges)
        </summary>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <caption className="sr-only">Link graph edges</caption>
            <thead>
              <tr className="border-b border-border text-muted-foreground">
                <th className="py-1 pr-3 font-medium">From</th>
                <th className="py-1 pr-3 font-medium">To</th>
                <th className="py-1 pr-3 font-medium">Kind</th>
                <th className="py-1 pr-3 font-medium">Chain</th>
                <th className="py-1 pr-3 font-medium">Amount</th>
                <th className="py-1 font-medium">Tx</th>
              </tr>
            </thead>
            <tbody>
              {graph.edges.map((e, i) => (
                <tr key={i} className="border-b border-border/50 last:border-0">
                  <td className="py-1 pr-3 font-mono">
                    {shortenAddress(e.from, 5)}
                  </td>
                  <td className="py-1 pr-3 font-mono">
                    {shortenAddress(e.to, 5)}
                  </td>
                  <td className="py-1 pr-3">{e.kind}</td>
                  <td className="py-1 pr-3">{e.chain}</td>
                  <td className="py-1 pr-3 font-mono">{e.amount ?? "—"}</td>
                  <td className="py-1 font-mono">
                    {e.txHash ? shortenAddress(e.txHash, 5) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ul className="mt-3 flex flex-col gap-1 text-xs text-muted-foreground">
          {graph.nodes.map((n) => (
            <li key={n.id}>
              <span className="font-mono">{shortenAddress(n.id, 6)}</span> —{" "}
              {n.kind}
              {n.label ? ` (${n.label})` : ""}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
