"use client";

import {
  AlertTriangle,
  Check,
  Circle,
  Loader2,
  MinusCircle,
  RotateCcw,
  Undo2,
  X,
} from "lucide-react";
import type { SimStep, StepStatus } from "@/lib/flow/types";
import { cn } from "@/lib/utils";

const STATUS_META: Record<
  StepStatus,
  { icon: React.ReactNode; label: string; className: string }
> = {
  pending: {
    icon: <Circle className="h-4 w-4" />,
    label: "pending",
    className: "text-muted-foreground",
  },
  active: {
    icon: <Loader2 className="h-4 w-4 animate-spin" />,
    label: "running",
    className: "text-sky-400",
  },
  completed: {
    icon: <Check className="h-4 w-4" />,
    label: "completed",
    className: "text-emerald-400",
  },
  failed: {
    icon: <X className="h-4 w-4" />,
    label: "failed",
    className: "text-red-400",
  },
  refunded: {
    icon: <Undo2 className="h-4 w-4" />,
    label: "refunded",
    className: "text-amber-400",
  },
  skipped: {
    icon: <MinusCircle className="h-4 w-4" />,
    label: "skipped",
    className: "text-muted-foreground",
  },
  cancelled: {
    icon: <AlertTriangle className="h-4 w-4" />,
    label: "cancelled",
    className: "text-amber-400",
  },
};

/** Vertical timeline of simulated steps with text labels for every status. */
export function StepTracker({
  steps,
  live = false,
}: {
  steps: SimStep[];
  live?: boolean;
}) {
  return (
    <ol className="relative flex flex-col" aria-live={live ? "polite" : undefined}>
      {steps.map((step, i) => {
        const meta = STATUS_META[step.status];
        const last = i === steps.length - 1;
        return (
          <li key={step.id} className="relative flex gap-3 pb-4 last:pb-0">
            {!last ? (
              <span
                className="absolute left-[7px] top-5 h-full w-px bg-border"
                aria-hidden
              />
            ) : null}
            <span
              className={cn(
                "relative z-10 mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center",
                meta.className,
              )}
            >
              {meta.icon}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={cn(
                    "text-sm font-medium",
                    step.status === "pending" || step.status === "cancelled"
                      ? "text-muted-foreground"
                      : "text-foreground",
                  )}
                >
                  {step.title}
                </span>
                <span
                  className={cn(
                    "rounded-full border px-1.5 py-px text-[10px] font-medium uppercase tracking-wide",
                    step.status === "completed" &&
                      "border-emerald-500/40 bg-emerald-500/10 text-emerald-400",
                    step.status === "failed" &&
                      "border-red-500/40 bg-red-500/10 text-red-400",
                    (step.status === "refunded" || step.status === "cancelled") &&
                      "border-amber-500/40 bg-amber-500/10 text-amber-400",
                    step.status === "active" &&
                      "border-sky-500/40 bg-sky-500/10 text-sky-400",
                    (step.status === "pending" || step.status === "skipped") &&
                      "border-border bg-muted/40 text-muted-foreground",
                  )}
                >
                  {meta.label}
                </span>
                {step.asset && step.amount ? (
                  <span className="text-xs text-muted-foreground">
                    {step.amount} {step.asset}
                  </span>
                ) : null}
              </div>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                {step.description}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function RestartIcon() {
  return <RotateCcw className="h-3.5 w-3.5" aria-hidden />;
}
