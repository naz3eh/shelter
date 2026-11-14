"use client";

/**
 * The money trail for one Connect session: confidential-balance withdrawals
 * into the dapp address, every use, and the sweep back. Each step shows its
 * 1Click status and transaction link, so it is visible that funds never
 * touch a known wallet.
 */

import { motion, useReducedMotion } from "motion/react";
import { ArrowDownToLine, Ban, Link2, Lock, Send, Undo2 } from "lucide-react";
import type { ConnectAccountView } from "@/lib/connect-source";
import { BURNER_ASSETS } from "@shelter/burner";
import { requestListLabel } from "@/lib/request-decode";
import { CopyableHash } from "./copyable-hash";
import { BASESCAN_TX, formatToken, shortHash } from "@/lib/connect-format";
import { Pill, Reveal, SectionTitle, truncMid } from "./primitives";
import { cn } from "@/lib/utils";

type Tone = "open" | "funding" | "use" | "blocked" | "sweep" | "close";

interface TimelineEvent {
  at: string;
  tone: Tone;
  title: string;
  detail?: string;
  status?: string;
  outcome?: string;
  /** Raw tx hash; rendered shortened with copy + Basescan link. */
  hash?: string;
}

const TONE_ICON = {
  open: Link2,
  funding: ArrowDownToLine,
  use: Send,
  blocked: Ban,
  sweep: Undo2,
  close: Lock,
} as const;

const TONE_CHIP = {
  open: "border bg-surface-2 text-muted-foreground",
  funding: "border border-shelter/30 bg-shelter/12 text-shelter",
  use: "border border-shelter/30 bg-shelter/12 text-shelter",
  blocked: "border border-destructive/35 bg-destructive/12 text-destructive",
  sweep: "border border-shelter/30 bg-shelter/12 text-shelter",
  close: "border border-shelter/30 bg-shelter/12 text-shelter",
} as const;

function buildEvents(view: ConnectAccountView): TimelineEvent[] {
  const { account, fundingJobs } = view;
  const events: TimelineEvent[] = [];

  events.push({
    at: account.createdAt,
    tone: "open",
    title: `Open: dapp address ${shortHash(account.address.address)} bound to ${account.dapp.origin}`,
    detail: "derived from the local seed; used only by this dapp",
  });

  for (const job of fundingJobs) {
    const legs = [
      ...job.gas.map((leg, i) => ({ leg, which: i === 0 ? "gas" : `gas top-up ${i}` })),
      ...(job.asset ? [{ leg: job.asset, which: "asset" as const }] : []),
    ];
    for (const { leg, which } of legs) {
      const asset = BURNER_ASSETS[leg.asset];
      const pay = BURNER_ASSETS[leg.payWith ?? leg.asset];
      for (const a of leg.attempts) {
        events.push({
          at: a.statusAt ?? a.submitted?.at ?? a.quote.provenance.timestamp,
          tone: "funding",
          title: `1Click withdrawal: ${formatToken(leg.amount, asset.decimals, asset.symbol)} to the dapp address`,
          detail: `paid in ${pay.symbol} from the confidential balance · ${which} leg`,
          status: a.status,
          outcome: a.outcome,
        });
      }
    }
  }

  for (const r of account.requests) {
    events.push({
      at: r.at,
      tone: r.decision === "blocked" ? "blocked" : "use",
      title: requestListLabel(r),
      detail: r.decision === "blocked" ? "blocked by the linkage check" : r.decision,
      hash: r.tx?.hash,
    });
  }

  for (const item of account.sweep?.items ?? []) {
    events.push({
      at: item.tx?.broadcastAt ?? item.tx?.signedAt ?? item.quote?.provenance.timestamp ?? account.sweep?.startedAt ?? account.updatedAt,
      tone: "sweep",
      title: `Sweep ${formatToken(item.balance, item.decimals, item.symbol)} back`,
      detail: item.decision === "deposit" ? "1Click deposit into the confidential balance" : item.note,
      status: item.status,
      outcome: item.outcome,
      hash: item.tx?.hash,
    });
  }

  if (account.status === "closed") {
    events.push({
      at: account.updatedAt,
      tone: "close",
      title: "Close: dapp address retired, funds back in the confidential balance",
    });
  }

  return events.sort((a, b) => a.at.localeCompare(b.at));
}

/** Renders 0x… addresses inside a timeline title as copyable chips. */
function TlTitle({ s }: { s: string }) {
  return (
    <>
      {s.split(/(0x[a-fA-F0-9]{30,})/).map((p, i) =>
        /^0x[a-fA-F0-9]{30,}$/.test(p) ? (
          <span key={i} className="font-mono text-[0.85em]">{truncMid(p)}</span>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

export function FundingTimeline({ view }: { view: ConnectAccountView }) {
  const reduce = useReducedMotion();
  const events = buildEvents(view);
  return (
    <Reveal>
      <SectionTitle
        title="Funding timeline"
        sub="The money goes confidential balance to dapp address and back through 1Click. It never touches your NEAR account's public side or your main wallet."
      />
      <ol className="relative ml-4 border-l pl-8">
        {events.map((e, i) => {
          const Icon = TONE_ICON[e.tone];
          return (
            <motion.li
              key={`${e.at}-${i}`}
              initial={reduce ? false : { opacity: 0, y: 8 }}
              whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-40px" }}
              transition={{ duration: 0.35, delay: Math.min(i * 0.04, 0.4) }}
              className="relative pb-8 last:pb-0"
            >
              <span
                className={cn(
                  "absolute -left-[49px] top-0 grid size-8 place-items-center rounded-full ring-4 ring-background",
                  TONE_CHIP[e.tone],
                )}
                aria-hidden
              >
                <Icon className="size-3.5" />
              </span>
              <p className="break-words text-sm leading-6">
                <TlTitle s={e.title} />
                {e.status ? (
                  <Pill tone={e.status === "SUCCESS" ? "ok" : "warn"} className="ml-2 align-middle font-mono text-[10px]">
                    1Click: {e.status}
                    {e.outcome ? ` · ${e.outcome}` : ""}
                  </Pill>
                ) : null}
              </p>
              <p className={cn("mt-0.5 text-xs", e.tone === "blocked" ? "text-destructive" : "text-muted-foreground")}>
                {e.detail}
              </p>
              <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-faint">
                <span className="tabular-nums">
                  {new Date(e.at).toLocaleString([], {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  })}
                </span>
                {e.hash ? <CopyableHash value={e.hash} href={BASESCAN_TX(e.hash)} label="Copy transaction hash" /> : null}
              </p>
            </motion.li>
          );
        })}
      </ol>
    </Reveal>
  );
}
