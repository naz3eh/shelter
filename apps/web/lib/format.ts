import type { ExposureBand, ExposureFinding, ScanReport } from "@shelter/core";
import { CHECKS } from "@shelter/core";

export const BAND_META: Record<
  ExposureBand,
  { label: string; className: string; dot: string }
> = {
  clean: {
    label: "clean",
    className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-400",
    dot: "bg-emerald-400",
  },
  linkable: {
    label: "linkable",
    className: "border-amber-500/40 bg-amber-500/10 text-amber-400",
    dot: "bg-amber-400",
  },
  identifiable: {
    label: "identifiable",
    className: "border-orange-500/40 bg-orange-500/10 text-orange-400",
    dot: "bg-orange-400",
  },
  doxxed: {
    label: "doxxed",
    className: "border-red-500/40 bg-red-500/10 text-red-400",
    dot: "bg-red-400",
  },
};

export function isInheritedFinding(f: ExposureFinding): boolean {
  return f.detail.startsWith("inherited:");
}

/**
 * The set score counts each check once (max points across the set). Used for
 * the identity-floor explanation only — never summed into a display score.
 */
export function dedupedCheckPoints(findings: ExposureFinding[]): number {
  const byCheck = new Map<string, number>();
  for (const f of findings) {
    byCheck.set(f.check, Math.max(byCheck.get(f.check) ?? 0, f.points));
  }
  return [...byCheck.values()].reduce((s, p) => s + p, 0);
}

/** True when firing A or B floored the set score at 50. */
export function identityFloorApplied(report: ScanReport): boolean {
  const hasIdentity = report.findings.some(
    (f) => f.check === "A" || f.check === "B",
  );
  return hasIdentity && dedupedCheckPoints(report.findings) < 50;
}

export function checkLabel(check: string): string {
  return CHECKS[check as keyof typeof CHECKS]?.name ?? check;
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}
