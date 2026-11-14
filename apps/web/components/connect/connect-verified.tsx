"use client";

/**
 * The verified panel for a recorded Connect session: every check is computed
 * from the recording (1Click quote signatures, NEP-413 withdrawal signatures,
 * dapp-signed transactions, sweep deposits, linkage re-checks), each with its
 * Basescan link where one exists. Checks are grouped by funding leg, request
 * and sweep; each group expands to its individual checks. The NEAR AI TEE
 * attestation panel stays below for the explainer.
 */

import { useEffect, useMemo, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { ChevronRight, CircleCheck, CircleX, ShieldCheck } from "lucide-react";
import type { ConnectAccountView } from "@/lib/connect-source";
import { verifySession, type VerifyCheck } from "@/lib/connect-verify";
import { VerifiedPanel } from "@/components/verified-panel";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/motion/collapsible";
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

interface CheckGroup {
  name: string;
  checks: VerifyCheck[];
}

/** Group checks by what they verify: funding leg, request, or sweep. */
function groupChecks(checks: VerifyCheck[]): CheckGroup[] {
  const groups = new Map<string, VerifyCheck[]>();
  for (const c of checks) {
    const m =
      c.label.match(/^funding (gas[^:]*|asset):/) ??
      c.label.match(/^request (\d+)/) ??
      c.label.match(/^sweep ([^:]+):/);
    let name: string;
    if (m) {
      if (c.label.startsWith("funding ")) {
        name = m[1] === "asset" ? "Funding asset" : "Funding gas";
      } else if (c.label.startsWith("request ")) {
        name = `Request ${m[1]}`;
      } else {
        name = `Sweep ${m[1]}`;
      }
    } else {
      name = "Other";
    }
    const list = groups.get(name) ?? [];
    list.push(c);
    groups.set(name, list);
  }
  return [...groups.entries()].map(([name, list]) => ({ name, checks: list }));
}

function GroupRow({ group }: { group: CheckGroup }) {
  const pass = group.checks.filter((c) => c.status === "pass").length;
  const allPass = pass === group.checks.length;
  return (
    <Collapsible>
      <CollapsibleTrigger className="group/row rounded-lg px-3 py-2.5 hover:bg-muted/40">
        <ChevronRight
          className="size-4 shrink-0 text-faint transition-transform group-data-[state=open]/row:rotate-90"
          aria-hidden
        />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {group.name}
        </span>
        <span className="font-mono text-xs tabular-nums text-faint">
          {pass}/{group.checks.length}
        </span>
        {allPass ? (
          <CircleCheck className="size-4 shrink-0 text-shelter" aria-hidden />
        ) : (
          <CircleX className="size-4 shrink-0 text-destructive" aria-hidden />
        )}
      </CollapsibleTrigger>
      <CollapsibleContent contentClassName="px-3 pb-2">
        <ul className="divide-y divide-border/60">
          {group.checks.map((c) => (
            <CheckItem key={c.id} check={c} />
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
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
  const groups = useMemo(() => (checks ? groupChecks(checks) : []), [checks]);

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
            className="px-2 py-2"
          >
            {groups.map((g) => (
              <GroupRow key={g.name} group={g} />
            ))}
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
