"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/motion/card";
import { StatefulButton } from "@/components/motion/button/stateful";
import { LinkButton } from "@/components/link-button";
import { AnimatedBadge } from "@/components/motion/animated-badge";
import { StepTracker } from "@/components/step-tracker";
import { RecoveryCard } from "@/components/recovery";
import { useFlow } from "@/lib/flow/store";
import type { BurnerScenario, DemoPace } from "@/lib/flow/types";
import { isValidEvmAddress, shortenAddress } from "@/lib/flow/money";
import { decimalToBase, USDC_DECIMALS } from "@/lib/flow/money";

const SCENARIOS: { id: BurnerScenario; label: string; hint: string }[] = [
  { id: "happy", label: "Happy path", hint: "Funded, pays once, retires cleanly." },
  { id: "insufficient-gas", label: "Insufficient gas", hint: "Funding lands short of gas; payment cannot run." },
  { id: "funding-failed", label: "Funding failed", hint: "The private funding leg fails; the burner stays empty." },
  { id: "payment-failed", label: "Payment failed", hint: "The single payment reverts; funds remain for review." },
];

export default function BurnerPage() {
  const router = useRouter();
  const {
    state,
    ensureBurnerDraft,
    setBurnerDraft,
    approveBurner,
    setBurnerSettings,
    startBurner,
    cancelBurner,
    retryBurner,
    restartBurner,
  } = useFlow();
  const { planApproval, moveSim, burnerDraft, burnerApproval, burnerSettings, burnerSim } = state;
  const [errors, setErrors] = useState<string[]>([]);
  const [approving, setApproving] = useState(false);

  useEffect(() => {
    if (moveSim?.outcome === "completed" || moveSim?.outcome === "partial") {
      void ensureBurnerDraft();
    }
  }, [moveSim?.outcome, ensureBurnerDraft]);

  const localErrors = useMemo(() => {
    if (!burnerDraft) return [] as string[];
    const out: string[] = [];
    if (burnerDraft.recipient.trim() && !isValidEvmAddress(burnerDraft.recipient)) {
      out.push("Recipient must be a 0x-prefixed 40-hex address.");
    }
    const amt = decimalToBase(burnerDraft.amountUsdc, USDC_DECIMALS);
    if (!burnerDraft.amountUsdc.trim() || amt === null || amt <= 0n) {
      out.push("Payment must be a positive USDC amount.");
    }
    return out;
  }, [burnerDraft]);

  if (!planApproval) {
    return (
      <RecoveryCard title="No approved plan" backHref="/plan" backLabel="Back to plan">
        The burner draws its simulated funding from an approved private-move
        plan. Approve a plan first.
      </RecoveryCard>
    );
  }
  if (!moveSim || (moveSim.outcome !== "completed" && moveSim.outcome !== "partial")) {
    return (
      <RecoveryCard title="No completed move" backHref="/move" backLabel="Back to move tracker">
        The burner is funded from a completed (or partially completed)
        simulated move. Finish the move simulation first.
      </RecoveryCard>
    );
  }
  if (!burnerDraft) {
    return (
      <div className="py-16 text-center text-sm text-muted-foreground" role="status">
        Preparing burner draft…
      </div>
    );
  }

  const sim = burnerSim;
  const running = sim?.status === "running";
  const used = sim?.status === "done";
  const failed = sim?.status === "failed" || sim?.status === "cancelled";

  const approve = async () => {
    setApproving(true);
    setErrors([]);
    const r = await approveBurner();
    setApproving(false);
    if (!r.ok) setErrors(r.errors ?? ["Approval failed."]);
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Simulated one-time burner</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          A fictional fresh address performs <strong>one</strong> simulated USDC
          payment, then retires. <strong>No real keys exist</strong> for this
          address — it is demo metadata, not a derived or recoverable account.
          After its single action it is non-reusable; a second business action
          is blocked by the state model. Any leftover dust stays visible and
          is labeled uneconomical — sweeping it is separate housekeeping, not
          the business action.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle as="h2">Burner plan</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 sm:col-span-2">
                <div className="text-xs text-muted-foreground">Fictional burner address</div>
                <div className="font-mono text-sm">{shortenAddress(burnerApproval?.plan.burnerAddress ?? "0x…", 10)}</div>
                <div className="text-[11px] text-muted-foreground">
                  Generated demo metadata — no private key, seed or vault entry exists.
                </div>
              </div>
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                Payment recipient (0x)
                <input
                  className="h-10 rounded-lg border border-border bg-card px-3 font-mono text-sm"
                  value={burnerDraft.recipient}
                  disabled={!!burnerApproval || running}
                  onChange={(e) => setBurnerDraft({ ...burnerDraft, recipient: e.target.value })}
                  aria-label="Payment recipient"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                One-time USDC payment
                <input
                  className="h-10 rounded-lg border border-border bg-card px-3 text-sm tabular-nums"
                  inputMode="decimal"
                  value={burnerDraft.amountUsdc}
                  disabled={!!burnerApproval || running}
                  onChange={(e) => setBurnerDraft({ ...burnerDraft, amountUsdc: e.target.value })}
                  aria-label="Payment amount USDC"
                />
              </label>
              {burnerApproval ? (
                <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm sm:col-span-2">
                  <AnimatedBadge size="sm" status="success">simulation approved</AnimatedBadge>
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    Funding {burnerApproval.plan.fundingUsdc} USDC +{" "}
                    {burnerApproval.plan.fundingEth} ETH (private path), payment{" "}
                    {burnerApproval.plan.payment.amountUsdc} USDC →{" "}
                    {shortenAddress(burnerApproval.plan.payment.recipient, 8)},
                    gas needed {burnerApproval.plan.requiredGasEth} ETH.
                    Editing the draft revokes this approval.
                  </p>
                </div>
              ) : null}
              {localErrors.length || errors.length ? (
                <div role="alert" className="text-xs text-red-400 sm:col-span-2">
                  {[...localErrors, ...errors].map((e) => (
                    <p key={e}>{e}</p>
                  ))}
                </div>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle as="h2">Lifecycle</CardTitle>
                {sim ? (
                  <AnimatedBadge
                    size="sm"
                    status={
                      used ? "success" : running ? "info" : failed ? "warning" : "neutral"
                    }
                  >
                    {sim.status}
                  </AnimatedBadge>
                ) : null}
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {!sim ? (
                <p className="text-sm text-muted-foreground">
                  Approve the simulation, pick a scenario, then run the lifecycle:
                  created → funded → used → retired. All steps are simulated.
                </p>
              ) : (
                <>
                  <StepTracker steps={sim.steps} live={running} />
                  {sim.dustEth != null ? (
                    <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs">
                      Leftover dust: {sim.dustEth} ETH remains on the retired
                      burner — uneconomical to sweep; left visible rather than
                      disguised as part of the action.
                    </p>
                  ) : null}
                  {sim.message ? (
                    <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm">
                      {sim.message}
                    </p>
                  ) : null}
                </>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle as="h2">Scenario &amp; controls</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <fieldset className="flex flex-col gap-2">
                <legend className="text-xs font-medium text-muted-foreground">
                  Deterministic scenario
                </legend>
                {SCENARIOS.map((s) => (
                  <label
                    key={s.id}
                    className="flex cursor-pointer items-start gap-2 rounded-lg border border-border px-3 py-2 text-sm has-checked:border-primary/60 has-checked:bg-muted/40"
                  >
                    <input
                      type="radio"
                      name="burner-scenario"
                      className="mt-1"
                      checked={burnerSettings.scenario === s.id}
                      disabled={running || used}
                      onChange={() =>
                        setBurnerSettings({ ...burnerSettings, scenario: s.id })
                      }
                    />
                    <span>
                      <span className="font-medium">{s.label}</span>
                      <span className="block text-xs text-muted-foreground">{s.hint}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                <input
                  type="checkbox"
                  checked={burnerSettings.pace === "brisk"}
                  disabled={running || used}
                  onChange={(e) =>
                    setBurnerSettings({
                      ...burnerSettings,
                      pace: e.target.checked ? "brisk" : "relaxed",
                    })
                  }
                />
                Brisk pace (near-instant steps)
              </label>

              {!burnerApproval ? (
                <StatefulButton
                  disabled={localErrors.length > 0 || approving}
                  state={approving ? "loading" : "idle"}
                  loadingText="Approving…"
                  onClick={() => void approve()}
                >
                  Approve simulation
                </StatefulButton>
              ) : null}
              {burnerApproval && !sim ? (
                <StatefulButton onClick={startBurner}>Start burner lifecycle</StatefulButton>
              ) : null}
              {running ? (
                <StatefulButton variant="outline" onClick={cancelBurner}>
                  Cancel
                </StatefulButton>
              ) : null}
              {failed ? (
                <StatefulButton variant="outline" onClick={retryBurner}>
                  Retry
                </StatefulButton>
              ) : null}
              {sim && !running ? (
                <StatefulButton variant="outline" onClick={restartBurner}>
                  Restart lifecycle
                </StatefulButton>
              ) : null}

              {used ? (
                <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm">
                  <p className="font-medium">One action used — burner retired.</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    This burner cannot perform a second business action; the
                    state model blocks reuse and back-navigation cannot revive
                    it. Restarting begins a <em>new</em> simulated burner, not
                    a reuse of this one.
                  </p>
                </div>
              ) : null}

              {used || (sim && failed) ? (
                <LinkButton href="/rescan" className="w-full">
                  Continue to re-scan →
                </LinkButton>
              ) : null}
              <p className="text-[11px] text-muted-foreground">
                Simulated only — no relayer, paymaster, contract call or real
                transaction exists in this demo.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
