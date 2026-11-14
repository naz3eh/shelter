"use client";

/**
 * The approval sheet: what a dapp asked for, in plain words, and what
 * Shelter decided. For a blocked request it leads with the full-width
 * "Blocked by Shelter" state that names what would have been linked.
 */

import { useMemo } from "react";
import { AlertTriangle, Ban, CheckCircle2, ShieldX } from "lucide-react";
import { CopyableHash } from "./copyable-hash";
import { parseRequest, type Finding, type RequestRecord } from "@shelter/connect";
import { BottomSheet } from "@/components/motion/bottom-sheet";
import { decodeDappRequest } from "@/lib/request-decode";
import { BASESCAN_ADDRESS, BASESCAN_TX, shortenAddresses } from "@/lib/connect-format";
import { Pill } from "./primitives";
import { cn } from "@/lib/utils";
import type { ConnectAccountView } from "@/lib/connect-source";

export interface RequestSheetProps {
  view: ConnectAccountView;
  request: RequestRecord | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** What a block-level finding means for the person, in one sentence. */
function findingSentence(f: Finding): string {
  const msg = shortenAddresses(f.message);
  return msg.charAt(0).toUpperCase() + msg.slice(1) + ".";
}

function blockHeadline(request: RequestRecord, view: ConnectAccountView): string {
  const blocks = request.findings.filter((f) => f.level === "block");
  if (!blocks.length) return "Shelter blocked this request.";
  // Name the linked identity the request would have exposed, when the
  // findings say which one (the message embeds its label).
  const linked = view.linked;
  const owner = view.account.owner;
  const named = new Set<string>();
  for (const f of blocks) {
    for (const l of linked) if (f.message.toLowerCase().includes(l.label.toLowerCase())) named.add(l.label);
    if (f.message.toLowerCase().includes("near account")) named.add("your NEAR account");
    void owner;
  }
  const first = blocks[0]!;
  const verb =
    first.code === "recipient_linked"
      ? "sends to"
      : first.code === "calldata_linked"
        ? "has data naming"
        : first.code === "message_linked"
          ? "has a message naming"
          : first.code === "typed_data_linked"
            ? "has typed data naming"
            : "is blocked because";
  const who = named.size === 1 ? [...named][0] : undefined;
  if (who && ["recipient_linked", "calldata_linked", "message_linked", "typed_data_linked"].includes(first.code)) {
    return `This ${verb} ${who}.`;
  }
  return findingSentence(first);
}

export function RequestSheet({ view, request, open, onOpenChange }: RequestSheetProps) {
  const account = view.account;
  const decoded = useMemo(() => {
    if (!request?.params) return null;
    try {
      return decodeDappRequest(parseRequest(request.method, request.params));
    } catch {
      return null;
    }
  }, [request]);

  if (!request) return null;

  const dappName = account.dapp.name ?? account.dapp.origin;
  const isBlocked = request.decision === "blocked";
  const isSigned = request.decision === "signed";
  const isSent = request.decision === "sent";
  const blockFindings = request.findings.filter((f) => f.level === "block");
  const warnFindings = request.findings.filter((f) => f.level === "warn");
  const otherFindings = request.findings.filter((f) => f.level !== "block" && f.level !== "warn");
  const codes = [...new Set([...blockFindings, ...warnFindings].map((f) => f.code))];

  return (
    <BottomSheet
      open={open}
      onOpenChange={onOpenChange}
      snapPoints={["auto"]}
      title={`${dappName} request`}
      description={`${account.dapp.origin} · ${new Date(request.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`}
      className="max-w-2xl"
    >
      <div className="flex flex-col gap-4">
        {isBlocked ? (
          <div className="flex flex-col items-center px-2 py-2 text-center">
            <span className="relative grid size-14 place-items-center rounded-2xl border border-destructive/40 bg-destructive/15 text-destructive">
              <span aria-hidden className="absolute inset-0 rounded-2xl ring-8 ring-destructive/5" />
              <ShieldX className="size-7" aria-hidden />
            </span>
            <p className="mt-4 text-xl font-semibold tracking-tight">Blocked by Shelter</p>
            <p className="mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">
              {blockHeadline(request, view)} Approving it would have tied this
              dapp&apos;s address to someone you already use. Nothing was signed or
              sent.
            </p>
            {codes.length ? (
              <div className="mt-3 flex flex-wrap justify-center gap-1.5">
                {codes.map((c) => (
                  <span
                    key={c}
                    className="inline-flex items-center gap-1.5 rounded-md border border-destructive/35 bg-destructive/10 px-2 py-1 font-mono text-xs text-destructive"
                  >
                    <Ban className="size-3" aria-hidden />
                    {c}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        ) : isSent || isSigned ? (
          <div className="flex items-center gap-2 rounded-xl border border-shelter/30 bg-shelter/10 px-4 py-3 text-sm text-shelter">
            <CheckCircle2 className="size-4 shrink-0" aria-hidden />
            {isSigned ? "Signed" : "Sent"}
            {request.tx ? (
              <span className="ml-auto inline-flex items-center gap-2 font-mono text-xs text-shelter">
                <CopyableHash
                  value={request.tx.hash}
                  href={BASESCAN_TX(request.tx.hash)}
                  label="Copy transaction hash"
                  className="text-shelter"
                />
              </span>
            ) : null}
          </div>
        ) : request.decision ? (
          <div className="flex items-center gap-2 rounded-xl border border-border bg-surface/60 px-4 py-3 text-sm text-muted-foreground">
            <Pill className="align-middle">{request.decision.replace("_", " ")}</Pill>
          </div>
        ) : null}

        {decoded ? (
          <dl className="divide-y rounded-xl border bg-background/50 text-sm">
            {decoded.fields.map((f) => (
              <div
                key={f.label}
                className="grid grid-cols-[7.5rem_minmax(0,1fr)] items-center gap-3 px-4 py-2.5"
              >
                <dt className="text-faint">{f.label}</dt>
                <dd className={cn("min-w-0 justify-self-end text-right", f.mono && "font-mono text-[13px]", f.warn && "font-medium text-warn")}>
                  {f.value}
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">{shortenAddresses(request.summary)}</p>
        )}

        {decoded?.warnings.map((w) => (
          <div
            key={w}
            className="flex items-start gap-2 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-sm text-warn"
          >
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            {w}
          </div>
        ))}

        {blockFindings.length || warnFindings.length || otherFindings.length ? (
          <div className="rounded-xl border bg-surface/60 p-4">
            <div className="text-xs font-medium uppercase tracking-wider text-faint">
              Shelter checks
            </div>
            <ul className="mt-3 space-y-2">
              {[...blockFindings, ...warnFindings, ...otherFindings].map((f, i) => (
                <li key={`${f.code}-${i}`} className="flex items-start gap-2 text-sm">
                  <span
                    className={cn(
                      "mt-0.5 inline-block size-4 shrink-0 rounded-full text-center leading-4",
                      f.level === "block"
                        ? "bg-destructive/25 text-destructive"
                        : "bg-warn/20 text-warn",
                    )}
                    aria-hidden
                  >
                    {f.level === "block" ? "✕" : "!"}
                  </span>
                  <span className="min-w-0">
                    <code className="font-mono text-foreground">{f.code}</code>{" "}
                    <span className="text-muted-foreground">{shortenAddresses(f.message)}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {request.tx ? (
          <p className="text-xs text-muted-foreground">
            Signed by the dapp address{" "}
            <CopyableHash
              value={account.address.address}
              href={BASESCAN_ADDRESS(account.address.address)}
              label="Copy dapp address"
            />{" "}
            and mined on Base.{" "}
            <CopyableHash
              value={request.tx.hash}
              href={BASESCAN_TX(request.tx.hash)}
              label="Copy transaction hash"
            />
          </p>
        ) : null}

        {request.method === "eth_sendTransaction" && decoded ? (
          <p className="text-xs text-muted-foreground">
            Gas and value come out of the dapp address&apos;s own balance, funded from the
            confidential balance. This request never touches your other wallets.
          </p>
        ) : null}

        {request.error ? (
          <p className="text-xs text-destructive">{request.error}</p>
        ) : null}

        {isBlocked ? (
          <p className="text-center text-xs leading-relaxed text-faint">
            Reason codes: {codes.join(", ") || "see findings"}. A blocked request cannot be
            approved later; the dapp has to ask for something that stays unlinkable.
          </p>
        ) : null}
      </div>
    </BottomSheet>
  );
}
