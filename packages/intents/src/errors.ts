/**
 * Typed errors for the 1Click client.
 *
 * Messages never contain credentials: the transport redacts every configured
 * secret (partner JWT, User-Session token) from text it copies out of a
 * response before it builds an error.
 */

export type IntentsErrorKind =
  /** The caller's request failed local validation; nothing was sent. */
  | "validation"
  /** The route or asset is outside what Shelter supports. Nothing was sent. */
  | "unsupported"
  /** 1Click answered 400. */
  | "bad_request"
  /** 1Click answered 401 (missing or invalid partner JWT or user session). */
  | "unauthorized"
  /** A confidential call needs the partner key and none is configured. Nothing was sent. */
  | "partner_auth_required"
  /** 1Click answered 403. */
  | "forbidden"
  /** 1Click answered 404 (for status: unknown deposit address). */
  | "not_found"
  /** 1Click answered 429. `retryAfterMs` is set when the server sent Retry-After. */
  | "rate_limited"
  /** Any other non-2xx answer. */
  | "http"
  /** The request did not finish within the configured timeout. */
  | "timeout"
  /** The caller cancelled through its AbortSignal. */
  | "aborted"
  /** fetch itself failed (DNS, TLS, connection reset). */
  | "network"
  /** The body was not JSON, or did not match the documented schema. */
  | "malformed_response"
  /** The response does not describe the request that was sent. */
  | "response_mismatch"
  /** The 1Click quote signature did not verify. */
  | "signature_invalid"
  /** The quote's deadline has passed, or is too close to act on safely. */
  | "quote_expired"
  /** A dry quote, or one without a deposit address, was offered for funding. */
  | "not_fundable"
  /** Public (non-confidential) handling was requested without explicit opt-in. */
  | "confidentiality_required"
  /** A wallet signed as a different account than the one requested. */
  | "signer_mismatch"
  /** The user declined in the wallet, closed the signing page, or it timed out. */
  | "signer_rejected"
  /** The wallet's public key is not registered for the account on intents.near (add_public_key). */
  | "key_not_registered"
  /** The User-Session can no longer be refreshed; sign in again. */
  | "session_expired"
  /** An intent returned for signing does not do exactly what the quote says. Nothing was signed. */
  | "intent_mismatch"
  /** The operation belongs to a later phase and is not wired yet. */
  | "not_implemented";

export interface IntentsErrorDetails {
  status?: number;
  retryAfterMs?: number;
  correlationId?: string;
  /** Request path, e.g. "/v0/quote". Never includes query values. */
  path?: string;
  cause?: unknown;
}

export class IntentsError extends Error {
  readonly kind: IntentsErrorKind;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly correlationId?: string;
  readonly path?: string;

  constructor(kind: IntentsErrorKind, message: string, details: IntentsErrorDetails = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = "IntentsError";
    this.kind = kind;
    this.status = details.status;
    this.retryAfterMs = details.retryAfterMs;
    this.correlationId = details.correlationId;
    this.path = details.path;
  }
}

export function isIntentsError(e: unknown, kind?: IntentsErrorKind): e is IntentsError {
  return e instanceof IntentsError && (kind === undefined || e.kind === kind);
}

/** Replaces every occurrence of each secret with "[redacted]". */
export function redact(text: string, secrets: readonly (string | undefined)[]): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 4) out = out.split(s).join("[redacted]");
  }
  return out;
}
