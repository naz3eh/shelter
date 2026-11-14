"use client";

import { ArrowLeftRight, FileSignature, PenLine, RefreshCw, Send, ShieldX, Wallet } from "lucide-react";
import type { RequestRecord } from "@shelter/connect";
import { requestListLabel } from "@/lib/request-decode";
import { cn } from "@/lib/utils";

const METHOD_ICON = {
  eth_sendTransaction: ArrowLeftRight,
  personal_sign: PenLine,
  eth_signTypedData_v4: FileSignature,
  wallet_switchEthereumChain: RefreshCw,
  eth_chainId: Wallet,
  eth_accounts: Wallet,
} as const;

const DECISION_STYLE: Record<string, string> = {
  sent: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  signed: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  blocked: "border-destructive/50 bg-destructive/15 text-red-300",
  rejected: "border-border bg-muted text-muted-foreground",
  failed: "border-destructive/50 bg-destructive/15 text-red-300",
  not_sent: "border-border bg-muted text-muted-foreground",
};

export function methodIcon(method: string) {
  return METHOD_ICON[method as keyof typeof METHOD_ICON] ?? Send;
}

export function RequestRow({
  request,
  onOpen,
}: {
  request: RequestRecord;
  onOpen: () => void;
}) {
  const Icon = methodIcon(request.method);
  const blocked = request.decision === "blocked";
  const decision = request.decision;
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className={cn(
          "flex w-full items-start gap-3 rounded-xl border px-4 py-3 text-left transition-colors",
          "border-border bg-card/60 hover:border-border-strong hover:bg-card",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
          blocked && "border-destructive/40",
        )}
      >
        <span
          className={cn(
            "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border",
            blocked
              ? "border-destructive/40 bg-destructive/10 text-red-300"
              : "border-border bg-muted text-muted-foreground",
          )}
          aria-hidden
        >
          {blocked ? <ShieldX className="h-4 w-4" /> : <Icon className="h-4 w-4" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm font-medium text-foreground">{requestListLabel(request)}</span>
            {decision ? (
              <span
                className={cn(
                  "rounded-full border px-2 py-0.5 text-[11px] font-medium",
                  DECISION_STYLE[decision] ?? DECISION_STYLE.not_sent,
                )}
              >
                {decision === "blocked" ? "Blocked by Shelter" : decision}
              </span>
            ) : null}
          </span>
          <span className="mt-1 block text-xs text-muted-foreground">
            {request.method} ·{" "}
            {new Date(request.at).toLocaleString([], {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        </span>
      </button>
    </li>
  );
}
