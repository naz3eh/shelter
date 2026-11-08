import type { ExposureBand } from "@shelter/core";
import { BAND_META } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Band label — always text plus color, never color alone (WCAG).
 */
export function BandBadge({
  band,
  className,
}: {
  band: ExposureBand;
  className?: string;
}) {
  const meta = BAND_META[band];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium",
        meta.className,
        className,
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", meta.dot)} aria-hidden />
      {meta.label}
    </span>
  );
}
