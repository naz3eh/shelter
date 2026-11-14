"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
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
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/motion/collapsible";
import { Btn, Pill } from "@/components/connect/primitives";
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
    : (value ?? "-");

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
    <div className={cn("panel p-5", className)}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <h3 className="font-medium">TEE attestation</h3>
          <Pill tone={checking ? "neutral" : verified ? "ok" : "danger"}>
            {checking ? "Checking…" : verified ? "Verified" : "Not verified"}
          </Pill>
        </div>
        <Btn
          className="h-8 text-xs"
          onClick={() => setRunId((n) => n + 1)}
          disabled={checking}
        >
          <RefreshCw className={cn("size-3.5", checking && "animate-spin")} aria-hidden />
          Re-check
        </Btn>
      </div>
      <dl className="mt-4 divide-y rounded-lg border bg-background/40 text-sm">
        <div className="grid grid-cols-[120px_minmax(0,1fr)] items-center gap-3 px-4 py-2.5">
          <dt className="text-faint">nonce</dt>
          <dd className="font-mono text-xs text-foreground">
            {result ? short(result.nonce, 8) : "generating…"}
          </dd>
        </div>
        <div className="grid grid-cols-[120px_minmax(0,1fr)] items-center gap-3 px-4 py-2.5">
          <dt className="text-faint">model signer</dt>
          <dd className="font-mono text-xs text-muted-foreground">
            {result?.signingAddress ? short(result.signingAddress, 10) : "-"}
          </dd>
        </div>
        {sigResult?.signer ? (
          <div className="grid grid-cols-[120px_minmax(0,1fr)] items-center gap-3 px-4 py-2.5">
            <dt className="text-faint">answer signer</dt>
            <dd className="font-mono text-xs text-foreground">
              {short(sigResult.signer, 10)}
            </dd>
          </div>
        ) : null}
      </dl>

      <Collapsible className="group mt-3 text-xs text-muted-foreground">
        <CollapsibleTrigger className="flex w-full cursor-pointer list-none items-center gap-1.5 rounded-md px-1 py-1 text-left hover:text-foreground [&::-webkit-details-marker]:hidden">
          <svg
            className="size-3.5 transition-transform group-data-[state=open]:rotate-90"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden
          >
            <path d="m9 18 6-6-6-6" />
          </svg>
          <span>
            {checks.length
              ? `${passCount}/${checks.length} checks passed, details`
              : "running checks…"}
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ul className="mt-1 flex flex-col gap-1 px-1 pb-1">
            {checks.map((c) => (
              <CheckRow key={c.name} check={c} />
            ))}
          </ul>
        </CollapsibleContent>
      </Collapsible>

      {children !== undefined ? (
        verified ? (
          children
        ) : failed ? (
          <div
            role="alert"
            className="mt-3 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-foreground"
          >
            AI answer hidden, attestation failed
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
            ? "bg-shelter/15 text-shelter"
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
