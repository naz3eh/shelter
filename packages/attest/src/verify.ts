/**
 * verifyAttestation: fetch a NEAR AI Cloud attestation report with a fresh
 * client nonce and verify the gateway and every model candidate, per
 * docs.near.ai "Gateway Attestation" and "NEAR Model Attestations".
 *
 * Network and Intel-quote verification are injected so the same code runs in
 * the browser (via the /api/attestation proxy), in the CLI (direct, with the
 * API key), and in tests (recorded fixtures).
 */

import { fromHex, toHex } from "./bytes";
import {
  checkNearReport,
  errMessage,
  type AttestationCheck,
  type NearReport,
  type QuoteVerifier,
} from "./report";

export const NEAR_AI_CLOUD_BASE = "https://cloud-api.near.ai";
export const ATTESTATION_PATH = "/v1/attestation/report";
/** TEE-hosted model on NEAR's own vLLM fleet (provider=near). */
export const DEFAULT_MODEL = "z-ai/glm-5.3-flash";

/** 32 random bytes as 64 lowercase hex chars (crypto.getRandomValues). */
export function generateNonce(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return toHex(bytes);
}

export interface AttestationResponse {
  gateway_attestation?: NearReport;
  model_attestations?: NearReport[];
  [key: string]: unknown;
}

/**
 * GET {endpoint}?model&provider=near&signing_algo=ecdsa&
 * include_tls_fingerprint=false&nonce — the documented report request.
 * `endpoint` is the full URL; the web proxy exposes the same path locally.
 */
export async function fetchAttestationReport(options: {
  endpoint?: string;
  model: string;
  nonce: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}): Promise<AttestationResponse> {
  const {
    endpoint = `${NEAR_AI_CLOUD_BASE}${ATTESTATION_PATH}`,
    model,
    nonce,
    apiKey,
    fetchImpl = fetch,
  } = options;
  const url = `${endpoint}?${new URLSearchParams({
    model,
    provider: "near",
    signing_algo: "ecdsa",
    include_tls_fingerprint: "false",
    nonce,
  })}`;
  const headers: Record<string, string> = {
    Accept: "application/json",
    "x-no-aliasing": "true",
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await fetchImpl(url, { headers });
  if (!res.ok) {
    throw new Error(`attestation request failed: HTTP ${res.status}`);
  }
  return (await res.json()) as AttestationResponse;
}

export type ReportFetcher = (
  model: string,
  nonce: string,
) => Promise<AttestationResponse>;

/**
 * The real quote verifier: @phala/dcap-qvl (pure-JS DCAP). Collateral comes
 * from Phala PCCS by default (CORS-enabled, so this also works in browsers);
 * pass INTEL_PCS_URL to use Intel's service instead. Imported lazily so test
 * and redaction users never pay for it.
 */
export function createDcapQuoteVerifier(options?: {
  pccsUrl?: string;
}): QuoteVerifier {
  return async (intelQuoteHex) => {
    const { getCollateralAndVerify } = await import("@phala/dcap-qvl");
    const verified = await getCollateralAndVerify(
      fromHex(intelQuoteHex),
      options?.pccsUrl,
    );
    const td10 = verified.report.asTd10();
    if (!td10) {
      throw new Error(`expected a TDX (td10) quote, got ${verified.report.type}`);
    }
    return {
      status: String(verified.status),
      advisoryIds: verified.advisory_ids ?? [],
      tdAttributes: td10.tdAttributes,
      reportData: td10.reportData,
      mrConfigId: td10.mrConfigId,
      rtMr3: td10.rtMr3,
    };
  };
}

export interface VerifiedSigner {
  signingAddress: string;
  signingAlgo: string;
}

export interface VerificationResult {
  ok: boolean;
  checks: AttestationCheck[];
  /** First fully-verified model report's signer, when one exists. */
  signingAddress?: string;
  signingAlgo?: string;
  nonce: string;
  model: string;
  fetchedAt: string;
  /** Gateway report signer (needed to match `gateway` response signatures). */
  gateway?: VerifiedSigner;
  /** Model reports that passed every check (for `provider_tee` matching). */
  verifiedModelSigners: VerifiedSigner[];
  /** Total model_attestations candidates seen, verified or not. */
  modelCandidateCount: number;
}

export interface VerifyAttestationOptions {
  model: string;
  /** Injected for tests/replays; a fresh one is generated otherwise. */
  nonce?: string;
  /** Fetches the raw report for (model, nonce). */
  getReport: ReportFetcher;
  /** Injected for tests; defaults to the real DCAP verifier. */
  quoteVerifier?: QuoteVerifier;
  acceptedTcbStatuses?: string[];
}

export async function verifyAttestation(
  options: VerifyAttestationOptions,
): Promise<VerificationResult> {
  const nonce = options.nonce ?? generateNonce();
  const quoteVerifier = options.quoteVerifier ?? createDcapQuoteVerifier();
  const fetchedAt = new Date().toISOString();
  const checks: AttestationCheck[] = [];

  let body: AttestationResponse;
  try {
    body = await options.getReport(options.model, nonce);
    checks.push({ name: "report-fetch", ok: true, detail: "report fetched" });
  } catch (err) {
    checks.push({
      name: "report-fetch",
      ok: false,
      detail: errMessage(err),
    });
    return {
      ok: false,
      checks,
      nonce,
      model: options.model,
      fetchedAt,
      verifiedModelSigners: [],
      modelCandidateCount: 0,
    };
  }

  const gateway = body.gateway_attestation;
  if (!gateway) {
    checks.push({
      name: "gateway:present",
      ok: false,
      detail: "gateway_attestation missing from the report",
    });
  } else {
    const gatewayChecks = await checkNearReport(
      gateway,
      nonce,
      quoteVerifier,
      options,
    );
    for (const c of gatewayChecks) {
      checks.push({ ...c, name: `gateway:${c.name}` });
    }
  }

  const candidates = body.model_attestations ?? [];
  checks.push({
    name: "model-attestations-present",
    ok: candidates.length > 0,
    detail:
      candidates.length > 0
        ? `${candidates.length} model report candidate(s) returned`
        : "model_attestations missing or empty — no NEAR model evidence",
  });

  const verifiedModelSigners: VerifiedSigner[] = [];
  for (const [i, candidate] of candidates.entries()) {
    const candidateChecks = await checkNearReport(
      candidate,
      nonce,
      quoteVerifier,
      options,
    );
    for (const c of candidateChecks) {
      checks.push({ ...c, name: `model[${i}]:${c.name}` });
    }
    if (
      candidateChecks.every((c) => c.ok) &&
      candidate.signing_address &&
      candidate.signing_algo
    ) {
      verifiedModelSigners.push({
        signingAddress: candidate.signing_address,
        signingAlgo: candidate.signing_algo,
      });
    }
  }

  const gatewayVerified =
    gateway !== undefined &&
    checks
      .filter((c) => c.name.startsWith("gateway:"))
      .every((c) => c.ok);

  const first = verifiedModelSigners[0];
  return {
    ok: checks.every((c) => c.ok),
    checks,
    signingAddress: first?.signingAddress,
    signingAlgo: first?.signingAlgo,
    nonce,
    model: options.model,
    fetchedAt,
    gateway:
      gatewayVerified && gateway?.signing_address && gateway.signing_algo
        ? {
            signingAddress: gateway.signing_address,
            signingAlgo: gateway.signing_algo,
          }
        : undefined,
    verifiedModelSigners,
    modelCandidateCount: candidates.length,
  };
}
