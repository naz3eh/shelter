"use client";

/**
 * Before/after link diagrams for Shelter Connect: the node graph layout
 * (fixed 380x340 viewBox, 140x52 nodes, straight edges with midpoint label
 * boxes) fed by lib/connect-graph-data.ts. No graph library.
 */

import type { LinkDiagram } from "@/lib/connect-graph-data";
import { DIAGRAMS } from "@/lib/connect-graph-data";
import { truncMid } from "./primitives";

const W = 140;
const H = 52;

function Graph({
  diagram,
  dappAddress,
}: {
  diagram: LinkDiagram;
  dappAddress?: string;
}) {
  const nodes = diagram.nodes.map((n) =>
    n.id === "dapp" && dappAddress ? { ...n, sub: truncMid(dappAddress) } : n,
  );
  const c = (id: string) => {
    const n = nodes.find((n) => n.id === id)!;
    return { x: n.x + W / 2, y: n.y + H / 2 };
  };
  return (
    <svg
      viewBox="0 0 380 340"
      role="img"
      aria-label={`${diagram.title}: ${diagram.caption}`}
      className="mx-auto h-auto w-full max-w-[440px]"
    >
      {diagram.edges.map((e, i) => {
        const p = c(e.a);
        const q = c(e.b);
        return (
          <line
            key={i}
            x1={p.x}
            y1={p.y}
            x2={q.x}
            y2={q.y}
            strokeWidth={1.5}
            className={e.blocked ? "stroke-destructive" : "stroke-muted-foreground/70"}
            strokeDasharray={e.blocked ? "5 4" : undefined}
          />
        );
      })}
      {nodes.map((n) => (
        <g key={n.id}>
          <rect
            x={n.x}
            y={n.y}
            width={W}
            height={H}
            rx={10}
            className={n.focus ? "fill-surface-2 stroke-shelter/60" : "fill-surface-2 stroke-border"}
            strokeWidth={1}
          />
          <text
            x={n.x + W / 2}
            y={n.y + 22}
            textAnchor="middle"
            className="fill-foreground text-[11.5px] font-semibold"
          >
            {n.title}
          </text>
          <text
            x={n.x + W / 2}
            y={n.y + 38}
            textAnchor="middle"
            className={
              n.sub.startsWith("0x")
                ? "fill-muted-foreground font-mono text-[9.5px]"
                : "fill-muted-foreground text-[9.5px]"
            }
          >
            {n.sub}
          </text>
        </g>
      ))}
      {diagram.edges.map((e, i) => {
        const p = c(e.a);
        const q = c(e.b);
        const mx = e.labelPos?.[0] ?? (p.x + q.x) / 2;
        const my = e.labelPos?.[1] ?? (p.y + q.y) / 2;
        const lines = e.label.split("\n");
        const w = Math.max(...lines.map((l) => l.length)) * 5.1 + 12;
        const h = lines.length * 12 + 6;
        return (
          <g key={`l${i}`}>
            <rect
              x={mx - w / 2}
              y={my - h / 2}
              width={w}
              height={h}
              rx={5}
              className={e.blocked ? "fill-background stroke-destructive/40" : "fill-background stroke-border"}
            />
            {lines.map((l, j) => (
              <text
                key={j}
                x={mx}
                y={my - h / 2 + 13 + j * 12}
                textAnchor="middle"
                className={e.blocked ? "fill-destructive text-[9.5px] font-medium" : "fill-muted-foreground text-[9.5px]"}
              >
                {l}
              </text>
            ))}
          </g>
        );
      })}
    </svg>
  );
}

export function TodayDiagram({ dappAddress }: { dappAddress?: string }) {
  return <Graph diagram={DIAGRAMS[0]!} dappAddress={dappAddress} />;
}

export function AfterDiagram({ dappAddress }: { dappAddress?: string }) {
  return <Graph diagram={DIAGRAMS[1]!} dappAddress={dappAddress} />;
}
