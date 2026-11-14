"use client";

import { Play } from "lucide-react";

/** Scrolls to the demo and opens the recorded blocked request's approval sheet. */
export function TryItButton({ className }: { className?: string }) {
  return (
    <button
      type="button"
      onClick={() => {
        document.getElementById("connect-demo")?.scrollIntoView({ behavior: "smooth", block: "start" });
        window.dispatchEvent(new CustomEvent("shelter:try-it"));
      }}
      className={
        className ??
        "inline-flex items-center gap-2 rounded-xl bg-foreground px-5 py-3 text-sm font-semibold text-background transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      }
    >
      <Play className="h-4 w-4" aria-hidden />
      Try it
    </button>
  );
}
