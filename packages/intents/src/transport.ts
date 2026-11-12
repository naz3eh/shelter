/**
 * HTTP transport for the 1Click API: timeouts, cancellation, bounded retry
 * for safe reads, typed errors and credential redaction.
 *
 * Credentials:
 * - The optional partner JWT is sent as `X-API-Key` (documented at
 *   https://docs.near-intents.org/integration/distribution-channels/1click-api/authentication).
 *   It belongs in CLI or server configuration only, never in browser bundles.
 * - A per-call User-Session access token, when given, is sent as
 *   `Authorization: Bearer`. It is a different credential from the JWT.
 */

import { IntentsError, redact } from "./errors.js";

export const DEFAULT_BASE_URL = "https://1click.chaindefuser.com";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface TransportRequest {
  method: "GET" | "POST";
  path: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
  /** User-Session access token for this call only. */
  sessionToken?: string;
  /** Further secrets carried in this call (for example a refresh token in the body), redacted from errors. */
  redact?: readonly string[];
  /** Retry on timeout, network errors, 429 and 5xx. Only for calls that are safe to repeat. */
  retry: boolean;
  signal?: AbortSignal;
}

export interface Transport {
  request(req: TransportRequest): Promise<unknown>;
}

export interface FetchTransportOptions {
  baseUrl?: string;
  /** Partner JWT (ONECLICK_JWT). Optional; without it 1Click applies its no-key fee. */
  jwt?: string;
  fetch?: FetchLike;
  /** Per-attempt timeout. Default 15 s. */
  timeoutMs?: number;
  /** Extra attempts for retryable calls. Default 2. Capped at 5. */
  maxRetries?: number;
  /** Injected for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Injected for tests; returns [0, 1). */
  random?: () => number;
}

const MAX_BACKOFF_MS = 10_000;

export function createFetchTransport(opts: FetchTransportOptions = {}): Transport {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const doFetch: FetchLike = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const maxRetries = Math.min(Math.max(opts.maxRetries ?? 2, 0), 5);
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;
  const jwt = opts.jwt?.trim() || undefined;

  async function attempt(req: TransportRequest): Promise<unknown> {
    const secrets = [jwt, req.sessionToken, ...(req.redact ?? [])];
    const url = buildUrl(baseUrl, req.path, req.query);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (req.body !== undefined) headers["Content-Type"] = "application/json";
    if (jwt) headers["X-API-Key"] = jwt;
    if (req.sessionToken) headers["Authorization"] = `Bearer ${req.sessionToken}`;

    const ctl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctl.abort();
    }, timeoutMs);
    const onCallerAbort = () => ctl.abort();
    req.signal?.addEventListener("abort", onCallerAbort, { once: true });

    let res: Response;
    try {
      res = await doFetch(url, {
        method: req.method,
        headers,
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
        signal: ctl.signal,
      });
    } catch (cause) {
      if (req.signal?.aborted) throw new IntentsError("aborted", `${req.path} cancelled`, { path: req.path });
      if (timedOut) {
        throw new IntentsError("timeout", `${req.path} timed out after ${timeoutMs} ms`, { path: req.path });
      }
      throw new IntentsError("network", `${req.path} failed: ${redact(errorText(cause), secrets)}`, {
        path: req.path,
      });
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener("abort", onCallerAbort);
    }

    let text: string;
    try {
      text = await res.text();
    } catch {
      if (req.signal?.aborted) throw new IntentsError("aborted", `${req.path} cancelled`, { path: req.path });
      throw new IntentsError("network", `${req.path}: could not read response body`, {
        path: req.path,
        status: res.status,
      });
    }

    if (!res.ok) throw httpError(res, text, req.path, secrets);

    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new IntentsError("malformed_response", `${req.path}: response is not JSON`, {
        path: req.path,
        status: res.status,
      });
    }
  }

  return {
    async request(req) {
      const attempts = req.retry ? maxRetries + 1 : 1;
      for (let i = 0; ; i++) {
        if (req.signal?.aborted) throw new IntentsError("aborted", `${req.path} cancelled`, { path: req.path });
        try {
          return await attempt(req);
        } catch (e) {
          if (!(e instanceof IntentsError) || !isRetryable(e) || i + 1 >= attempts) throw e;
          const backoff = Math.min(250 * 2 ** i + Math.floor(random() * 250), MAX_BACKOFF_MS);
          await sleep(Math.min(Math.max(e.retryAfterMs ?? 0, backoff), MAX_BACKOFF_MS), req.signal);
        }
      }
    },
  };
}

function isRetryable(e: IntentsError): boolean {
  return (
    e.kind === "timeout" ||
    e.kind === "network" ||
    e.kind === "rate_limited" ||
    (e.kind === "http" && (e.status ?? 0) >= 500)
  );
}

function httpError(res: Response, text: string, path: string, secrets: (string | undefined)[]): IntentsError {
  const status = res.status;
  const serverMessage = redact(extractMessage(text), secrets);
  const suffix = serverMessage ? `: ${serverMessage}` : "";
  const details = { status, path, correlationId: res.headers.get("x-correlation-id") ?? undefined };
  switch (status) {
    case 400:
      return new IntentsError("bad_request", `${path} rejected (400)${suffix}`, details);
    case 401:
      return new IntentsError("unauthorized", `${path} unauthorized (401)${suffix}`, details);
    case 403:
      return new IntentsError("forbidden", `${path} forbidden (403)${suffix}`, details);
    case 404:
      return new IntentsError("not_found", `${path} not found (404)${suffix}`, details);
    case 429:
      return new IntentsError("rate_limited", `${path} rate limited (429)${suffix}`, {
        ...details,
        retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
      });
    default:
      return new IntentsError("http", `${path} failed (${status})${suffix}`, details);
  }
}

/** Pulls a short human message out of an error body without echoing the whole body. */
function extractMessage(text: string): string {
  let msg = "";
  try {
    const body = JSON.parse(text) as unknown;
    if (body && typeof body === "object" && "message" in body) {
      const m = (body as { message: unknown }).message;
      msg = Array.isArray(m) ? m.map(String).join("; ") : typeof m === "string" ? m : "";
    }
  } catch {
    msg = "";
  }
  return msg.replace(/\s+/g, " ").trim().slice(0, 300);
}

function parseRetryAfter(v: string | null): number | undefined {
  if (!v) return undefined;
  const secs = Number(v);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, MAX_BACKOFF_MS);
  const at = Date.parse(v);
  return Number.isNaN(at) ? undefined : Math.min(Math.max(at - Date.now(), 0), MAX_BACKOFF_MS);
}

function buildUrl(baseUrl: string, path: string, query?: Record<string, string | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) qs.set(k, v);
  const s = qs.toString();
  return `${baseUrl}${path}${s ? `?${s}` : ""}`;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new IntentsError("aborted", "cancelled during backoff"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new IntentsError("aborted", "cancelled during backoff"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
