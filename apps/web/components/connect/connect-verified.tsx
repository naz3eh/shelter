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
import { ExternalLink, ShieldCheck } from "lucide-react";
import type { ConnectAccountView } from "@/lib/connect-source";
import { verifySession, type VerifyCheck } from "@/lib/connect-verify";
import { VerifiedPanel } from "@/components/verified-panel";
import { cn } from "@/lib/utils";
import { BASESCAN_TX } from "@/lib/connect-format";
import { CopyableHash } from "./copyable-hash";

function CheckRow({ check }: { check: VerifyCheck }) {
  return (
    <li className="flex items-start gap-2 rounded-md px-2 py-1 text-xs">
      <span
        className={cn(
          "mt-0.5 inline-block h-3.5 w-3.5 shrink-0 rounded-full text-center leading-3.5",
          check.status === "pass"
            ? "bg-emerald-500/15 text-emerald-400"
            : "bg-destructive/20 text-destructive",
        )}
        aria-hidden
      >
        {check.status === "pass" ? "✓" : "✕"}
      </span>
      <span className="min-w-0 flex-1">
        <span className="text-foreground">{check.label}</span>
        {check.detail ? <span className="text-muted-foreground"> ({check.detail})</span> : null}
        {check.hash ? (
          <CopyableHash
            value={check.hash}
            href={check.link ?? BASESCAN_TX(check.hash)}
            label="Copy transaction hash"
            className="ml-1.5"
          />
        ) : check.link ? (
          <a
            href={check.link}
            target="_blank"
            rel="noreferrer"
            className="ml-1.5 inline-flex items-center gap-0.5 text-foreground underline underline-offset-2"
            aria-label={`View ${check.label} on Basescan`}
          >
            Basescan <ExternalLink className="h-3 w-3" aria-hidden />
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

  return (
    <section id="connect-verified" className="flex scroll-mt-24 flex-col gap-4">
      <div>
        <h2 className="flex items-center gap-2 text-lg font-semibold text-foreground">
          <ShieldCheck className="h-5 w-5 text-muted-foreground" aria-hidden />
          Verified session
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Every signature and transaction below is checked offline against the
          recording. Nothing here trusts the UI&apos;s own say-so.
        </p>
      </div>

      <div className="rounded-2xl border border-border bg-card/70 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <span
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-semibold",
              checks === null
                ? "border-border bg-muted text-muted-foreground"
                : allPass
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                  : "border-destructive/50 bg-destructive/15 text-red-300",
            )}
          >
            {checks === null
              ? "Checking…"
              : failed
                ? "Verification error"
                : `${passCount}/${total} checks passed`}
          </span>
          <span className="text-xs text-muted-foreground">
            Recorded session · computed from the recording data
          </span>
        </div>
        {checks ? (
          <motion.ul
            initial={reduce ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.3 }}
            className="mt-3 grid gap-0.5 sm:grid-cols-2"
          >
            {checks.map((c) => (
              <CheckRow key={c.id} check={c} />
            ))}
          </motion.ul>
        ) : failed ? (
          <p className="mt-3 text-sm text-destructive">Could not verify the recording.</p>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">Running checks…</p>
        )}
      </div>

      <VerifiedPanel />
    </section>
  );
}
