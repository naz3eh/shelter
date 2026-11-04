"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createDcapQuoteVerifier,
  DEFAULT_MODEL,
  fetchAttestationReport,
  verifyAttestation,
  verifyResponseSignature,
  type AttestationCheck,
  type SignaturePayload,
  type SignatureVerification,
  type VerificationResult,
} from "@shelter/attest";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/motion/card";
import { AnimatedBadge } from "@/components/motion/animated-badge";
import { StatefulButton } from "@/components/motion/button/stateful";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/motion/collapsible";
import { cn } from "@/lib/utils";

export interface VerifiedPanelProps {
  /** Canonical TEE-hosted model id. Defaults to NEAR_AI_MODEL's default. */
  model?: string;
  /** Response-signature context returned by /api/explain, when verifying an answer. */
  signature?: SignaturePayload | null;
  requestBody?: string;
  responseBody?: string;
  /** Called whenever the overall verified state changes (hide the AI text on false). */
  onVerifiedChange?: (verified: boolean) => void;
  /** The AI answer: rendered only while everything verifies. */
  children?: React.ReactNode;
  className?: string;
}

const short = (value: string | undefined, keep = 8) =>
  value && value.length > keep * 2
    ? `${value.slice(0, keep)}…${value.slice(-keep)}`
    : (value ?? "—");

type Phase = "checking" | "done";

export function VerifiedPanel({
  model = DEFAULT_MODEL,
  signature,
  requestBody,
  responseBody,
  onVerifiedChange,
  children,
  className,
}: VerifiedPanelProps) {
  const [phase, setPhase] = useState<Phase>("checking");
  const [result, setResult] = useState<VerificationResult | null>(null);
  const [sigResult, setSigResult] = useState<SignatureVerification | null>(null);
  const [runId, setRunId] = useState(0);
  const notified = useRef(onVerifiedChange);
  notified.current = onVerifiedChange;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setPhase("checking");
      setResult(null);
      setSigResult(null);
      try {
        const verification = await verifyAttestation({
          model,
          getReport: (m, nonce) =>
            // The proxy only adds the API key; the nonce goes through unchanged
            // and every check below runs here, on the client.
            fetchAttestationReport({
              endpoint: "/api/attestation",
              model: m,
              nonce,
            }),
          quoteVerifier: createDcapQuoteVerifier(),
        });
        if (cancelled) return;
        setResult(verification);

        let sig: SignatureVerification | null = null;
        if (signature) {
          sig = await verifyResponseSignature({
            signature,
            model,
            requestBody,
            responseBody,
            verification,
          });
          if (cancelled) return;
          setSigResult(sig);
        }
        notified.current?.(verification.ok && (sig?.ok ?? !signature));
      } catch (err) {
        if (cancelled) return;
        setResult({
          ok: false,
          checks: [
            {
              name: "verification",
              ok: false,
              detail: err instanceof Error ? err.message : String(err),
            },
          ],
          nonce: "",
          model,
          fetchedAt: new Date().toISOString(),
          verifiedModelSigners: [],
          modelCandidateCount: 0,
        });
        notified.current?.(false);
      } finally {
        if (!cancelled) setPhase("done");
      }
    })();
    return () => {
      cancelled = true;
    };
    // runId bumps on Re-check; signature context re-verifies when it changes.
  }, [model, runId, signature, requestBody, responseBody]);

  const checking = phase === "checking";
  const verified = result?.ok === true && (sigResult?.ok ?? !signature);
  const failed = result !== null && !verified;
  const failing = useMemo(
    () => result?.checks.filter((c) => !c.ok) ?? [],
    [result],
  );
  const checks = useMemo(
    () => [...(result?.checks ?? []), ...(sigResult?.checks ?? [])],
    [result, sigResult],
  );
  const passCount = checks.filter((c) => c.ok).length;

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <Card size="compact" className="bg-card/80">
        <CardHeader>
          <div className="flex items-center gap-2">
            <CardTitle as="h3">TEE attestation</CardTitle>
            <AnimatedBadge
              size="sm"
              status={checking ? "loading" : verified ? "success" : "danger"}
              contentKey={checking ? "checking" : verified ? "ok" : "fail"}
            >
              {checking ? "Checking…" : verified ? "Verified" : "Not verified"}
            </AnimatedBadge>
          </div>
          <CardContent className="mt-1 flex-col items-end p-0">
            <StatefulButton
              size="sm"
              variant="outline"
              state={checking ? "loading" : "idle"}
              loadingText="Checking…"
              disabled={checking}
              onClick={() => setRunId((n) => n + 1)}
            >
              Re-check
            </StatefulButton>
          </CardContent>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-muted-foreground">nonce</dt>
            <dd className="font-mono text-foreground">
              {result ? short(result.nonce, 8) : "generating…"}
            </dd>
            <dt className="text-muted-foreground">model signer</dt>
            <dd className="font-mono text-foreground">
              {result?.signingAddress
                ? short(result.signingAddress, 10)
                : "—"}
            </dd>
            {sigResult?.signer ? (
              <>
                <dt className="text-muted-foreground">answer signer</dt>
                <dd className="font-mono text-foreground">
                  {short(sigResult.signer, 10)}
                </dd>
              </>
            ) : null}
          </dl>

          <Collapsible className="mt-3">
            <CollapsibleTrigger className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground">
              <span>
                {checks.length
                  ? `${passCount}/${checks.length} checks passed — details`
                  : "running checks…"}
              </span>
              <span aria-hidden>{checking ? "…" : "▾"}</span>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <ul className="mt-1 flex flex-col gap-1">
                {checks.map((c) => (
                  <CheckRow key={c.name} check={c} />
                ))}
              </ul>
            </CollapsibleContent>
          </Collapsible>
        </CardContent>
      </Card>

      {children !== undefined ? (
        verified ? (
          children
        ) : failed ? (
          <div
            role="alert"
            className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-foreground"
          >
            AI answer hidden — attestation failed
            {failing.length ? `: ${failing.map((c) => c.name).join(", ")}` : ""}.
          </div>
        ) : null
      ) : null}
    </div>
  );
}

function CheckRow({ check }: { check: AttestationCheck }) {
  return (
    <li className="flex items-start gap-2 rounded-md px-2 py-1 text-xs">
      <span
        className={cn(
          "mt-0.5 inline-block h-3.5 w-3.5 shrink-0 rounded-full text-center leading-3.5",
          check.ok
            ? "bg-emerald-500/15 text-emerald-400"
            : "bg-destructive/20 text-destructive",
        )}
        aria-hidden
      >
        {check.ok ? "✓" : "✕"}
      </span>
      <span className="min-w-0">
        <span className="font-mono text-foreground">{check.name}</span>{" "}
        <span className="text-muted-foreground">{check.detail}</span>
      </span>
    </li>
  );
}
