"use client";

import { useEffect, useRef, useState } from "react";
import type { ScanReport } from "@shelter/core";
import { unredactText } from "@shelter/attest";
import {
  requestExplanation,
  parseExplanation,
  type ExplainAnswer,
  type ExplainOutcome,
} from "@/lib/explain-client";
import { VerifiedPanel } from "@/components/verified-panel";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/motion/card";
import { StatefulButton } from "@/components/motion/button/stateful";
import { AnimatedBadge } from "@/components/motion/animated-badge";

type Phase = "idle" | "loading" | "done" | "unavailable" | "error";

/**
 * "Explain with NEAR AI" — an explicit user action. Nothing is sent until
 * the button is clicked; the report is redacted to aliases first. The answer
 * is shown only inside VerifiedPanel after attestation AND the answer's
 * response-signature binding both pass. A missing signature means the answer
 * stays hidden — attestation alone cannot authorize display.
 */
export function ExplainCard({ report }: { report: ScanReport }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [outcome, setOutcome] = useState<ExplainOutcome | null>(null);
  const [answer, setAnswer] = useState<ExplainAnswer | null>(null);
  const seq = useRef(0);

  // A different report invalidates any in-flight or shown explanation.
  useEffect(() => {
    seq.current += 1;
    setPhase("idle");
    setOutcome(null);
    setAnswer(null);
  }, [report]);

  const explain = async () => {
    const my = ++seq.current;
    setPhase("loading");
    setOutcome(null);
    setAnswer(null); // a pending re-check/new answer hides the prior one
    const result = await requestExplanation(report);
    if (my !== seq.current) return; // stale response — a newer request owns the slot
    setOutcome(result);
    if (result.kind === "answered") {
      setAnswer(result.answer);
      setPhase("done");
    } else {
      setPhase(result.kind);
    }
  };

  const parsed = answer ? parseExplanation(answer.content) : null;

  return (
    <Card size="compact">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle as="h3">Explain with NEAR AI</CardTitle>
          <AnimatedBadge size="sm" status="info">
            TEE model · verified on device
          </AnimatedBadge>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">
          On request only, a <strong>redacted</strong> version of these findings
          — check letters, points, labels and aliases like “Wallet 1”, with no
          addresses or transaction hashes — is sent to a NEAR AI Cloud model
          running in a TEE. The answer is shown only after the attestation and
          the response signature both verify on this device. The API key stays
          server-side and never reaches the browser.
        </p>

        {phase === "idle" || phase === "loading" ? (
          <div>
            <StatefulButton
              state={phase === "loading" ? "loading" : "idle"}
              loadingText="Requesting explanation…"
              onClick={() => void explain()}
            >
              Explain this scan
            </StatefulButton>
          </div>
        ) : null}

        {phase === "unavailable" ? (
          <div
            role="status"
            className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-foreground"
          >
            {outcome?.kind === "unavailable" ? outcome.message : "Unavailable."}{" "}
            <StatefulButton
              size="sm"
              variant="outline"
              className="ml-2"
              onClick={() => void explain()}
            >
              Retry
            </StatefulButton>
          </div>
        ) : null}

        {phase === "error" ? (
          <div
            role="alert"
            className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
          >
            {outcome?.kind === "error" ? outcome.message : "Request failed."}{" "}
            <StatefulButton
              size="sm"
              variant="outline"
              className="ml-2"
              onClick={() => void explain()}
            >
              Retry
            </StatefulButton>
          </div>
        ) : null}

        {phase === "done" && answer ? (
          answer.signature ? (
            <VerifiedPanel
              key={answer.completionId ?? answer.content.slice(0, 24)}
              signature={answer.signature}
              requestBody={answer.requestBody}
              responseBody={answer.responseBody}
            >
              <ExplanationBody parsed={parsed} raw={answer.content} aliases={answer.aliases} />
            </VerifiedPanel>
          ) : (
            <div
              role="alert"
              className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm"
            >
              The model answered but returned no response signature, so the
              answer cannot be bound to a verified report — it stays hidden.
              <StatefulButton
                size="sm"
                variant="outline"
                className="ml-2"
                onClick={() => void explain()}
              >
                Try again
              </StatefulButton>
            </div>
          )
        ) : null}
      </CardContent>
    </Card>
  );
}

function ExplanationBody({
  parsed,
  raw,
  aliases,
}: {
  parsed: ReturnType<typeof parseExplanation>;
  raw: string;
  aliases: Record<string, string>;
}) {
  const text = (s: string) => unredactText(s, aliases);
  return (
    <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm">
      {parsed?.summary ? (
        <p className="text-foreground">{text(parsed.summary)}</p>
      ) : null}
      {parsed?.findings?.length ? (
        <ul className="mt-2 flex flex-col gap-1.5">
          {parsed.findings.map((f, i) => (
            <li key={i} className="text-foreground/90">
              <span className="font-medium">
                {f.check ? `[${f.check}] ` : ""}
                {f.wallet ? `${f.wallet}: ` : ""}
              </span>
              {f.explanation ? text(f.explanation) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {!parsed ? (
        <p className="whitespace-pre-wrap text-foreground/90">{text(raw)}</p>
      ) : null}
    </div>
  );
}
