/**
 * Offline test helpers. Everything here is synthetic: the token list is a
 * hand-picked subset shaped like GET /v0/tokens, and quote responses are
 * signed with a DISPOSABLE TEST KEY derived from a public, fixed seed. That
 * key has no relation to 1Click and must never be trusted outside tests.
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import { createIntentsClient, type IntentsClientOptions } from "../src/client.js";
import { quoteDigest } from "../src/signature.js";
import { createFetchTransport, type FetchLike } from "../src/transport.js";
import type { WireQuoteRequest, WireQuoteResponse } from "../src/wire.js";

export const BASE_USDC = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
export const BASE_ETH = "nep141:base.omft.near";
export const ETH_USDC = "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near";
export const SOL_USDC = "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near";

export const TOKENS = [
  { assetId: BASE_USDC, decimals: 6, blockchain: "base", symbol: "USDC", price: 1, priceUpdatedAt: "2026-11-07T00:00:00.000Z", contractAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" },
  { assetId: BASE_ETH, decimals: 18, blockchain: "base", symbol: "ETH", price: 2245.71, priceUpdatedAt: "2026-11-07T00:00:00.000Z" },
  { assetId: ETH_USDC, decimals: 6, blockchain: "eth", symbol: "USDC", price: 1, priceUpdatedAt: "2026-11-07T00:00:00.000Z", contractAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" },
  { assetId: SOL_USDC, decimals: 6, blockchain: "sol", symbol: "USDC", price: 1, priceUpdatedAt: "2026-11-07T00:00:00.000Z" },
];

/** Fixed clock for every test. */
export const NOW = new Date("2026-11-07T10:00:00.000Z");

export const OWNER = "shelter-test.near";
/** Disposable, never-funded addresses (keccak-free constants; no known history). */
export const FRESH = "0x1111111111111111111111111111111111111111";
export const SOURCE = "0x2222222222222222222222222222222222222222";

/** DISPOSABLE TEST KEY. Public seed; signs synthetic quotes only. */
const TEST_SECRET = new Uint8Array(32).fill(7);
export const TEST_SIGNER_PUBLIC_KEY = `ed25519:${base58.encode(ed25519.getPublicKey(TEST_SECRET))}`;

export function sign(resp: Omit<WireQuoteResponse, "signature"> & { signature?: string }): WireQuoteResponse {
  const unsigned = { ...resp, signature: "" } as WireQuoteResponse;
  const sig = ed25519.sign(new TextEncoder().encode(quoteDigest(unsigned)), TEST_SECRET);
  return { ...unsigned, signature: `ed25519:${base58.encode(sig)}` };
}

/** A signed quote response that echoes `sent`. */
export function quoteResponse(sent: WireQuoteRequest, quote: Partial<WireQuoteResponse["quote"]> = {}): WireQuoteResponse {
  const execution = sent.dry
    ? {}
    : {
        depositAddress: "0x3333333333333333333333333333333333333333",
        deadline: "2026-11-07T10:30:00.000Z",
        timeWhenInactive: "2026-11-07T10:25:00.000Z",
      };
  return sign({
    correlationId: "corr-1",
    timestamp: "2026-11-07T10:00:01.000Z",
    quoteRequest: { ...sent },
    quote: {
      amountIn: sent.amount,
      amountInFormatted: "1.0",
      amountInUsd: "1.0000",
      minAmountIn: sent.amount,
      amountOut: sent.amount,
      amountOutFormatted: "1.0",
      amountOutUsd: "1.0000",
      minAmountOut: sent.amount,
      timeEstimate: 20,
      withdrawFee: "1000",
      ...execution,
      ...quote,
    },
  });
}

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export type Route = (call: RecordedCall) => Response | Promise<Response>;

/** A fetch stub that records every call and answers /v0/tokens from TOKENS unless `route` handles it. */
export function fakeFetch(route: Route): { fetch: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetch: FetchLike = async (input, init) => {
    const call: RecordedCall = {
      url: input,
      method: init.method ?? "GET",
      headers: { ...(init.headers as Record<string, string>) },
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    if (input.endsWith("/v0/tokens")) return json(TOKENS);
    return route(call);
  };
  return { fetch, calls };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/** Client wired to a fake fetch, the fixed clock and the test signing key, with instant backoff. */
export function testClient(
  route: Route,
  extra: Partial<IntentsClientOptions> & { sleeps?: number[] } = {},
) {
  const ff = fakeFetch(route);
  const { sleeps, ...clientOpts } = extra;
  const transport = createFetchTransport({
    fetch: ff.fetch,
    jwt: extra.jwt,
    maxRetries: 2,
    timeoutMs: extra.timeoutMs,
    sleep: async (ms) => void sleeps?.push(ms),
    random: () => 0,
  });
  const client = createIntentsClient({
    now: () => NOW,
    quoteSignerPublicKey: TEST_SIGNER_PUBLIC_KEY,
    ...clientOpts,
    transport,
  });
  return { client, calls: ff.calls };
}

/** Answers /v0/quote by echoing the request into a signed response. */
export function echoQuote(quote: Partial<WireQuoteResponse["quote"]> = {}): Route {
  return (call) => json(quoteResponse(call.body as WireQuoteRequest, quote));
}

export const quoteCalls = (calls: RecordedCall[]) => calls.filter((c) => c.url.includes("/v0/quote"));
