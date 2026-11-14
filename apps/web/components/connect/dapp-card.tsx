"use client";

import { useState } from "react";
import { Check, Copy, ExternalLink, Lock, PlugZap } from "lucide-react";
import type { ConnectAccount } from "@shelter/connect";
import { BASESCAN_ADDRESS, formatToken, shortAddress } from "@/lib/connect-format";
import { BURNER_ASSETS } from "@shelter/burner";
import { cn } from "@/lib/utils";

function Favicon({ origin, name }: { origin: string; name?: string }) {
  const [failed, setFailed] = useState(false);
  const host = (() => {
    try {
      return new URL(origin).host;
    } catch {
      return origin;
    }
  })();
  if (failed) {
    return (
      <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-muted text-sm font-semibold text-muted-foreground">
        {(name ?? host).slice(0, 1).toUpperCase()}
      </span>
    );
  }
  // eslint-disable-next-line @next/next/no-img-element
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`${origin}/favicon.ico`}
      alt=""
      width={40}
      height={40}
      className="h-10 w-10 rounded-xl border border-border bg-card object-contain"
      onError={() => setFailed(true)}
    />
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
        } catch {
          const ta = document.createElement("textarea");
          ta.value = value;
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          ta.remove();
        }
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className={cn(
        "inline-flex h-6 w-6 items-center justify-center rounded-md border border-border text-muted-foreground",
        "transition-colors hover:border-border-strong hover:text-foreground",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
      )}
    >
      {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
    </button>
  );
}

export function DappCard({
  account,
  onPair,
  onClose,
  busy,
}: {
  account: ConnectAccount;
  onPair?: () => void;
  onClose?: () => void;
  busy?: boolean;
}) {
  const asset = BURNER_ASSETS[account.budget.asset];
  const closed = account.status === "closed";
  const host = (() => {
    try {
      return new URL(account.dapp.origin).host;
    } catch {
      return account.dapp.origin;
    }
  })();
  return (
    <li className="rounded-2xl border border-border bg-card/70 p-4">
      <div className="flex items-start gap-3">
        <Favicon origin={account.dapp.origin} name={account.dapp.name} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm font-semibold text-foreground">
              {account.dapp.name ?? host}
            </span>
            <a
              href={account.dapp.origin}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              {host}
              <ExternalLink className="h-3 w-3" aria-hidden />
            </a>
            <span
              className={cn(
                "ml-auto rounded-full border px-2 py-0.5 text-[11px] font-medium",
                closed
                  ? "border-border bg-muted text-muted-foreground"
                  : "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
              )}
            >
              {closed ? "Closed" : account.status}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <code className="rounded-md border border-border bg-muted/60 px-2 py-1 font-mono text-xs text-foreground">
              {shortAddress(account.address.address)}
            </code>
            <CopyButton value={account.address.address} label="Copy dapp address" />
            <a
              href={BASESCAN_ADDRESS(account.address.address)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              Basescan <ExternalLink className="h-3 w-3" aria-hidden />
            </a>
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
            <div>
              <dt className="text-muted-foreground">Budget</dt>
              <dd className="text-foreground">
                {formatToken(account.budget.amount, asset.decimals, asset.symbol)}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Requests</dt>
              <dd className="text-foreground">{account.requests.length}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Blocked</dt>
              <dd className="text-foreground">
                {account.requests.filter((r) => r.decision === "blocked").length}
              </dd>
            </div>
          </dl>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {onPair ? (
          <button
            type="button"
            onClick={onPair}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-muted/60 px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:border-border-strong hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <PlugZap className="h-3.5 w-3.5" aria-hidden />
            Pair a dapp
          </button>
        ) : null}
        {closed && !onClose ? (
          <span className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground">
            <Lock className="h-3.5 w-3.5" aria-hidden />
            Swept back to the confidential balance
          </span>
        ) : onClose ? (
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:border-destructive/50 hover:text-red-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50"
          >
            Close and sweep back
          </button>
        ) : null}
      </div>
    </li>
  );
}
