/**
 * NEAR AI Cloud response signatures. After a completion, /v1/signature/{id}
 * returns who signed it (signature_kind: "provider_tee" = the model TEE,
 * "gateway" = the gateway TEE), the signed `text` and the ECDSA `signature`.
 *
 * text binds the exact bytes: "<model>:<sha256(request)>:<sha256(response)>"
 * for provider_tee, "<sha256(request)>:<sha256(response)>" for gateway. We
 * recover the EIP-191 signer and require it to match exactly one retained
 * verified report — see docs.near.ai "Response Signatures".
 */

import { recoverMessageAddress } from "viem";
import { sha256Hex, utf8 } from "./bytes";
import { errMessage, type AttestationCheck } from "./report";
import { NEAR_AI_CLOUD_BASE, type VerificationResult } from "./verify";

export interface SignaturePayload {
  signature_kind?: string;
  text?: string;
  signature?: string;
  signing_algo?: string;
  [key: string]: unknown;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * GET /v1/signature/{completionId}. Retries a bounded number of times on 404,
 * since the signature can take a moment to be recorded.
 */
export async function fetchResponseSignature(options: {
  completionId: string;
  model?: string;
  apiKey?: string;
  endpoint?: string;
  signingAlgo?: "ecdsa" | "ed25519";
  retries?: number;
  retryDelayMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<SignaturePayload> {
  const {
    completionId,
    model,
    apiKey,
    endpoint,
    signingAlgo = "ecdsa",
    retries = 2,
    retryDelayMs = 1500,
    fetchImpl = fetch,
  } = options;
  const base =
    endpoint ?? `${NEAR_AI_CLOUD_BASE}/v1/signature/${completionId}`;
  const params = new URLSearchParams({ signing_algo: signingAlgo });
  if (model) params.set("model", model);
  const url = `${base}?${params}`;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  let lastError = "signature unavailable";
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetchImpl(url, { headers });
    if (res.ok) {
      const body = (await res.json()) as SignaturePayload;
      // A 2xx body with error_code/message is an unavailable result, not a
      // signature — treat it like the 404 path and keep retrying briefly.
      if (typeof body.signature === "string" && typeof body.text === "string") {
        return body;
      }
      lastError =
        typeof body.message === "string"
          ? body.message
          : "signature payload incomplete";
    } else {
      lastError = `signature request failed: HTTP ${res.status}`;
    }
    if (attempt < retries) await sleep(retryDelayMs);
  }
  throw new Error(lastError);
}

export interface SignatureVerification {
  ok: boolean;
  checks: AttestationCheck[];
  /** Recovered signer address (0x...), when recovery succeeded. */
  signer?: string;
  signatureKind?: string;
}

export interface VerifySignatureOptions {
  signature: SignaturePayload;
  /** Canonical model id sent in the original completion request. */
  model: string;
  /** Exact request-body bytes sent (hash-checks the signature's binding). */
  requestBody?: string;
  /** Exact response-body bytes received. */
  responseBody?: string;
  /** Result of verifyAttestation run BEFORE the completion. */
  verification: VerificationResult;
}

export async function verifyResponseSignature(
  options: VerifySignatureOptions,
): Promise<SignatureVerification> {
  const { signature, model, requestBody, responseBody, verification } = options;
  const checks: AttestationCheck[] = [];

  const kind = signature.signature_kind;
  if (kind === "provider_tee" || kind === "gateway") {
    checks.push({
      name: "signature-kind",
      ok: true,
      detail: `signed by ${kind === "provider_tee" ? "the model TEE" : "the gateway TEE"}`,
    });
  } else {
    checks.push({
      name: "signature-kind",
      ok: false,
      detail: `signature_kind ${kind ?? "missing"} — signer class unavailable`,
    });
  }

  const text = signature.text ?? "";
  const parts = text.split(":");
  const expectedParts = kind === "provider_tee" ? 3 : kind === "gateway" ? 2 : -1;
  const structureOk =
    expectedParts > 0 &&
    parts.length === expectedParts &&
    parts.slice(-2).every((p) => /^[0-9a-f]{64}$/i.test(p)) &&
    (kind !== "provider_tee" || parts[0] === model);
  checks.push(
    structureOk
      ? {
          name: "signature-text",
          ok: true,
          detail: "signed text binds model + request/response hashes",
        }
      : {
          name: "signature-text",
          ok: false,
          detail: `unexpected signed text shape for kind ${kind}`,
        },
  );

  if (requestBody !== undefined && parts.length >= 2) {
    const expected = await sha256Hex(utf8(requestBody));
    const actual = parts[parts.length - 2] ?? "";
    checks.push(
      actual.toLowerCase() === expected
        ? {
            name: "request-hash-bound",
            ok: true,
            detail: "request hash in signed text matches sent bytes",
          }
        : {
            name: "request-hash-bound",
            ok: false,
            detail: "signed request hash != hash of the bytes sent",
          },
    );
  } else if (parts.length >= 2) {
    checks.push({
      name: "request-hash-bound",
      ok: false,
      detail: "exact request bytes not supplied — cannot check binding",
    });
  }

  if (responseBody !== undefined && parts.length >= 1) {
    const expected = await sha256Hex(utf8(responseBody));
    const actual = parts[parts.length - 1] ?? "";
    checks.push(
      actual.toLowerCase() === expected
        ? {
            name: "response-hash-bound",
            ok: true,
            detail: "response hash in signed text matches received bytes",
          }
        : {
            name: "response-hash-bound",
            ok: false,
            detail: "signed response hash != hash of the bytes received",
          },
    );
  } else if (parts.length >= 1) {
    checks.push({
      name: "response-hash-bound",
      ok: false,
      detail: "exact response bytes not supplied — cannot check binding",
    });
  }

  let signer: string | undefined;
  const algo = signature.signing_algo ?? "ecdsa";
  if (algo !== "ecdsa") {
    checks.push({
      name: "signature-recovered",
      ok: false,
      detail: `unsupported signing_algo ${algo}`,
    });
  } else if (!signature.signature || !text) {
    checks.push({
      name: "signature-recovered",
      ok: false,
      detail: "signature or signed text missing",
    });
  } else {
    try {
      signer = await recoverMessageAddress({
        message: text,
        signature: signature.signature as `0x${string}`,
      });
      checks.push({
        name: "signature-recovered",
        ok: true,
        detail: `ECDSA (EIP-191) signature recovers signer ${signer}`,
      });
    } catch (err) {
      checks.push({
        name: "signature-recovered",
        ok: false,
        detail: `signature recovery failed: ${errMessage(err)}`,
      });
    }
  }

  if (signer) {
    if (kind === "provider_tee") {
      const matches = verification.verifiedModelSigners.filter(
        (s) =>
          s.signingAddress.toLowerCase() === signer!.toLowerCase() &&
          s.signingAlgo === "ecdsa",
      );
      checks.push(
        matches.length === 1
          ? {
              name: "signer-matches-attestation",
              ok: true,
              detail: "signer matches exactly one verified model report",
            }
          : {
              name: "signer-matches-attestation",
              ok: false,
              detail:
                matches.length === 0
                  ? "signer matches no verified model report"
                  : `signer matches ${matches.length} verified reports — ambiguous`,
            },
      );
    } else if (kind === "gateway") {
      const gateway = verification.gateway;
      const match =
        gateway !== undefined &&
        gateway.signingAddress.toLowerCase() === signer.toLowerCase() &&
        gateway.signingAlgo === "ecdsa";
      checks.push(
        match
          ? {
              name: "signer-matches-attestation",
              ok: true,
              detail: "signer matches the verified gateway report",
            }
          : {
              name: "signer-matches-attestation",
              ok: false,
              detail: gateway
                ? "signer differs from the verified gateway signer"
                : "no verified gateway report to match against",
            },
      );
    } else {
      checks.push({
        name: "signer-matches-attestation",
        ok: false,
        detail: "no signature_kind — cannot select the required signer",
      });
    }
  }

  return {
    ok: checks.every((c) => c.ok),
    checks,
    signer,
    signatureKind: kind,
  };
}
