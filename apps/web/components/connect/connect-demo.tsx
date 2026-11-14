"use client";

/**
 * The Shelter Connect demo: dapp accounts, their requests (with the
 * approval sheet), and the sections that prove the privacy claims.
 * Reads through ConnectSource, so the same UI runs on the replay fixture
 * today and on the live wallet once packages/connect ships a browser entry.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { CircleDot, History, Link2, ShieldCheck } from "lucide-react";
import type { ConnectAccount, RequestRecord } from "@shelter/connect";
import {
  connectSource,
  type ConnectAccountView,
  type ConnectSource,
} from "@/lib/connect-source";
import { DappCard } from "./dapp-card";
import { CopyableHash } from "./copyable-hash";
import { BASESCAN_TX, formatToken } from "@/lib/connect-format";
import { RequestRow } from "./request-row";
import { RequestSheet } from "./request-sheet";
import { ConnectGraph } from "./connect-graph";
import { FundingTimeline } from "./funding-timeline";
import { ConnectVerified } from "./connect-verified";
import { LinkagePanel } from "./linkage-panel";
import { BottomSheet } from "@/components/motion/bottom-sheet";
import { cn } from "@/lib/utils";

function Section({
  id,
  icon: Icon,
  title,
  children,
}: {
  id: string;
  icon: typeof Link2;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="flex scroll-mt-24 flex-col gap-4">
      <h2 className="flex items-center gap-2 text-lg font-semibold text-foreground">
        <Icon className="h-5 w-5 text-muted-foreground" aria-hidden />
        {title}
      </h2>
      {children}
    </section>
  );
}

function PairSheet({
  open,
  onOpenChange,
  mode,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "replay" | "live";
}) {
  const [uri, setUri] = useState("");
  return (
    <BottomSheet
      open={open}
      onOpenChange={onOpenChange}
      snapPoints={["auto"]}
      title="Pair a dapp"
      description="Paste a WalletConnect link from the dapp"
    >
      <div className="flex flex-col gap-3">
        <label htmlFor="wc-uri" className="text-sm text-muted-foreground">
          WalletConnect URI
        </label>
        <textarea
          id="wc-uri"
          value={uri}
          onChange={(e) => setUri(e.target.value)}
          rows={3}
          placeholder="wc:…"
          className={cn(
            "w-full rounded-lg border border-border bg-muted/50 px-3 py-2 font-mono text-xs text-foreground",
            "placeholder:text-muted-foreground/60",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
          )}
        />
        {mode === "replay" ? (
          <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
            Pairing needs the live wallet: it derives a fresh address for the dapp and
            funds it from your confidential balance. This page is replaying a recorded
            session, so there is nothing to pair with. The recorded Uniswap session
            below shows what pairing produced.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            Live pairing is not in this build yet; it needs the browser wallet entry
            from packages/connect.
          </p>
        )}
        <button
          type="button"
          disabled
          className="rounded-lg border border-border bg-muted px-3 py-2 text-sm font-medium text-muted-foreground opacity-60"
        >
          {mode === "replay" ? "Pairing needs the live wallet" : "Live wallet not available"}
        </button>
      </div>
    </BottomSheet>
  );
}

/** What "Close and sweep back" does, with the recorded sweep when there is one. */
function CloseSheet({
  view,
  open,
  onOpenChange,
  mode,
}: {
  view: ConnectAccountView | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "replay" | "live";
}) {
  const account = view?.account;
  const items = account?.sweep?.items ?? [];
  return (
    <BottomSheet
      open={open}
      onOpenChange={onOpenChange}
      snapPoints={["auto"]}
      title="Close and sweep back"
      description={account ? `${account.dapp.origin} · ${account.address.address.slice(0, 6)}…${account.address.address.slice(-4)}` : undefined}
    >
      <div className="flex flex-col gap-3 text-sm">
        {account?.status === "closed" ? (
          <p className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-emerald-200">
            This recorded session already ran close: every token and the ETH balance
            went back to the confidential balance through 1Click, and the dapp
            address is retired.
          </p>
        ) : mode === "replay" ? (
          <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-muted-foreground">
            Closing needs the live wallet: it sweeps the dapp address&apos; balances
            back into the confidential balance and retires the address. This page is
            replaying a recorded session.
          </p>
        ) : (
          <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-muted-foreground">
            Live close is not in this build yet; it needs the browser wallet entry
            from packages/connect.
          </p>
        )}
        {items.length ? (
          <ul className="flex flex-col gap-1.5">
            {items.map((item, i) => {
              return (
                <li key={i} className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                  <span className="text-foreground">
                    {formatToken(item.balance, item.decimals, item.symbol)}
                  </span>
                  <span>{item.decision === "deposit" ? "deposited to the confidential balance" : item.note}</span>
                  {item.tx ? (
                    <CopyableHash
                      value={item.tx.hash}
                      href={BASESCAN_TX(item.tx.hash)}
                      label="Copy transaction hash"
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    </BottomSheet>
  );
}

export function ConnectDemo() {
  const reduce = useReducedMotion();
  const source: ConnectSource = useMemo(() => connectSource(), []);
  const [accounts, setAccounts] = useState<ConnectAccount[] | null>(null);
  const [views, setViews] = useState<Record<string, ConnectAccountView>>({});
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sheetRequest, setSheetRequest] = useState<RequestRecord | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [pairOpen, setPairOpen] = useState(false);
  const [closeView, setCloseView] = useState<ConnectAccountView | null>(null);
  const [closeOpen, setCloseOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await source.listAccounts();
        if (cancelled) return;
        setAccounts(list);
        const loaded: Record<string, ConnectAccountView> = {};
        for (const a of list) {
          const v = await source.getAccount(a.id);
          if (v) loaded[a.id] = v;
        }
        if (!cancelled) {
          setViews(loaded);
          setSelectedId((cur) => cur ?? list[0]?.id ?? null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [source]);

  const openRequest = useCallback((r: RequestRecord | null) => {
    setSheetRequest(r);
    setSheetOpen(!!r);
  }, []);

  // Landing "Try it" dispatches this; open the blocked request's sheet.
  useEffect(() => {
    const onTry = () => {
      const blocked = Object.values(views)
        .flatMap((v) => v.account.requests)
        .find((r) => r.decision === "blocked");
      if (blocked) openRequest(blocked);
      else document.getElementById("connect-demo")?.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    window.addEventListener("shelter:try-it", onTry);
    return () => window.removeEventListener("shelter:try-it", onTry);
  }, [views, openRequest]);

  const view = selectedId ? views[selectedId] : undefined;
  const blockedCount = accounts?.reduce(
    (n, a) => n + a.requests.filter((r) => r.decision === "blocked").length,
    0,
  );

  return (
    <div id="connect-demo" className="flex scroll-mt-20 flex-col gap-10">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-2xl font-semibold tracking-tight text-foreground">Shelter Connect</h2>
          <span className="rounded-full border border-border bg-muted px-3 py-1 text-xs font-medium text-muted-foreground">
            {source.mode === "replay" ? "Recorded session" : "Live wallet"}
          </span>
          {blockedCount ? (
            <span className="rounded-full border border-destructive/40 bg-destructive/10 px-3 py-1 text-xs font-medium text-red-300">
              {blockedCount} request{blockedCount === 1 ? "" : "s"} blocked
            </span>
          ) : null}
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Each dapp gets its own Base address, funded from the confidential balance
          through 1Click. Requests that would link it to your other wallets are
          blocked. Closing sweeps the funds back.
        </p>
      </header>

      {error ? (
        <p role="alert" className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-foreground">
          {error}
        </p>
      ) : null}

      {accounts === null && !error ? (
        <p className="text-sm text-muted-foreground">Loading the recorded session…</p>
      ) : null}

      {accounts?.length ? (
        <Section id="connect-dapps" icon={CircleDot} title="Dapps">
          <ul className="grid gap-3 lg:grid-cols-2">
            {accounts.map((a) => (
              <DappCard
                key={a.id}
                account={a}
                onPair={() => setPairOpen(true)}
                onClose={
                  views[a.id]
                    ? () => {
                        setCloseView(views[a.id]!);
                        setCloseOpen(true);
                      }
                    : undefined
                }
              />
            ))}
          </ul>
          <PairSheet open={pairOpen} onOpenChange={setPairOpen} mode={source.mode} />
          <CloseSheet view={closeView} open={closeOpen} onOpenChange={setCloseOpen} mode={source.mode} />
        </Section>
      ) : null}

      {view ? (
        <Section id="connect-requests" icon={ShieldCheck} title="Requests">
          <p className="text-sm text-muted-foreground">
            What {view.account.dapp.name ?? view.account.dapp.origin} asked for, and what
            Shelter decided. Open the blocked one to see the approval sheet.
          </p>
          <ul className="flex flex-col gap-2">
            {view.account.requests.map((r) => (
              <RequestRow key={r.seq} request={r} onOpen={() => openRequest(r)} />
            ))}
          </ul>
        </Section>
      ) : null}

      {view ? (
        <motion.div
          initial={reduce ? false : { opacity: 0, y: 12 }}
          whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-60px" }}
          transition={{ duration: 0.4 }}
        >
          <ConnectGraph view={view} />
        </motion.div>
      ) : null}

      {view ? <FundingTimeline view={view} /> : null}
      {view ? <ConnectVerified view={view} /> : null}

      <Section id="connect-linkage" icon={Link2} title="Try the linkage check">
        <LinkagePanel />
      </Section>

      {view ? (
        <RequestSheet
          view={view}
          request={sheetRequest}
          open={sheetOpen}
          onOpenChange={setSheetOpen}
        />
      ) : null}
    </div>
  );
}
