"use client";

/**
 * The Shelter Connect demo: dapp accounts, their requests (with the
 * approval sheet), and the sections that prove the privacy claims.
 * Reads through ConnectSource, so the same UI runs on the replay fixture
 * today and on the live wallet once packages/connect ships a browser entry.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { LayoutGrid, Link2, ShieldCheck } from "lucide-react";
import type { ConnectAccount, RequestRecord } from "@shelter/connect";
import {
  connectSource,
  type ConnectAccountView,
  type ConnectSource,
} from "@/lib/connect-source";
import { DappCard } from "./dapp-card";
import { CopyableHash } from "./copyable-hash";
import { BASESCAN_TX, formatToken, shortAddress } from "@/lib/connect-format";
import { RequestRow } from "./request-row";
import { RequestSheet } from "./request-sheet";
import { ConnectGraph } from "./connect-graph";
import { FundingTimeline } from "./funding-timeline";
import { ConnectVerified } from "./connect-verified";
import { LinkagePanel } from "./linkage-panel";
import { requestListLabel } from "@/lib/request-decode";
import { BottomSheet } from "@/components/motion/bottom-sheet";
import { Btn, Pill, Reveal, SectionTitle } from "./primitives";
import { cn } from "@/lib/utils";

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
            "w-full rounded-lg border border-input bg-background/60 px-3 py-2 font-mono text-xs text-foreground",
            "placeholder:text-faint/70",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          )}
        />
        {mode === "replay" ? (
          <p className="rounded-lg border border-border bg-surface/60 px-3 py-2 text-sm text-muted-foreground">
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
        <Btn disabled className="opacity-60">
          {mode === "replay" ? "Pairing needs the live wallet" : "Live wallet not available"}
        </Btn>
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
      description={account ? `${account.dapp.origin} · ${shortAddress(account.address.address)}` : undefined}
    >
      <div className="flex flex-col gap-3 text-sm">
        {account?.status === "closed" ? (
          <p className="rounded-lg border border-shelter/30 bg-shelter/10 px-3 py-2 text-shelter">
            This recorded session already ran close: every token and the ETH balance
            went back to the confidential balance through 1Click, and the dapp
            address is retired.
          </p>
        ) : mode === "replay" ? (
          <p className="rounded-lg border border-border bg-surface/60 px-3 py-2 text-muted-foreground">
            Closing needs the live wallet: it sweeps the dapp address&apos; balances
            back into the confidential balance and retires the address. This page is
            replaying a recorded session.
          </p>
        ) : (
          <p className="rounded-lg border border-border bg-surface/60 px-3 py-2 text-muted-foreground">
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

  // "Try an allowed request" opens the sheet on the sent contract call from
  // the recording (the dapp transaction that was allowed, not the approval).
  useEffect(() => {
    const onAllowed = () => {
      const sent = Object.values(views)
        .flatMap((v) => v.account.requests)
        .filter((r) => r.decision === "sent" && r.method === "eth_sendTransaction" && r.tx);
      const contractCall = sent.filter((r) => requestListLabel(r).startsWith("Contract call"));
      const pick = contractCall.at(-1) ?? sent.at(-1);
      if (pick) openRequest(pick);
      else document.getElementById("connect-demo")?.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    window.addEventListener("shelter:try-allowed", onAllowed);
    return () => window.removeEventListener("shelter:try-allowed", onAllowed);
  }, [views, openRequest]);

  const view = selectedId ? views[selectedId] : undefined;
  const blockedCount = accounts?.reduce(
    (n, a) => n + a.requests.filter((r) => r.decision === "blocked").length,
    0,
  );

  return (
    <div id="connect-demo" className="flex scroll-mt-20 flex-col gap-24">
      <Reveal>
        <div className="flex flex-wrap items-center gap-2.5">
          <h2 className="text-2xl font-semibold tracking-tight">Shelter Connect</h2>
          <Pill className="border-foreground/20 bg-foreground/5 text-foreground" dot>
            {source.mode === "replay" ? "Recorded session" : "Live wallet"}
          </Pill>
          {blockedCount ? (
            <Pill tone="danger">
              {blockedCount} request{blockedCount === 1 ? "" : "s"} blocked
            </Pill>
          ) : null}
        </div>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Each dapp gets its own Base address, funded from the confidential balance
          through 1Click. Requests that would link it to your other wallets are
          blocked. Closing sweeps the funds back.
        </p>
      </Reveal>

      {error ? (
        <p role="alert" className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-foreground">
          {error}
        </p>
      ) : null}

      {accounts === null && !error ? (
        <p className="text-sm text-muted-foreground">Loading the recorded session…</p>
      ) : null}

      {accounts?.length ? (
        <Reveal>
          <SectionTitle icon={<LayoutGrid />} title="Dapps" />
          <ul className="grid gap-4 md:grid-cols-2">
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
        </Reveal>
      ) : null}

      {view ? (
        <Reveal>
          <SectionTitle
            icon={<ShieldCheck />}
            title="Requests"
            sub={`What ${view.account.dapp.name ?? view.account.dapp.origin} asked for, and what Shelter decided. Open the blocked one to see the approval sheet.`}
          />
          <ul className="space-y-2">
            {view.account.requests.map((r) => (
              <RequestRow key={r.seq} request={r} onOpen={() => openRequest(r)} />
            ))}
          </ul>
        </Reveal>
      ) : null}

      {view ? <ConnectGraph view={view} /> : null}
      {view ? <FundingTimeline view={view} /> : null}
      {view ? <ConnectVerified view={view} /> : null}

      <Reveal>
        <SectionTitle icon={<Link2 />} title="Try the linkage check" />
        <LinkagePanel />
      </Reveal>

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
