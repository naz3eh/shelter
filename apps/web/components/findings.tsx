"use client";

import type { ExposureFinding, ScanWarning } from "@shelter/core";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/motion/card";
import { AnimatedBadge } from "@/components/motion/animated-badge";
import { checkLabel, isInheritedFinding } from "@/lib/format";
import { shortenAddress } from "@/lib/flow/money";
import { cn } from "@/lib/utils";

function EvidenceBits({ finding }: { finding: ExposureFinding }) {
  const ev = finding.evidence;
  const bits: string[] = [];
  if (ev.label) bits.push(`label: ${ev.label}`);
  if (ev.name) bits.push(`name: ${ev.name}`);
  if (ev.addresses?.length)
    bits.push(`addresses: ${ev.addresses.map((a) => shortenAddress(a)).join(", ")}`);
  if (ev.txHashes?.length)
    bits.push(`${ev.txHashes.length} tx hash(es) recorded`);
  if (!bits.length) return null;
  return (
    <p className="mt-1 text-xs text-muted-foreground">{bits.join(" · ")}</p>
  );
}

/**
 * Findings A–I with points, confidence and evidence. Inherited A/B findings
 * (propagated across linked wallets by the engine) are marked explicitly.
 */
export function FindingsList({
  findings,
  walletLabel,
}: {
  findings: ExposureFinding[];
  /** Maps a lowercased address to a display label (e.g. "main"). */
  walletLabel?: (address: string) => string | undefined;
}) {
  if (findings.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No exposure findings in this dataset — that means no detected evidence
        here, not a guarantee of privacy.
      </p>
    );
  }
  const sorted = [...findings].sort(
    (a, b) => a.check.localeCompare(b.check) || a.wallet.localeCompare(b.wallet),
  );
  return (
    <ul className="flex flex-col gap-2">
      {sorted.map((f, i) => {
        const inherited = isInheritedFinding(f);
        const label = walletLabel?.(f.wallet.toLowerCase());
        return (
          <li
            key={`${f.check}-${f.wallet}-${i}`}
            className={cn(
              "rounded-lg border border-border bg-card/60 px-3 py-2",
              inherited && "border-dashed",
            )}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-border bg-muted text-xs font-semibold">
                {f.check}
              </span>
              <span className="text-sm font-medium">{checkLabel(f.check)}</span>
              <AnimatedBadge size="sm" status="neutral">
                {f.points} pts
              </AnimatedBadge>
              <span className="text-xs text-muted-foreground">
                {f.weight} × {f.confidence}
              </span>
              {inherited ? (
                <AnimatedBadge size="sm" status="info">
                  inherited identity
                </AnimatedBadge>
              ) : null}
              <span className="ml-auto font-mono text-xs text-muted-foreground">
                {label ? `${label} · ` : ""}
                {shortenAddress(f.wallet, 5)}
              </span>
            </div>
            <p className="mt-1.5 text-sm text-foreground/90">{f.detail}</p>
            <EvidenceBits finding={f} />
          </li>
        );
      })}
    </ul>
  );
}

/** Zero-point warnings (poisoning, sanctions) — visually separate from scoring. */
export function WarningsList({ warnings }: { warnings: ScanWarning[] }) {
  if (warnings.length === 0) return null;
  return (
    <Card size="compact" className="border-amber-500/30">
      <CardHeader>
        <CardTitle as="h3">Warnings — 0 points</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {warnings.map((w, i) => (
          <div
            key={`${w.kind}-${w.wallet}-${i}`}
            className="rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2"
          >
            <div className="flex flex-wrap items-center gap-2">
              <AnimatedBadge size="sm" status="warning">
                {w.kind === "address-poisoning"
                  ? "address poisoning"
                  : "sanctioned counterparty"}
              </AnimatedBadge>
              <span className="font-mono text-xs text-muted-foreground">
                {shortenAddress(w.wallet, 5)}
              </span>
            </div>
            <p className="mt-1 text-sm text-foreground/90">{w.detail}</p>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
