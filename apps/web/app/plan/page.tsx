"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/motion/card";
import { StatefulButton } from "@/components/motion/button/stateful";
import { LinkButton } from "@/components/link-button";
import { AnimatedBadge } from "@/components/motion/animated-badge";
import { RecoveryCard } from "@/components/recovery";
import { useFlow } from "@/lib/flow/store";
import { SAMPLE_PROFILES } from "@/lib/flow/profiles";
import {
  approvalPreview,
  SIMULATED_USDC_BUDGET,
  validatePlanDraft,
} from "@/lib/flow/plan";
import { ethBudgetFromProfile } from "@/lib/flow/plan";
import { shortenAddress } from "@/lib/flow/money";
import { formatUnits } from "@/lib/flow/money";

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
      {label}
      {children}
      {hint ? <span className="text-[11px]">{hint}</span> : null}
    </label>
  );
}

const inputCls =
  "h-10 rounded-lg border border-border bg-card px-3 text-sm text-foreground tabular-nums";

export default function PlanPage() {
  const router = useRouter();
  const {
    state,
    ensurePlanDraft,
    setPlanDraft,
    approvePlan,
  } = useFlow();
  const [errors, setErrors] = useState<string[]>([]);
  const [approving, setApproving] = useState(false);

  const { scan, planDraft, planApproval } = state;

  useEffect(() => {
    ensurePlanDraft();
  }, [ensurePlanDraft]);

  const ctx = useMemo(() => {
    if (!state.profileId || !scan.profile) return null;
    return {
      profileId: state.profileId,
      ethBudgetWei: ethBudgetFromProfile(scan.profile),
    };
  }, [state.profileId, scan.profile]);

  const validation = useMemo(
    () => (planDraft && ctx ? validatePlanDraft(planDraft, ctx) : null),
    [planDraft, ctx],
  );

  if (scan.status !== "done" || !scan.report || !scan.profile) {
    return (
      <RecoveryCard title="No scan to plan from">
        The plan is derived from a completed scan. Start a sample scan first.
      </RecoveryCard>
    );
  }

  if (!planDraft) {
    return (
      <div className="py-16 text-center text-sm text-muted-foreground" role="status">
        Preparing plan draft…
      </div>
    );
  }

  const approvals = approvalPreview(scan.profile);
  const approved = planApproval?.plan ?? null;

  const approve = async () => {
    setApproving(true);
    setErrors([]);
    const result = await approvePlan();
    setApproving(false);
    if (!result.ok) {
      setErrors(result.errors ?? ["Approval failed."]);
    }
  };

  const set = (patch: Partial<typeof planDraft>) =>
    setPlanDraft({ ...planDraft, ...patch });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Remediation plan — UI preview
        </h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Old wallet → confidential balance → fresh destinations. Gas arrives
          separately through the private path — there is no public old-to-new
          top-up that would link the wallets. This draft is{" "}
          <strong className="text-foreground">not</strong> the backend
          planner: it previews the shape of a NEAR Confidential Intents move
          for the simulated tracker. Amounts are integer base units
          underneath; fees are simulated estimates, not live quotes.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle as="h2">Chunk allocation &amp; timing</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <Field label="Chunks (1–4)" hint="Splits the move into separate private deposits.">
                <input
                  className={inputCls}
                  inputMode="numeric"
                  value={planDraft.chunkCount}
                  onChange={(e) => set({ chunkCount: e.target.value })}
                  aria-label="Chunk count"
                />
              </Field>
              <Field label="USDC per chunk" hint={`Simulated budget: ${SIMULATED_USDC_BUDGET} USDC total (not a live balance).`}>
                <input
                  className={inputCls}
                  inputMode="decimal"
                  value={planDraft.usdcPerChunk}
                  onChange={(e) => set({ usdcPerChunk: e.target.value })}
                  aria-label="USDC per chunk"
                />
              </Field>
              <Field label="ETH per chunk (gas money)" hint={`Recorded fixture budget: ${formatUnits(ctx?.ethBudgetWei?.toString() ?? "0", 18)} ETH across wallets.`}>
                <input
                  className={inputCls}
                  inputMode="decimal"
                  value={planDraft.ethPerChunk}
                  onChange={(e) => set({ ethPerChunk: e.target.value })}
                  aria-label="ETH per chunk"
                />
              </Field>
              <Field label="First withdrawal delay (demo minutes)" hint="Shortened for the demo — short delays are linkable in real use.">
                <input
                  className={inputCls}
                  inputMode="decimal"
                  value={planDraft.startDelayMin}
                  onChange={(e) => set({ startDelayMin: e.target.value })}
                  aria-label="Start delay minutes"
                />
              </Field>
              <Field label="Spacing between withdrawals (demo minutes)" hint="Wider spacing reduces timing correlation.">
                <input
                  className={inputCls}
                  inputMode="decimal"
                  value={planDraft.spreadMin}
                  onChange={(e) => set({ spreadMin: e.target.value })}
                  aria-label="Spacing minutes"
                />
              </Field>
            </CardContent>
          </Card>

          {validation && !validation.ok ? (
            <div role="alert" className="rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm">
              <p className="font-medium text-red-300">Plan invalid — fix before approving:</p>
              <ul className="mt-1 list-disc pl-5 text-foreground/90">
                {validation.errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {validation?.warnings.map((w) => (
            <p key={w} className="text-xs text-muted-foreground">
              {w}
            </p>
          ))}

          {approvals.length > 0 ? (
            <Card className="border-amber-500/30">
              <CardHeader>
                <CardTitle as="h2">Approval / revoke preview</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-2 text-sm">
                <p className="text-muted-foreground">
                  The fixture records these open approvals. Revoking them is a
                  real on-chain action — shown here as a preview only; nothing
                  is executed.
                </p>
                {approvals.map((a) => (
                  <div
                    key={`${a.owner}:${a.spender}:${a.token}`}
                    className="rounded-lg border border-border bg-muted/30 px-3 py-2 font-mono text-xs"
                  >
                    {shortenAddress(a.owner, 6)} approved{" "}
                    {shortenAddress(a.spender, 6)} on {a.chain} for{" "}
                    {shortenAddress(a.token, 10)}
                    <span className="block text-muted-foreground">
                      tx {shortenAddress(a.txHash, 8)} — revoke recommended
                    </span>
                  </div>
                ))}
              </CardContent>
            </Card>
          ) : null}
        </div>

        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle as="h2">Approval</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 text-sm">
              {approved ? (
                <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2">
                  <AnimatedBadge size="sm" status="success">
                    simulation approved
                  </AnimatedBadge>
                  <p className="mt-1.5 font-mono text-xs text-muted-foreground">
                    plan {approved.hash} · {approved.chunks.length} chunk(s) ·{" "}
                    {approved.totals.usdc} USDC + {approved.totals.eth} ETH
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Approved {new Date(approved.approvedAt).toLocaleTimeString()}.
                    Any edit above revokes this approval.
                  </p>
                </div>
              ) : (
                <p className="text-muted-foreground">
                  Review the draft, then approve the{" "}
                  <strong className="text-foreground">simulation</strong>. No
                  signature, wallet prompt or funds are involved.
                </p>
              )}

              {errors.length ? (
                <div role="alert" className="text-xs text-red-400">
                  {errors.map((e) => (
                    <p key={e}>{e}</p>
                  ))}
                </div>
              ) : null}

              {approved ? (
                <LinkButton href="/move" className="w-full">
                  Open move tracker
                </LinkButton>
              ) : (
                <StatefulButton
                  className="w-full"
                  state={approving ? "loading" : "idle"}
                  loadingText="Validating…"
                  disabled={!validation?.ok || approving}
                  onClick={() => void approve()}
                >
                  Approve simulation
                </StatefulButton>
              )}
              <p className="text-[11px] text-muted-foreground">
                “Approve simulation” freezes this exact draft — the move
                tracker can only run an approved plan.
              </p>
            </CardContent>
          </Card>

          {approved ? (
            <Card>
              <CardHeader>
                <CardTitle as="h2">Approved plan</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="flex flex-col gap-2 text-sm">
                  {approved.chunks.map((c) => (
                    <li
                      key={c.index}
                      className="rounded-lg border border-border bg-muted/30 px-3 py-2"
                    >
                      <div className="flex items-center justify-between font-mono text-xs">
                        <span>
                          chunk {c.index + 1}: {c.usdc} USDC + {c.eth} ETH
                        </span>
                        <AnimatedBadge size="sm" status="neutral">
                          simulated fee {(Number(approved.simulatedFeeUsdc) / approved.chunks.length).toFixed(4)} USDC
                        </AnimatedBadge>
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        deposit {shortenAddress(c.depositAddress, 6)} → dest{" "}
                        {shortenAddress(c.destination, 6)}
                      </div>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}
