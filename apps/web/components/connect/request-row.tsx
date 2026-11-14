"use client";

import { ArrowLeftRight, ChevronRight, FileSignature, PenLine, RefreshCw, Send, ShieldX, Wallet } from "lucide-react";
import type { RequestRecord } from "@shelter/connect";
import { requestListLabel } from "@/lib/request-decode";
import { Pill } from "./primitives";
import { cn } from "@/lib/utils";

const METHOD_ICON = {
  eth_sendTransaction: ArrowLeftRight,
  personal_sign: PenLine,
  eth_signTypedData_v4: FileSignature,
  wallet_switchEthereumChain: RefreshCw,
  eth_chainId: Wallet,
  eth_accounts: Wallet,
} as const;

const DECISION_PILL: Record<string, { tone: "ok" | "danger" | "neutral"; label: string }> = {
  sent: { tone: "ok", label: "sent" },
  signed: { tone: "ok", label: "signed" },
  blocked: { tone: "danger", label: "Blocked by Shelter" },
  rejected: { tone: "neutral", label: "rejected" },
  failed: { tone: "danger", label: "failed" },
  not_sent: { tone: "neutral", label: "not sent" },
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
  const pill = request.decision ? DECISION_PILL[request.decision] : undefined;
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className={cn(
          "group flex w-full items-start gap-3 rounded-xl p-4 text-left transition-colors",
          "focus-visible:outline-none focus-visible:ring-2",
          blocked
            ? "border border-destructive/30 bg-destructive/[0.06] shadow-[var(--shadow-panel)] hover:bg-destructive/10 focus-visible:ring-destructive/60"
            : "panel hover:bg-accent/60 focus-visible:ring-ring",
        )}
      >
        <span
          className={cn(
            "grid size-8 shrink-0 place-items-center rounded-lg border",
            blocked
              ? "border-destructive/30 bg-destructive/10 text-destructive"
              : "bg-surface-2 text-muted-foreground",
          )}
          aria-hidden
        >
          {blocked ? <ShieldX className="size-4" /> : <Icon className="size-4" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm leading-7">
            {requestListLabel(request)}{" "}
            {pill ? (
              <Pill tone={pill.tone} className="align-middle">
                {pill.label}
              </Pill>
            ) : null}
          </span>
          <span className="mt-0.5 block font-mono text-xs text-faint">
            {request.method} ·{" "}
            {new Date(request.at).toLocaleString([], {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        </span>
        {blocked ? (
          <ChevronRight className="mt-2 size-4 shrink-0 text-destructive transition-transform group-hover:translate-x-0.5" aria-hidden />
        ) : null}
      </button>
    </li>
  );
}
