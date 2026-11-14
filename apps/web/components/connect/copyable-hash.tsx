"use client";

import { useState } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A shortened hash/address with a copy button and an explorer link — the
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
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="font-mono text-foreground underline underline-offset-2"
          aria-label={`Open ${short} on Basescan`}
        >
          {short}
          <ExternalLink className="ml-0.5 inline h-3 w-3" aria-hidden />
        </a>
      ) : (
        <code className="font-mono text-foreground">{short}</code>
      )}
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
          "inline-flex h-5 w-5 items-center justify-center rounded border border-border text-muted-foreground",
          "transition-colors hover:border-border-strong hover:text-foreground",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        )}
      >
        {copied ? (
          <Check className="h-3 w-3 text-emerald-400" aria-hidden />
        ) : (
          <Copy className="h-3 w-3" aria-hidden />
        )}
      </button>
    </span>
  );
}
