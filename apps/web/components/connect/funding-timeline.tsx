"use client";

/**
 * The money trail for one Connect session: confidential-balance withdrawals
 * into the dapp address, every use, and the sweep back. Each step shows its
 * 1Click status and transaction link, so it is visible that funds never
 * touch a known wallet.
 */

import { motion, useReducedMotion } from "motion/react";
import { ArrowDownToLine, Ban, Coins, Send, Undo2 } from "lucide-react";
import type { ConnectAccountView } from "@/lib/connect-source";
import { BURNER_ASSETS } from "@shelter/burner";
import { CopyableHash } from "./copyable-hash";
import { BASESCAN_TX, formatToken, shortHash } from "@/lib/connect-format";
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
  open: Coins,
  funding: ArrowDownToLine,
  use: Send,
  blocked: Ban,
  sweep: Undo2,
  close: Coins,
} as const;

const TONE_DOT = {
  open: "bg-muted-foreground/50",
  funding: "bg-sky-400/80",
  use: "bg-emerald-400/80",
  blocked: "bg-red-400/90",
  sweep: "bg-violet-400/80",
  close: "bg-muted-foreground/50",
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
    const isFund = job.action.kind === "fund";
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
    void isFund;
  }

  for (const r of account.requests) {
    events.push({
      at: r.at,
      tone: r.decision === "blocked" ? "blocked" : "use",
      title: r.summary,
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

export function FundingTimeline({ view }: { view: ConnectAccountView }) {
  const reduce = useReducedMotion();
  const events = buildEvents(view);
  return (
    <section id="connect-timeline" className="flex scroll-mt-24 flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Funding timeline</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          The money goes confidential balance to dapp address and back through
          1Click. It never touches your NEAR account&apos;s public side or your main
          wallet.
        </p>
      </div>
      <ol className="relative flex flex-col gap-0">
        {events.map((e, i) => {
          const Icon = TONE_ICON[e.tone];
          const last = i === events.length - 1;
          return (
            <motion.li
              key={`${e.at}-${i}`}
              initial={reduce ? false : { opacity: 0, x: -8 }}
              whileInView={reduce ? undefined : { opacity: 1, x: 0 }}
              viewport={{ once: true, margin: "-40px" }}
              transition={{ duration: 0.3, delay: Math.min(i * 0.04, 0.4) }}
              className="relative flex gap-3 pb-5 last:pb-0"
            >
              {!last ? (
                <span className="absolute left-[15px] top-8 h-[calc(100%-2rem)] w-px bg-border" aria-hidden />
              ) : null}
              <span
                className={cn(
                  "z-10 mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border bg-card",
                  TONE_DOT[e.tone],
                )}
                aria-hidden
              >
                <Icon className="h-3.5 w-3.5" />
              </span>
              <div className="min-w-0 flex-1 pt-0.5">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-sm text-foreground">{e.title}</span>
                  {e.status ? (
                    <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                      1Click: {e.status}
                      {e.outcome ? ` · ${e.outcome}` : ""}
                    </span>
                  ) : null}
                </div>
                {e.detail ? <p className="mt-0.5 text-xs text-muted-foreground">{e.detail}</p> : null}
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {new Date(e.at).toLocaleString([], {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  })}
                  {e.hash ? (
                    <>
                      {" · "}
                      <CopyableHash
                        value={e.hash}
                        href={BASESCAN_TX(e.hash)}
                        label="Copy transaction hash"
                      />
                    </>
                  ) : null}
                </p>
              </div>
            </motion.li>
          );
        })}
      </ol>
    </section>
  );
}
