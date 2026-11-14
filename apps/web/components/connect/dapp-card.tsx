"use client";

import { useState } from "react";
import { ExternalLink, Lock, Plus, Undo2 } from "lucide-react";
import type { ConnectAccount } from "@shelter/connect";
import { BASESCAN_ADDRESS, formatToken } from "@/lib/connect-format";
import { BURNER_ASSETS } from "@shelter/burner";
import { Addr, Btn, Pill } from "./primitives";
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
      <span className="grid size-10 shrink-0 place-items-center rounded-xl border bg-surface-2 text-lg">
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
      className="size-10 shrink-0 rounded-xl border bg-surface-2 object-contain"
      onError={() => setFailed(true)}
    />
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
  const blocked = account.requests.filter((r) => r.decision === "blocked").length;
  return (
    <li className="panel p-5">
      <div className="flex items-start gap-3">
        <Favicon origin={account.dapp.origin} name={account.dapp.name} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <span className="font-medium">{account.dapp.name ?? host}</span>
              <a
                href={account.dapp.origin}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 truncate text-xs text-muted-foreground hover:text-foreground"
              >
                {host}
                <ExternalLink className="size-3" aria-hidden />
              </a>
            </div>
            <Pill>{closed ? "Closed" : account.status}</Pill>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
            <Addr value={account.address.address} />
            <a
              href={BASESCAN_ADDRESS(account.address.address)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
            >
              Basescan <ExternalLink className="size-3" aria-hidden />
            </a>
          </div>
          <dl className="mt-5 grid grid-cols-3 divide-x rounded-lg border bg-background/40">
            {(
              [
                ["Budget", formatToken(account.budget.amount, asset.decimals, asset.symbol)],
                ["Requests", String(account.requests.length)],
                ["Blocked", String(blocked)],
              ] as const
            ).map(([k, v]) => (
              <div key={k} className="px-3 py-2.5">
                <dt className="text-[11px] text-faint">{k}</dt>
                <dd className={cn("mt-0.5 text-sm font-medium tabular-nums", k === "Blocked" && blocked > 0 && "text-destructive")}>
                  {v}
                </dd>
              </div>
            ))}
          </dl>
          <div className="mt-4 flex flex-wrap gap-2">
            {onPair ? (
              <Btn className="h-8 text-xs" onClick={onPair}>
                <Plus className="size-3.5" aria-hidden />
                Pair a dapp
              </Btn>
            ) : null}
            {closed && !onClose ? (
              <Pill>
                <Lock className="size-3" aria-hidden />
                Swept back to the confidential balance
              </Pill>
            ) : onClose ? (
              <Btn variant="ghost" className="h-8 border text-xs" onClick={onClose} disabled={busy}>
                <Undo2 className="size-3.5" aria-hidden />
                Close and sweep back
              </Btn>
            ) : null}
          </div>
        </div>
      </div>
    </li>
  );
}
