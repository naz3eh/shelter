"use client";

import { useState, type ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";
import { Check, Copy, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";

export function truncMid(a: string) {
  return a.startsWith("0x") && a.length > 14 ? `${a.slice(0, 6)}...${a.slice(-4)}` : a;
}

export function CopyBtn({ value, className }: { value: string; className?: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      type="button"
      aria-label={`Copy ${value}`}
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard?.writeText(value);
        setOk(true);
        setTimeout(() => setOk(false), 1200);
      }}
      className={cn("inline-grid size-5 shrink-0 place-items-center rounded text-faint transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", className)}
    >
      {ok ? <Check className="size-3 text-shelter" /> : <Copy className="size-3" />}
    </button>
  );
}

export function Addr({ value, copy = true, className }: { value: string; copy?: boolean; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-0.5 whitespace-nowrap rounded-md border bg-surface-2/60 py-px pl-1.5 pr-0.5 align-middle font-mono text-[0.8em] text-foreground", !copy && "pr-1.5", className)} title={value}>
      {truncMid(value)}
      {copy && <CopyBtn value={value} />}
    </span>
  );
}

export function TxChip({ hash, href }: { hash: string; href?: string }) {
  return (
    <span className="inline-flex items-center gap-0.5 whitespace-nowrap rounded-md border bg-surface-2/60 py-px pl-1.5 pr-0.5 align-middle font-mono text-[11px] text-muted-foreground">
      {truncMid(hash)}
      {href ? (
        <a href={href} target="_blank" rel="noreferrer" aria-label="View on Basescan" className="inline-grid size-5 place-items-center rounded text-faint hover:bg-accent hover:text-foreground">
          <ExternalLink className="size-3" />
        </a>
      ) : null}
      <CopyBtn value={hash} />
    </span>
  );
}

type Tone = "neutral" | "ok" | "danger" | "warn";
const tones: Record<Tone, string> = {
  neutral: "border-border bg-surface-2 text-muted-foreground",
  ok: "border-shelter/25 bg-shelter/10 text-shelter",
  danger: "border-destructive/30 bg-destructive/10 text-destructive",
  warn: "border-warn/30 bg-warn/10 text-warn",
};
export function Pill({ tone = "neutral", children, className, dot }: { tone?: Tone; children: ReactNode; className?: string; dot?: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium", tones[tone], className)}>
      {dot && <span className="size-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

export function Btn({ variant = "secondary", className, ...p }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger" }) {
  const v = {
    primary: "bg-primary text-primary-foreground hover:bg-primary/90 shadow-[0_0_0_1px_oklch(1_0_0/10%),0_8px_24px_-8px_oklch(1_0_0/25%)]",
    secondary: "border bg-surface-2 text-foreground hover:bg-accent",
    ghost: "text-muted-foreground hover:bg-accent hover:text-foreground",
    danger: "border border-destructive/30 bg-destructive/10 text-destructive hover:bg-destructive/15",
  }[variant];
  return <button type="button" {...p} className={cn("inline-flex h-9 items-center justify-center gap-2 rounded-lg px-3.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50", v, className)} />;
}

export function Reveal({ children, className, delay = 0 }: { children: ReactNode; className?: string; delay?: number }) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      className={className}
      initial={reduce ? false : { opacity: 0, y: 12 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-60px" }}
      transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1], delay }}
    >
      {children}
    </motion.div>
  );
}

export function SectionTitle({ icon, title, sub, right }: { icon?: ReactNode; title: string; sub?: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-5">
      <div className="flex flex-wrap items-center gap-2.5">
        {icon && <span className="text-muted-foreground [&_svg]:size-4">{icon}</span>}
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        {right}
      </div>
      {sub && <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted-foreground">{sub}</p>}
    </div>
  );
}
