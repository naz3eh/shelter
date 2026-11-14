"use client";

/**
 * The verified panel for a recorded Connect session: every check is computed
 * from the recording (1Click quote signatures, NEP-413 withdrawal signatures,
 * dapp-signed transactions, sweep deposits, linkage re-checks), each with its
 * Basescan link where one exists. The NEAR AI TEE attestation panel stays
 * below for the explainer.
 */

import { useEffect, useMemo, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { CircleCheck, CircleX, ShieldCheck } from "lucide-react";
import type { ConnectAccountView } from "@/lib/connect-source";
import { verifySession, type VerifyCheck } from "@/lib/connect-verify";
import { VerifiedPanel } from "@/components/verified-panel";
import { Pill, Reveal, SectionTitle, TxChip } from "./primitives";
import { cn } from "@/lib/utils";
import { BASESCAN_TX } from "@/lib/connect-format";

function CheckItem({ check }: { check: VerifyCheck }) {
  const pass = check.status === "pass";
  return (
    <li className="flex gap-2.5 py-2 text-[13px] leading-relaxed">
      {pass ? (
        <CircleCheck className="mt-0.5 size-4 shrink-0 text-shelter" aria-hidden />
      ) : (
        <CircleX className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
      )}
      <span className="min-w-0">
        {check.label}
        {check.detail ? <span className="text-faint"> ({check.detail})</span> : null}
        {check.hash ? (
          <span className="ml-1.5">
            <TxChip hash={check.hash} href={check.link ?? BASESCAN_TX(check.hash)} />
          </span>
        ) : check.link ? (
          <a
            href={check.link}
            target="_blank"
            rel="noreferrer"
            className="ml-1.5 text-foreground underline underline-offset-2"
            aria-label={`View ${check.label} on Basescan`}
          >
            Basescan
          </a>
        ) : null}
      </span>
    </li>
  );
}

export function ConnectVerified({ view }: { view: ConnectAccountView }) {
  const reduce = useReducedMotion();
  const [checks, setChecks] = useState<VerifyCheck[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    verifySession(view)
      .then((c) => {
        if (!cancelled) setChecks(c);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [view]);

  const passCount = useMemo(() => checks?.filter((c) => c.status === "pass").length ?? 0, [checks]);
  const total = checks?.length ?? 0;
  const allPass = checks !== null && passCount === total && total > 0;
  const mid = Math.ceil((checks?.length ?? 0) / 2);
  const left = checks?.slice(0, mid) ?? [];
  const right = checks?.slice(mid) ?? [];

  return (
    <Reveal>
      <SectionTitle
        icon={<ShieldCheck />}
        title="Verified session"
        sub="Every signature and transaction below is checked offline against the recording. Nothing here trusts the UI's own say-so."
      />
      <div className="panel overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 border-b bg-shelter/[0.04] px-5 py-4">
          <Pill tone={checks === null ? "neutral" : allPass ? "ok" : "danger"} className="px-3 py-1 text-sm">
            <ShieldCheck className="size-3.5" aria-hidden />
            {checks === null
              ? "Checking…"
              : failed
                ? "Verification error"
                : `${passCount}/${total} checks passed`}
          </Pill>
          <span className="text-xs text-muted-foreground">
            Recorded session · computed from the recording data
          </span>
        </div>
        {checks ? (
          <motion.div
            initial={reduce ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.3 }}
            className="grid gap-x-8 px-5 py-3 md:grid-cols-2"
          >
            <ul className="divide-y divide-border/60">
              {left.map((c) => (
                <CheckItem key={c.id} check={c} />
              ))}
            </ul>
            <ul className="divide-y divide-border/60">
              {right.map((c) => (
                <CheckItem key={c.id} check={c} />
              ))}
            </ul>
          </motion.div>
        ) : failed ? (
          <p className="px-5 py-4 text-sm text-destructive">Could not verify the recording.</p>
        ) : (
          <p className="px-5 py-4 text-sm text-muted-foreground">Running checks…</p>
        )}
      </div>

      <div className="mt-4">
        <VerifiedPanel />
      </div>
    </Reveal>
  );
}
