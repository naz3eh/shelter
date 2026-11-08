"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/motion/card";
import { StatefulButton } from "@/components/motion/button/stateful";
import { LinkButton } from "@/components/link-button";
import { AnimatedBadge } from "@/components/motion/animated-badge";
import { BandBadge } from "@/components/band-badge";
import { FindingsList, WarningsList } from "@/components/findings";
import { RecoveryCard } from "@/components/recovery";
import { useFlow } from "@/lib/flow/store";
import { SAMPLE_PROFILES } from "@/lib/flow/profiles";
import { shortenAddress } from "@/lib/flow/money";

function ScoreTile({
  label,
  score,
  band,
  linked,
}: {
  label: string;
  score: number;
  band: Parameters<typeof BandBadge>[0]["band"];
  linked: number;
}) {
  return (
    <div className="rounded-xl border border-border bg-card/60 px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="text-4xl font-bold tabular-nums">{score}</span>
        <span className="text-sm text-muted-foreground">/ 100</span>
        <BandBadge band={band} />
      </div>
      <div className="mt-1 text-xs text-muted-foreground">
        {linked} linked address{linked === 1 ? "" : "es"}
      </div>
    </div>
  );
}

export default function RescanPage() {
  const router = useRouter();
  const { state, computeRescan, resetFlow } = useFlow();
  const { scan, planApproval, moveSim, burnerSim, burnerApproval, rescan } = state;

  const ready =
    scan.status === "done" &&
    !!planApproval &&
    moveSim?.status === "done" &&
    (moveSim.outcome === "completed" || moveSim.outcome === "partial");

  useEffect(() => {
    if (ready && rescan.status === "idle") void computeRescan();
    // Recompute when the burner leg finishes after the move.
    if (ready && rescan.status === "done" && burnerSim?.status === "done" && !rescan.burnerIncluded) {
      void computeRescan();
    }
  }, [ready, rescan.status, rescan.burnerIncluded, burnerSim?.status, computeRescan]);

  const before = scan.report;
  const after = rescan.afterReport;

  const delta = useMemo(() => {
    if (!before || !after) return null;
    return {
      score: after.score - before.score,
      linked: after.linkedAddressCount - before.linkedAddressCount,
      findings: after.findings.length - before.findings.length,
    };
  }, [before, after]);

  if (!ready) {
    return (
      <RecoveryCard title="Nothing to re-scan yet" backHref="/" backLabel="Back to setup">
        The before/after comparison needs a completed scan plus a finished
        (or partially finished) simulated move. Walk the flow first — the old
        wallets' public history is never erased by the demo.
      </RecoveryCard>
    );
  }

  const profileName = state.profileId
    ? SAMPLE_PROFILES[state.profileId].title
    : "sample";

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Before / after re-scan</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            The <strong className="text-foreground">before</strong> report is the
            original scan of {profileName}. The{" "}
            <strong className="text-foreground">after</strong> report is computed
            by the same core engine over a separate, explicitly fictional
            post-move fixture generated inside this app — old wallets keep their
            public history; new destination addresses appear as fresh wallets.
            Neither side is a live chain scan, and the numbers do not prove
            unlinkability.
          </p>
        </div>
        <StatefulButton
          variant="outline"
          size="sm"
          onClick={() => {
            resetFlow();
            router.push("/");
          }}
        >
          Restart demo
        </StatefulButton>
      </div>

      {rescan.status === "running" || rescan.status === "idle" ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground" role="status">
            Computing the after-scan with the real engine over the generated
            fictional fixture…
          </CardContent>
        </Card>
      ) : null}

      {rescan.status === "error" ? (
        <Card className="border-red-500/40">
          <CardContent className="py-6">
            <p role="alert" className="text-sm text-red-400">
              After-scan failed: {rescan.error ?? "unknown error"}
            </p>
            <StatefulButton size="sm" className="mt-3" onClick={() => void computeRescan()}>
              Retry re-scan
            </StatefulButton>
          </CardContent>
        </Card>
      ) : null}

      {rescan.status === "done" && before && after && delta ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <ScoreTile
              label={`Before — ${profileName} (original history)`}
              score={before.score}
              band={before.band}
              linked={before.linkedAddressCount}
            />
            <ScoreTile
              label="After — new destination wallets (fictional post-move fixture)"
              score={after.score}
              band={after.band}
              linked={after.linkedAddressCount}
            />
          </div>

          <Card>
            <CardContent className="flex flex-wrap gap-x-8 gap-y-1 py-3 text-sm">
              <span>
                Score delta:{" "}
                <strong className={delta.score <= 0 ? "text-emerald-400" : "text-amber-400"}>
                  {delta.score > 0 ? "+" : ""}
                  {delta.score}
                </strong>
              </span>
              <span>
                Linked addresses: {before.linkedAddressCount} → {after.linkedAddressCount}{" "}
                ({delta.linked > 0 ? "+" : ""}
                {delta.linked})
              </span>
              <span>
                Findings: {before.findings.length} → {after.findings.length}
              </span>
              <span className="text-xs text-muted-foreground">
                {rescan.fundedChunks}/{rescan.totalChunks} simulated chunks funded
                {rescan.burnerIncluded ? " · burner included" : ""}
              </span>
            </CardContent>
          </Card>

          {rescan.notes.length ? (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm">
              <p className="font-medium text-amber-300">Dataset limits</p>
              <ul className="mt-1 list-disc pl-5 text-foreground/90">
                {rescan.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle as="h2">After-scan findings</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <FindingsList findings={after.findings} />
                <WarningsList warnings={after.warnings} />
                {after.wallets.length ? (
                  <ul className="text-xs text-muted-foreground">
                    {after.wallets.map((w) => (
                      <li key={w.wallet.address} className="font-mono">
                        {shortenAddress(w.wallet.address, 6)} — {w.wallet.chain}
                        {w.wallet.label ? ` (${w.wallet.label})` : ""} · score{" "}
                        {w.score} · {w.band}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle as="h2">What changed</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-2 text-sm text-muted-foreground">
                <p>
                  The after fixture contains the funded withdrawal destinations
                  as new wallets plus, when included, the used burner with its
                  recorded nonce/public-key exposure. The original wallets and
                  their history are unchanged — scanning them again reproduces
                  the before report.
                </p>
                <p>
                  A lower after-score on this fictional dataset reflects fewer
                  detectable links <em>in the generated data</em> — it is not a
                  proof that real funds would be unlinkable, and timing
                  correlation plus trusted operators remain.
                </p>
                <div className="flex flex-wrap gap-2 pt-2">
                  <ExportRescanButton />
                  <LinkButton href="/" variant="outline" size="sm">
                    Restart with another sample
                  </LinkButton>
                </div>
              </CardContent>
            </Card>
          </div>
        </>
      ) : null}
    </div>
  );
}

function ExportRescanButton() {
  const { state } = useFlow();
  const download = () => {
    const payload = {
      provenance:
        "Fictional before/after fixture comparison generated by Shelter's sample flow — not live chain data. No secrets included.",
      exportedAt: new Date().toISOString(),
      before: state.scan.report,
      after: state.rescan.afterReport,
      notes: state.rescan.notes,
      fundedChunks: state.rescan.fundedChunks,
      totalChunks: state.rescan.totalChunks,
      burnerIncluded: state.rescan.burnerIncluded,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `shelter-rescan-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };
  return (
    <StatefulButton variant="outline" size="sm" onClick={download}>
      Export comparison JSON
    </StatefulButton>
  );
}
