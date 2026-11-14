"use client";

import { useState } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A shortened hash/address with a copy button and an explorer link: the
 * spec for every machine identifier on the Connect screens.
 */
export function CopyableHash({
  value,
  href,
  label,
  className,
}: {
  value: string;
  href?: string;
  /** Accessible name, e.g. "Copy transaction hash". */
  label: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const short = value.length > 14 ? `${value.slice(0, 10)}…${value.slice(-6)}` : value;
  return (
    <span className={cn("inline-flex items-center gap-0.5 whitespace-nowrap rounded-md border bg-surface-2/60 py-px pl-1.5 pr-0.5 align-middle font-mono text-[11px] text-muted-foreground", className)}>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-0.5 text-foreground hover:text-foreground"
          aria-label={`Open ${short} on Basescan`}
        >
          {short}
          <ExternalLink className="size-3" aria-hidden />
        </a>
      ) : (
        <span className="text-foreground">{short}</span>
      )}
      <button
        type="button"
        aria-label={label}
        onClick={async (e) => {
          e.stopPropagation();
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
          setTimeout(() => setCopied(false), 1200);
        }}
        className={cn(
          "inline-grid size-5 shrink-0 place-items-center rounded text-faint",
          "transition-colors hover:bg-accent hover:text-foreground",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        )}
      >
        {copied ? (
          <Check className="size-3 text-shelter" aria-hidden />
        ) : (
          <Copy className="size-3" aria-hidden />
        )}
      </button>
    </span>
  );
}
