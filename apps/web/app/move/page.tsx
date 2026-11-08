"use client";

import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/motion/card";
import { StatefulButton } from "@/components/motion/button/stateful";
import { LinkButton } from "@/components/link-button";
import { AnimatedBadge } from "@/components/motion/animated-badge";
import { StepTracker } from "@/components/step-tracker";
import { RecoveryCard } from "@/components/recovery";
import { useFlow } from "@/lib/flow/store";
import type { MoveScenario, DemoPace } from "@/lib/flow/types";
import { shortenAddress } from "@/lib/flow/money";

const SCENARIOS: { id: MoveScenario; label: string; hint: string }[] = [
  {
    id: "happy",
    label: "Happy path",
    hint: "Every deposit settles; both USDC and ETH withdrawals complete.",
  },
  {
    id: "partial-funding",
    label: "Partial funding",
    hint: "One leg fails — completed steps stay done, failed legs can retry.",
  },
  {
    id: "deposit-refund",
    label: "Deposit refund",
    hint: "A deposit is returned to the old wallet instead of settling.",
  },
];

export default function MovePage() {
  const router = useRouter();
  const {
    state,
    setMoveSettings,
    startMove,
    cancelMove,
    retryMove,
    restartMove,
  } = useFlow();
  const { planApproval, moveSettings, moveSim } = state;

  if (!planApproval) {
    return (
      <RecoveryCard title="No approved plan">
        The move tracker only runs an approved simulation. Review and approve a
        plan first — nothing here can move real funds.
      </RecoveryCard>
    );
  }

  const plan = planApproval.plan;
  const sim = moveSim;
  const running = sim?.status === "running";
  const done = sim?.outcome === "completed" || sim?.outcome === "partial";

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Simulated private move
        </h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          This tracker replays a <strong className="text-foreground">simulation</strong>{" "}
          of the approved plan (hash <span className="font-mono">{plan.hash}</span>):
          deposit preview → confidential-balance settlement → delay → separate
          USDC and ETH withdrawals to fresh destinations. <strong>No funds
          move</strong>, no transaction is signed and no explorer link is
          shown — steps are labeled simulated throughout. Demo timing is
          shortened on purpose; short delays are linkable in real use.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle as="h2">Progress</CardTitle>
              {sim ? (
                <AnimatedBadge
                  size="sm"
                  status={
                    sim.status === "running"
                      ? "info"
                      : done
                        ? "success"
                        : sim.status === "failed" || sim.status === "cancelled"
                          ? "warning"
                          : "neutral"
                  }
                >
                  {sim.outcome === "partial"
                    ? "partial — retry available"
                    : sim.status}
                </AnimatedBadge>
              ) : null}
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {!sim ? (
              <p className="text-sm text-muted-foreground">
                The simulation has not started. Pick a scenario and pace below,
                then start — it will run the approved plan{" "}
                ({plan.chunks.length} chunk(s), {plan.totals.usdc} USDC +{" "}
                {plan.totals.eth} ETH) through deposit, settlement, delay and
                withdrawals.
              </p>
            ) : (
              <>
                <StepTracker steps={sim.steps} live={running} />
                {sim.message ? (
                  <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm">
                    {sim.message}
                  </p>
                ) : null}
                {sim.events.length ? (
                  <details className="text-xs text-muted-foreground">
                    <summary className="cursor-pointer">Simulation log</summary>
                    <ul className="mt-1 flex flex-col gap-0.5 font-mono">
                      {sim.events.map((e, i) => (
                        <li key={i}>
                          {new Date(e.at).toLocaleTimeString()} — {e.text}
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </>
            )}
          </CardContent>
        </Card>

        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle as="h2">Scenario &amp; pace</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <fieldset className="flex flex-col gap-2">
                <legend className="text-xs font-medium text-muted-foreground">
                  Deterministic test scenario
                </legend>
                {SCENARIOS.map((s) => (
                  <label
                    key={s.id}
                    className="flex cursor-pointer items-start gap-2 rounded-lg border border-border px-3 py-2 text-sm has-checked:border-primary/60 has-checked:bg-muted/40"
                  >
                    <input
                      type="radio"
                      name="move-scenario"
                      className="mt-1"
                      checked={moveSettings.scenario === s.id}
                      disabled={running}
                      onChange={() =>
                        setMoveSettings({ ...moveSettings, scenario: s.id })
                      }
                    />
                    <span>
                      <span className="font-medium">{s.label}</span>
                      <span className="block text-xs text-muted-foreground">
                        {s.hint}
                      </span>
                    </span>
                  </label>
                ))}
              </fieldset>
              <fieldset className="flex flex-col gap-2">
                <legend className="text-xs font-medium text-muted-foreground">
                  Demo pace
                </legend>
                {(
                  [
                    ["relaxed", "Relaxed (~seconds per step)"],
                    ["brisk", "Brisk (near-instant)"],
                  ] as [DemoPace, string][]
                ).map(([id, label]) => (
                  <label
                    key={id}
                    className="flex cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm has-checked:border-primary/60 has-checked:bg-muted/40"
                  >
                    <input
                      type="radio"
                      name="move-pace"
                      checked={moveSettings.pace === id}
                      disabled={running}
                      onChange={() =>
                        setMoveSettings({ ...moveSettings, pace: id })
                      }
                    />
                    {label}
                  </label>
                ))}
              </fieldset>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle as="h2">Controls</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              {!sim || sim.status === "cancelled" || sim.status === "failed" ? (
                <StatefulButton onClick={startMove}>
                  {sim ? "Restart simulation" : "Start simulation"}
                </StatefulButton>
              ) : null}
              {running ? (
                <StatefulButton variant="outline" onClick={cancelMove}>
                  Cancel simulation
                </StatefulButton>
              ) : null}
              {sim && (sim.status === "failed" || sim.outcome === "partial") ? (
                <StatefulButton variant="outline" onClick={retryMove}>
                  Retry / reconcile
                </StatefulButton>
              ) : null}
              {sim && (done || sim.status === "cancelled") ? (
                <StatefulButton variant="outline" onClick={restartMove}>
                  Restart from beginning
                </StatefulButton>
              ) : null}
              {done ? (
                <LinkButton href="/burner" className="w-full">
                  Continue to burner →
                </LinkButton>
              ) : null}
              <p className="text-[11px] text-muted-foreground">
                Retry resumes the same run — it never duplicates a simulated
                step. Cancel stops future timers; already-simulated steps stay
                recorded as such.
              </p>
            </CardContent>
          </Card>

          {sim?.chunks?.length ? (
            <Card>
              <CardHeader>
                <CardTitle as="h2">Chunks</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="flex flex-col gap-1.5 text-xs">
                  {sim.chunks.map((c) => (
                    <li
                      key={c.index}
                      className="flex items-center justify-between rounded border border-border px-2 py-1 font-mono"
                    >
                      <span>
                        #{c.index + 1} {c.usdc} USDC + {c.eth} ETH
                      </span>
                      <span className="text-muted-foreground">
                        {c.usdcWithdrawn ? "USDC ✓" : "USDC —"} ·{" "}
                        {c.ethWithdrawn ? "ETH ✓" : "ETH —"}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-[11px] text-muted-foreground">
                  Destinations are fictional demo addresses:{" "}
                  {sim.chunks
                    .slice(0, 2)
                    .map((c) => shortenAddress(c.destination, 5))
                    .join(", ")}
                  {sim.chunks.length > 2 ? "…" : ""}
                </p>
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}
