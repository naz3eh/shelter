import Link from "next/link";
import { ArrowLeft, ScanSearch } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/motion/card";
import { ButtonLink } from "@/components/motion/button/base";

/**
 * Shown when a downstream route is opened with no flow state — a useful
 * recovery state, never an exception or a fabricated completed run.
 */
export function RecoveryCard({
  title,
  children,
  backHref = "/",
  backLabel = "Back to setup",
}: {
  title: string;
  children: React.ReactNode;
  backHref?: string;
  backLabel?: string;
}) {
  return (
    <Card className="mx-auto max-w-xl">
      <CardHeader>
        <CardTitle as="h2" className="flex items-center gap-2">
          <ScanSearch className="h-4 w-4 text-muted-foreground" aria-hidden />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="text-sm text-muted-foreground">{children}</div>
        <div className="flex flex-wrap gap-2">
          <ButtonLink href={backHref} variant="primary" size="sm">
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> {backLabel}
          </ButtonLink>
          <ButtonLink href="/scan" variant="outline" size="sm">
            Go to scan
          </ButtonLink>
        </div>
        <p className="text-xs text-muted-foreground">
          Flow state lives only in this browser session — reloading the page
          resets the demo.
        </p>
      </CardContent>
    </Card>
  );
}
