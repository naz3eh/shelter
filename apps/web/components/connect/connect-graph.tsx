"use client";

/**
 * Before/after link diagram for Shelter Connect. Renders the LinkGraph-typed
 * data from lib/connect-graph-data.ts as inline SVG with Motion entrances.
 * No graph library.
 */

import { motion, useReducedMotion } from "motion/react";
import type { LinkDiagram, GraphSpecNode } from "@/lib/connect-graph-data";
import { DIAGRAMS } from "@/lib/connect-graph-data";
import type { ConnectAccountView } from "@/lib/connect-source";
import { cn } from "@/lib/utils";

const NODE_W = 132;
const NODE_H = 46;

interface EdgeGeom {
  d: string;
  /** Quadratic control point. */
  c: { x: number; y: number };
  p0: { x: number; y: number };
  p1: { x: number; y: number };
}

function edgeGeom(
  from: GraphSpecNode & { x: number; y: number },
  to: GraphSpecNode & { x: number; y: number },
  bend = 0,
): EdgeGeom {
  // Anchor points: right/left edges when the nodes are side by side,
  // bottom/top when stacked.
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  let x1: number, y1: number, x2: number, y2: number;
  if (ax > ay * 1.4) {
    // horizontal-ish
    if (dx >= 0) {
      x1 = from.x + NODE_W / 2;
      x2 = to.x - NODE_W / 2;
    } else {
      x1 = from.x - NODE_W / 2;
      x2 = to.x + NODE_W / 2;
    }
    y1 = from.y;
    y2 = to.y;
  } else {
    if (dy >= 0) {
      y1 = from.y + NODE_H / 2;
      y2 = to.y - NODE_H / 2;
    } else {
      y1 = from.y - NODE_H / 2;
      y2 = to.y + NODE_H / 2;
    }
    x1 = from.x;
    x2 = to.x;
  }
  const p0 = { x: x1, y: y1 };
  const p1 = { x: x2, y: y2 };
  const c = {
    x: (x1 + x2) / 2 + bend * 60 * Math.sign(dx || 1 || dy),
    y: (y1 + y2) / 2 + bend * 60 * Math.sign(dy || 1),
  };
  return { d: `M ${x1} ${y1} Q ${c.x} ${c.y} ${x2} ${y2}`, c, p0, p1 };
}

/** Point on the quadratic curve at t, plus the unit normal (y-down coords). */
function curvePoint(g: EdgeGeom, t: number) {
  const u = 1 - t;
  const x = u * u * g.p0.x + 2 * u * t * g.c.x + t * t * g.p1.x;
  const y = u * u * g.p0.y + 2 * u * t * g.c.y + t * t * g.p1.y;
  // Tangent of a quadratic Bezier.
  const tx = 2 * u * (g.c.x - g.p0.x) + 2 * t * (g.p1.x - g.c.x);
  const ty = 2 * u * (g.c.y - g.p0.y) + 2 * t * (g.p1.y - g.c.y);
  const len = Math.hypot(tx, ty) || 1;
  // Normal pointing "up" in screen space for a left-to-right edge is (ty, -tx).
  return { x, y, nx: ty / len, ny: -tx / len };
}

function Diagram({ diagram, dappAddress }: { diagram: LinkDiagram; dappAddress?: string }) {
  const reduce = useReducedMotion();
  const byId = new Map(diagram.nodes.map((n) => [n.node.id, n]));
  const sublabel = (n: GraphSpecNode) =>
    n.node.id === "dappaddr" && dappAddress ? dappAddress : (n.sublabel ?? "");

  return (
    <figure className="flex flex-col gap-2">
      <figcaption className="text-sm font-medium text-foreground">{diagram.title}</figcaption>
      <svg
        viewBox={diagram.viewBox}
        role="img"
        aria-label={`${diagram.title}: ${diagram.caption}`}
        className="w-full"
      >
        {diagram.edges.map((e, i) => {
          const from = byId.get(e.edge.from);
          const to = byId.get(e.edge.to);
          if (!from || !to) return null;
          const geom = edgeGeom(from, to, e.bend ?? 0);
          const d = geom.d;
          const tone = e.tone ?? "normal";
          const mid = curvePoint(geom, 0.5);
          const labelPos = e.label
            ? e.labelPos
              ? { x: e.labelPos[0], y: e.labelPos[1] }
              : (() => {
                  const p = curvePoint(geom, e.labelT ?? 0.5);
                  const side = e.labelSide ?? (p.ny <= 0 ? 1 : -1);
                  const off = e.labelOffset ?? 13;
                  return { x: p.x + p.nx * side * off, y: p.y + p.ny * side * off };
                })()
            : null;
          return (
            <g key={`${e.edge.from}-${e.edge.to}-${i}`}>
              <motion.path
                d={d}
                fill="none"
                strokeWidth={tone === "blocked" ? 1.6 : 1.4}
                strokeDasharray={tone === "normal" ? undefined : "5 4"}
                className={cn(
                  tone === "blocked"
                    ? "stroke-red-400/70"
                    : tone === "warn"
                      ? "stroke-amber-400/60"
                      : "stroke-muted-foreground/50",
                )}
                initial={reduce ? false : { pathLength: 0, opacity: 0 }}
                whileInView={reduce ? undefined : { pathLength: 1, opacity: 1 }}
                viewport={{ once: true }}
                transition={{ duration: 0.7, delay: 0.15 + i * 0.12, ease: "easeOut" }}
              />
              {e.label && labelPos ? (
                <text
                  x={labelPos.x}
                  y={labelPos.y}
                  textAnchor="middle"
                  className={cn(
                    "edge-label fill-muted-foreground",
                    tone === "blocked" && "fill-red-300/90",
                    tone === "warn" && "fill-amber-200/80",
                  )}
                  fontSize="10"
                  style={{ paintOrder: "stroke", stroke: "var(--card, #0c0c0e)", strokeWidth: 3, strokeLinejoin: "round" }}
                >
                  {e.label}
                </text>
              ) : null}
              {tone === "blocked" ? (
                <motion.g
                  initial={reduce ? false : { opacity: 0, scale: 0.6 }}
                  whileInView={reduce ? undefined : { opacity: 1, scale: 1 }}
                  viewport={{ once: true }}
                  transition={{ delay: 0.5 + i * 0.12 }}
                  transform={`translate(${mid.x}, ${mid.y})`}
                >
                  <circle r="7" className="fill-red-500/20 stroke-red-400/70" strokeWidth="1" />
                  <text textAnchor="middle" dy="3" fontSize="9" className="fill-red-300">
                    ✕
                  </text>
                </motion.g>
              ) : null}
            </g>
          );
        })}
        {diagram.nodes.map((n, i) => (
          <motion.g
            key={n.node.id}
            initial={reduce ? false : { opacity: 0, y: 8 }}
            whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.35, delay: i * 0.08 }}
          >
            <rect
              x={n.x - NODE_W / 2}
              y={n.y - NODE_H / 2}
              width={NODE_W}
              height={NODE_H}
              rx="10"
              className={cn(
                "fill-card stroke-border",
                n.ghost && "fill-muted/40 stroke-border/60 opacity-60",
                n.node.kind === "entity" && "stroke-border-strong",
              )}
              strokeWidth="1"
            />
            <text
              x={n.x}
              y={n.y - (sublabel(n) ? 2 : -2)}
              textAnchor="middle"
              fontSize="11"
              fontWeight="600"
              className={cn("fill-foreground", n.ghost && "fill-muted-foreground")}
            >
              {n.node.label}
            </text>
            {sublabel(n) ? (
              <text
                x={n.x}
                y={n.y + 12}
                textAnchor="middle"
                fontSize="9"
                className={cn("fill-muted-foreground", n.ghost && "fill-muted-foreground/70")}
              >
                {sublabel(n)}
              </text>
            ) : null}
          </motion.g>
        ))}
      </svg>
      <p className="text-xs text-muted-foreground">{diagram.caption}</p>
    </figure>
  );
}

export function ConnectGraph({ view }: { view: ConnectAccountView }) {
  const dappAddress = `${view.account.address.address.slice(0, 6)}…${view.account.address.address.slice(-4)}`;
  return (
    <section id="connect-graph" className="flex scroll-mt-24 flex-col gap-4">
      <h2 className="text-lg font-semibold text-foreground">Before and after</h2>
      <div className="grid gap-6 md:grid-cols-2">
        {DIAGRAMS.map((d) => (
          <Diagram key={d.title} diagram={d} dappAddress={dappAddress} />
        ))}
      </div>
    </section>
  );
}
