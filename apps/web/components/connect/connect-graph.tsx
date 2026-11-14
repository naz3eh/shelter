"use client";

/**
 * Before/after link diagrams for the recorded Connect session: the "Today"
 * graph (wallets linked, dapp sees the main wallet) next to the "After
 * Connect" graph (the dapp address stands alone). Fed by
 * lib/connect-graph-data.ts; the dapp node shows the session's real address.
 */

import type { ReactNode } from "react";
import type { ConnectAccountView } from "@/lib/connect-source";
import { DIAGRAMS } from "@/lib/connect-graph-data";
import { AfterDiagram, TodayDiagram } from "./diagrams";
import { Reveal, SectionTitle, truncMid } from "./primitives";
import { cn } from "@/lib/utils";

function Figure({
  title,
  caption,
  children,
  tone,
}: {
  title: string;
  caption: string;
  children: ReactNode;
  tone: "ok" | "danger";
}) {
  return (
    <figure className="panel flex flex-col p-5">
      <div className="flex items-center gap-2">
        <span className={cn("size-1.5 rounded-full", tone === "ok" ? "bg-shelter" : "bg-destructive")} />
        <span className="text-sm font-medium">{title}</span>
      </div>
      <div className="my-5 flex-1">{children}</div>
      <figcaption className="border-t pt-4 text-sm leading-relaxed text-muted-foreground">
        {caption}
      </figcaption>
    </figure>
  );
}

export function ConnectGraph({ view }: { view: ConnectAccountView }) {
  const dappAddress = truncMid(view.account.address.address);
  const [today, after] = DIAGRAMS;
  return (
    <Reveal>
      <SectionTitle title="Before and after" />
      <div className="grid gap-4 md:grid-cols-2">
        <Figure title={today!.title} tone="danger" caption={today!.caption}>
          <TodayDiagram />
        </Figure>
        <Figure title={after!.title} tone="ok" caption={after!.caption}>
          <AfterDiagram dappAddress={dappAddress} />
        </Figure>
      </div>
      <div className="mt-3 flex flex-wrap gap-4 text-xs text-faint">
        <span className="inline-flex items-center gap-2">
          <span className="h-px w-6 bg-muted-foreground" />
          allowed
        </span>
        <span className="inline-flex items-center gap-2">
          <span className="w-6 border-t border-dashed border-destructive" />
          blocked or no private path
        </span>
      </div>
    </Reveal>
  );
}
