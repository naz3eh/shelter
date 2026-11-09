/** The 1Click client: quotes, token list, status, User-Session, balances, deposits and signed withdrawals. */

import { IntentsError } from "./errors.js";
import {
  executeSignedIntent,
  getBalances,
  prepareSignedIntent,
  submitDeposit,
  submitSignedIntent,
  type Balance,
  type IntentSummary,
  type PreparedIntent,
  type SubmittedIntent,
  type WithdrawResult,
} from "./execution.js";
import { createNearView, type NearView } from "./near-rpc.js";
import type { Nep413Signer } from "./nep413.js";
import { signIn, type UserSession } from "./session.js";
import { isTerminalStatus } from "./status.js";
import { mapQuoteResponse, normalizeQuoteRequest, toWireQuoteRequest } from "./quote.js";
import { ONE_CLICK_MANAGER_PUBLIC_KEY } from "./signature.js";
import { mapStatusResponse } from "./status.js";
import { createTokenRegistry, type TokenRegistry } from "./tokens.js";
import { createFetchTransport, type FetchLike, type Transport } from "./transport.js";
import type { Quote, QuoteRequest, StatusResult, TokenInfo } from "./types.js";

export interface IntentsClientOptions {
  /** Partner JWT (ONECLICK_JWT), sent as X-API-Key. Optional. CLI/server only, never in a browser bundle. */
  jwt?: string;
  baseUrl?: string;
  fetch?: FetchLike;
  /** Replaces the HTTP transport entirely (tests, recorded replays). `jwt`, `baseUrl` and `fetch` are then ignored. */
  transport?: Transport;
  timeoutMs?: number;
  maxRetries?: number;
  now?: () => Date;
  /**
   * Permit confidentiality "public" and public INTENTS balances. Off by
   * default; Shelter's own flows never need it. Exists for diagnostics such
   * as recording a public dry quote to compare fees.
   */
  allowPublic?: boolean;
  /** Default true. Turning it off makes every quote unfundable. */
  verifySignatures?: boolean;
  /** Override only to test or after 1Click rotates its key (check the official SDK). */
  quoteSignerPublicKey?: string;
  tokenCacheTtlMs?: number;
  /** Read-only NEAR RPC for intents.near views (salt, registered keys). */
  near?: NearView;
  nearRpcUrl?: string;
}

export interface CallOptions {
  signal?: AbortSignal;
}

export interface IntentsClient {
  tokens(opts?: CallOptions): Promise<TokenInfo[]>;
  getQuote(req: QuoteRequest, opts?: CallOptions): Promise<Quote>;
  status(depositAddress: string, opts?: CallOptions & { depositMemo?: string }): Promise<StatusResult>;
  /** Polls status until a terminal state, `until` returns true, or the timeout. Returns the last status read. */
  waitForStatus(depositAddress: string, opts?: WaitOptions): Promise<StatusResult>;
  /** NEP-413 sign-in for the confidential balance owner. Asks the wallet once. */
  signIn(signer: Nep413Signer, opts?: { signal?: AbortSignal }): Promise<UserSession>;
  balances(session: UserSession, opts?: { tokenIds?: string[]; signal?: AbortSignal }): Promise<Balance[]>;
  /** Deposit leg: notify 1Click of the on-chain transfer into the quote's deposit address. */
  submitDeposit(quote: Quote, txHash: string, opts?: { signal?: AbortSignal }): Promise<StatusResult>;
  /** First half of `executeSignedIntent`: generate, check, approve and sign. Spends nothing. */
  prepareSignedIntent(
    quote: Quote,
    signer: Nep413Signer,
    opts?: { approve?: (s: IntentSummary) => Promise<boolean> | boolean; signal?: AbortSignal },
  ): Promise<PreparedIntent>;
  /** Second half: submit a prepared intent. Re-submitting the same one cannot spend twice. */
  submitSignedIntent(prepared: PreparedIntent, opts?: { signal?: AbortSignal }): Promise<SubmittedIntent>;
  /** Withdrawal leg in one call: generate, check, sign and submit the intent for a CONFIDENTIAL_INTENTS quote. */
  executeSignedIntent(
    quote: Quote,
    signer: Nep413Signer,
    opts?: { approve?: (s: IntentSummary) => Promise<boolean> | boolean; signal?: AbortSignal },
  ): Promise<WithdrawResult>;
  readonly near: NearView;
}

export interface WaitOptions {
  depositMemo?: string;
  /** Default 5000 ms. */
  intervalMs?: number;
  /** Default 30 minutes. */
  timeoutMs?: number;
  until?: (s: StatusResult) => boolean;
  onUpdate?: (s: StatusResult) => void;
  signal?: AbortSignal;
}

export function createIntentsClient(opts: IntentsClientOptions = {}): IntentsClient {
  const transport =
    opts.transport ??
    createFetchTransport({
      baseUrl: opts.baseUrl,
      jwt: opts.jwt,
      fetch: opts.fetch,
      timeoutMs: opts.timeoutMs,
      maxRetries: opts.maxRetries,
    });
  const now = opts.now ?? (() => new Date());
  const registry: TokenRegistry = createTokenRegistry(transport, {
    ttlMs: opts.tokenCacheTtlMs,
    now: () => now().getTime(),
  });
  const signerPublicKey = opts.quoteSignerPublicKey ?? ONE_CLICK_MANAGER_PUBLIC_KEY;
  const verifySignature = opts.verifySignatures ?? true;
  const near = opts.near ?? createNearView({ rpcUrl: opts.nearRpcUrl, fetch: opts.fetch, timeoutMs: opts.timeoutMs });
  const execDeps = { transport, near, signerPublicKey, now };

  // Confidential quotes, generate-intent and submit-intent authenticate the
  // integration (partner key), not the end user: 1Click answers 401 without
  // one, and reads a User-Session token sent as Bearer there as a bad partner
  // key. With the default transport we know whether a key is configured, so
  // fail before sending anything. A custom transport handles its own auth.
  const hasPartnerKey = opts.transport !== undefined || !!opts.jwt?.trim();
  const requirePartnerKey = (what: string) => {
    if (!hasPartnerKey) {
      throw new IntentsError(
        "partner_auth_required",
        `${what} needs a 1Click partner key (ONECLICK_JWT, from the Partner Dashboard); nothing was sent`,
      );
    }
  };

  const status: IntentsClient["status"] = async (depositAddress, o = {}) => {
    if (!depositAddress.trim()) throw new IntentsError("validation", "depositAddress is required");
    const raw = await transport.request({
      method: "GET",
      path: "/v0/status",
      query: { depositAddress, depositMemo: o.depositMemo },
      retry: true,
      signal: o.signal,
    });
    return mapStatusResponse(raw, depositAddress, { signerPublicKey });
  };

  return {
    near,
    tokens: (o) => registry.list(o?.signal),

    async getQuote(req, o = {}) {
      // Same default as normalizeQuoteRequest; checked first so nothing is sent.
      if ((req.confidentiality ?? "advanced") !== "public") requirePartnerKey("A confidential quote");
      const request = await normalizeQuoteRequest(req, {
        now: now(),
        allowPublic: opts.allowPublic ?? false,
        tokens: registry,
        signal: o.signal,
      });
      const raw = await transport.request({
        method: "POST",
        path: "/v0/quote",
        body: toWireQuoteRequest(request),
        // A dry quote is a pure read. An execution quote reserves a deposit
        // address, so it is never repeated automatically.
        retry: request.dry,
        signal: o.signal,
      });
      return mapQuoteResponse(raw, request, { verifySignature, signerPublicKey });
    },

    status,

    async waitForStatus(depositAddress, o = {}) {
      const interval = Math.max(o.intervalMs ?? 5000, 1000);
      const stopAt = now().getTime() + (o.timeoutMs ?? 30 * 60_000);
      for (;;) {
        const st = await status(depositAddress, o);
        o.onUpdate?.(st);
        if (isTerminalStatus(st.status) || o.until?.(st)) return st;
        if (now().getTime() + interval > stopAt) return st;
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, interval);
          o.signal?.addEventListener("abort", () => (clearTimeout(t), reject(new IntentsError("aborted", "status wait cancelled"))), { once: true });
        });
      }
    },

    signIn: (signer, o = {}) => signIn({ transport, signer, near, now, signal: o.signal }),

    async balances(session, o = {}) {
      return getBalances(transport, await session.accessToken({ signal: o.signal }), o);
    },

    submitDeposit: (quote, txHash, o) => submitDeposit(execDeps, quote, txHash, o),

    async prepareSignedIntent(quote, signer, o) {
      requirePartnerKey("Signed intent execution");
      return prepareSignedIntent(execDeps, quote, signer, o);
    },
    async submitSignedIntent(prepared, o) {
      requirePartnerKey("Signed intent execution");
      return submitSignedIntent(execDeps, prepared, o);
    },
    async executeSignedIntent(quote, signer, o) {
      requirePartnerKey("Signed intent execution");
      return executeSignedIntent(execDeps, quote, signer, o);
    },
  };
}
