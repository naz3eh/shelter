"use client";

import { useRouter } from "next/navigation";
import { useMemo } from "react";
import type { ExposureReport, ScanReport } from "@shelter/core";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/motion/card";
import { StatefulButton } from "@/components/motion/button/stateful";
import { LinkButton } from "@/components/link-button";
import { AnimatedBadge } from "@/components/motion/animated-badge";
import { BandBadge } from "@/components/band-badge";
import { FindingsList, WarningsList } from "@/components/findings";
import { LinkGraphView } from "@/components/link-graph";
import { ExplainCard } from "@/components/explain-card";
import { RecoveryCard } from "@/components/recovery";
import { useFlow } from "@/lib/flow/store";
import { SAMPLE_PROFILES } from "@/lib/flow/profiles";
import {
  identityFloorApplied,
  formatDateTime,
} from "@/lib/format";
import { shortenAddress } from "@/lib/flow/money";

function WalletScoreCard({ wallet }: { wallet: ExposureReport }) {
  const w = wallet.wallet;
  const label = w.label;
  return (
    <div className="rounded-xl border border-border bg-card/60 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm">{shortenAddress(w.address, 6)}</span>
        <AnimatedBadge size="sm" status="neutral">
          {w.chain}
        </AnimatedBadge>
        {label ? (
          <AnimatedBadge size="sm" status="info">
            {label}
          </AnimatedBadge>
        ) : null}
        <span className="ml-auto flex items-center gap-2">
          <span className="text-lg font-semibold tabular-nums">
            {wallet.score}
          </span>
          <BandBadge band={wallet.band} />
        </span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {wallet.findings.length} finding(s) · {wallet.warnings.length} warning(s)
        {wallet.findings.some((f) => f.detail.startsWith("inherited:"))
          ? " · includes inherited identity findings"
          : ""}
      </p>
    </div>
  );
}

function ReportBody({ report, profileName }: { report: ScanReport; profileName?: string }) {
  const walletLabel = useMemo(() => {
    const m = new Map<string, string>();
    for (const w of report.wallets) {
      if (w.wallet.label) m.set(w.wallet.address.toLowerCase(), w.wallet.label);
    }
    return (addr: string) => m.get(addr.toLowerCase());
  }, [report]);

  return (
    <div className="flex flex-col gap-6">
      {/* Headline */}
      <Card>
        <CardContent className="flex flex-col gap-4 pt-2 sm:flex-row sm:items-center">
          <div>
            <div className="text-xs uppercase tracking-wide text-muted-foreground">
              Exposure score{profileName ? ` — ${profileName}` : ""}
            </div>
            <div className="mt-1 flex items-baseline gap-3">
              <span className="text-5xl font-bold tabular-nums">
                {report.score}
              </span>
              <span className="text-lg text-muted-foreground">/ 100</span>
              <BandBadge band={report.band} className="self-center" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-sm sm:ml-auto">
            <div>
              <div className="text-xs text-muted-foreground">Linked addresses</div>
              <div className="text-lg font-semibold tabular-nums">
                {report.linkedAddressCount}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Wallets scanned</div>
              <div className="text-lg font-semibold tabular-nums">
                {report.wallets.length}
              </div>
            </div>
            <div className="col-span-2 text-xs text-muted-foreground">
              Score counts each check once across the whole set; per-wallet
              scores below are secondary detail.
              {identityFloorApplied(report)
                ? " The identity floor (50) applies because an exchange link or public name was found."
                : ""}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Per-wallet scores */}
      <section aria-labelledby="wallets">
        <h2 id="wallets" className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Wallets
        </h2>
        <div className="grid gap-2 sm:grid-cols-2">
          {report.wallets.map((w) => (
            <WalletScoreCard key={w.wallet.address} wallet={w} />
          ))}
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="flex flex-col gap-6">
          <section aria-labelledby="findings">
            <h2 id="findings" className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Findings A–I
            </h2>
            <FindingsList findings={report.findings} walletLabel={walletLabel} />
          </section>
          <WarningsList warnings={report.warnings} />
        </div>
        <div className="flex flex-col gap-6">
          <section aria-labelledby="graph">
            <h2 id="graph" className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Link graph
            </h2>
            <LinkGraphView graph={report.graph} />
          </section>
          <ExplainCard report={report} />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <LinkButton href="/plan">Review remediation plan</LinkButton>
        <ExportButton report={report} />
      </div>
    </div>
  );
}

function ExportButton({ report }: { report: ScanReport }) {
  const download = () => {
    const payload = {
      provenance:
        "Fictional recorded fixture data generated by Shelter's bundled sample wallets — not a live chain scan. No secrets included.",
      exportedAt: new Date().toISOString(),
      report,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `shelter-scan-report-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Defer revocation — revoking synchronously can race the download start
    // on slower clients.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };
  return (
    <StatefulButton variant="outline" onClick={download}>
      Download JSON report
    </StatefulButton>
  );
}

export default function ScanPage() {
  const { state, retryScan } = useFlow();
  const router = useRouter();
  const { scan } = state;

  if (scan.status === "idle" && !scan.profileId) {
    return (
      <RecoveryCard title="No scan in progress">
        Pick a fictional sample on the setup page first — the scan computes
        its report in this browser from bundled fixture data.
      </RecoveryCard>
    );
  }

  if (scan.status === "loading") {
    return (
      <div className="flex flex-col items-center gap-3 py-24" role="status">
        <StatefulButton state="loading" loadingText="Scanning recorded history…" disabled>
          Scanning
        </StatefulButton>
        <p className="text-sm text-muted-foreground">
          Running the real exposure engine over the fixture — no network calls.
        </p>
      </div>
    );
  }

  if (scan.status === "error") {
    return (
      <RecoveryCard title="Scan failed">
        <p role="alert" className="text-red-400">
          {scan.error ?? "Unknown error"}
        </p>
        <p className="mt-2">
          A failed scan is not a clean result — retry, or pick a different
          sample.
        </p>
        <div className="mt-3 flex gap-2">
          <StatefulButton size="sm" onClick={retryScan}>
            Retry scan
          </StatefulButton>
          <StatefulButton size="sm" variant="outline" onClick={() => router.push("/")}>
            Back to setup
          </StatefulButton>
        </div>
      </RecoveryCard>
    );
  }

  if (scan.status !== "done" || !scan.report) {
    return (
      <RecoveryCard title="Scan incomplete">
        The scan did not produce a report. Start again from setup.
      </RecoveryCard>
    );
  }

  const profileName = scan.profileId
    ? SAMPLE_PROFILES[scan.profileId].title
    : undefined;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          Scan report{profileName ? ` — ${profileName}` : ""}
        </h1>
        <p className="text-xs text-muted-foreground">
          Scanned {formatDateTime(scan.scannedAt)} · fictional recorded
          history, computed on-device
        </p>
      </div>
      <ReportBody report={scan.report} profileName={profileName} />
    </div>
  );
}
