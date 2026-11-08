/**
 * Client for the G7 explainer route. The browser sends an already-redacted
 * scan (aliases only, no addresses or tx hashes — enforced again server-side)
 * to /api/explain and receives the model text plus the response signature
 * and exact request/response bytes. Display stays fail-closed: the answer
 * renders only inside VerifiedPanel after attestation AND the answer's
 * signature binding both pass.
 */

import { redactScanReport, type SignaturePayload } from "@shelter/attest";
import type { ScanReport } from "@shelter/core";

export interface ExplainAnswer {
  /** Raw model text (JSON per the prompt contract). */
  content: string;
  completionId?: string;
  model?: string;
  signature: SignaturePayload | null;
  requestBody?: string;
  responseBody?: string;
  /** alias -> original address, client-side only, for unredactText. */
  aliases: Record<string, string>;
}

export type ExplainOutcome =
  | { kind: "answered"; answer: ExplainAnswer }
  | { kind: "unavailable"; message: string }
  | { kind: "error"; message: string };

interface ExplainResponseBody {
  model?: string;
  completionId?: string;
  content?: string;
  signature?: SignaturePayload | null;
  requestBody?: string;
  responseBody?: string;
  error?: string;
}

const KEY_MISSING = /NEAR_AI_API_KEY/;

/**
 * Request an explanation for a scan report. `fetchImpl` is injectable for
 * tests; production always uses the same-origin /api/explain route.
 */
export async function requestExplanation(
  report: ScanReport,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<ExplainOutcome> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const { redacted, aliases } = redactScanReport(report);

  let res: Response;
  try {
    res = await fetchImpl("/api/explain", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(redacted),
    });
  } catch (err) {
    return {
      kind: "error",
      message: `Could not reach the explainer: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let body: ExplainResponseBody = {};
  try {
    body = (await res.json()) as ExplainResponseBody;
  } catch {
    body = {};
  }

  if (!res.ok) {
    const detail = body.error ?? `HTTP ${res.status}`;
    if (res.status === 500 && KEY_MISSING.test(detail)) {
      return {
        kind: "unavailable",
        message:
          "The AI explainer is not configured on this server (NEAR_AI_API_KEY missing). Scanning and the simulated flow are unaffected.",
      };
    }
    return { kind: "error", message: `Explainer request failed: ${detail}` };
  }

  if (typeof body.content !== "string" || body.content.length === 0) {
    return { kind: "error", message: "Explainer returned an empty answer." };
  }

  return {
    kind: "answered",
    answer: {
      content: body.content,
      completionId: body.completionId,
      model: body.model,
      signature: body.signature ?? null,
      requestBody: body.requestBody,
      responseBody: body.responseBody,
      aliases,
    },
  };
}

export interface ParsedExplanation {
  summary?: string;
  findings?: { check?: string; wallet?: string; explanation?: string }[];
}

/** Best-effort parse of the JSON the model was asked to return. */
export function parseExplanation(content: string): ParsedExplanation | null {
  try {
    const trimmed = content.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
    const parsed = JSON.parse(trimmed) as ParsedExplanation;
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed;
  } catch {
    return null;
  }
}
