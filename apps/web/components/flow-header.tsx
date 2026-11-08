"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { useFlow } from "@/lib/flow/store";

const STEPS = [
  { href: "/", label: "Setup" },
  { href: "/scan", label: "Scan" },
  { href: "/plan", label: "Plan" },
  { href: "/move", label: "Move" },
  { href: "/burner", label: "Burner" },
  { href: "/rescan", label: "Re-scan" },
] as const;

/**
 * Compact shared header: wordmark, honest demo badge, and the six-step flow
 * with per-step status derived from the in-memory flow state.
 */
export function FlowHeader() {
  const { state } = useFlow();
  const pathname = usePathname();

  const stepDone = (href: string): boolean => {
    switch (href) {
      case "/scan":
        return state.scan.status === "done";
      case "/plan":
        return state.planApproval !== null;
      case "/move":
        return state.moveSim?.status === "done";
      case "/burner":
        return (
          state.burnerSim?.status === "done" &&
          state.burnerSim.steps.find((s) => s.id === "action")?.status ===
            "completed"
        );
      case "/rescan":
        return state.rescan.status === "done";
      default:
        return state.profileId !== null;
    }
  };

  const currentIndex = STEPS.findIndex((s) => s.href === pathname);

  return (
    <header className="border-b border-border bg-background/90">
      <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-3 sm:px-6">
        <div className="flex items-center justify-between gap-3">
          <Link href="/" className="flex items-center gap-2">
            <span className="text-base font-semibold tracking-tight">
              Shelter
            </span>
            <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-400">
              sample data · simulated
            </span>
          </Link>
          <p className="hidden text-xs text-muted-foreground sm:block">
            No wallet, keys or funds — fictional recorded histories only.
          </p>
        </div>
        <nav aria-label="Flow steps">
          <ol className="flex flex-wrap items-center gap-x-1 gap-y-1">
            {STEPS.map((step, i) => {
              const done = stepDone(step.href);
              const current = i === currentIndex;
              return (
                <li key={step.href} className="flex items-center">
                  {i > 0 ? (
                    <span
                      className="mx-1 h-px w-3 bg-border sm:w-5"
                      aria-hidden
                    />
                  ) : null}
                  <Link
                    href={step.href}
                    aria-current={current ? "step" : undefined}
                    className={cn(
                      "rounded-full px-2.5 py-1 text-xs transition-colors",
                      current
                        ? "bg-muted font-medium text-foreground"
                        : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                    )}
                  >
                    <span className="mr-1 inline-flex items-center gap-1">
                      {done ? (
                        <span className="text-emerald-400" aria-hidden>
                          ✓
                        </span>
                      ) : null}
                      {i + 1}.
                    </span>
                    {step.label}
                    {done ? <span className="sr-only"> (done)</span> : null}
                  </Link>
                </li>
              );
            })}
          </ol>
        </nav>
      </div>
    </header>
  );
}
