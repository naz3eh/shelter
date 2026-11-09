/** Supported-token registry backed by GET /v0/tokens, cached in memory. */

import { IntentsError } from "./errors.js";
import type { Transport } from "./transport.js";
import type { TokenInfo } from "./types.js";
import { describeIssue, tokensSchema } from "./wire.js";

export interface TokenRegistry {
  list(signal?: AbortSignal): Promise<TokenInfo[]>;
  /** Throws `unsupported` when 1Click does not list the asset. */
  get(assetId: string, signal?: AbortSignal): Promise<TokenInfo>;
}

export function createTokenRegistry(
  transport: Transport,
  opts: { ttlMs?: number; now?: () => number } = {},
): TokenRegistry {
  const ttlMs = opts.ttlMs ?? 10 * 60_000;
  const now = opts.now ?? Date.now;
  let cache: { at: number; byId: Map<string, TokenInfo> } | undefined;
  let inflight: Promise<Map<string, TokenInfo>> | undefined;

  async function load(signal?: AbortSignal): Promise<Map<string, TokenInfo>> {
    if (cache && now() - cache.at < ttlMs) return cache.byId;
    inflight ??= (async () => {
      try {
        const raw = await transport.request({ method: "GET", path: "/v0/tokens", retry: true, signal });
        const parsed = tokensSchema.safeParse(raw);
        if (!parsed.success) {
          throw new IntentsError("malformed_response", `/v0/tokens: ${describeIssue(parsed.error)}`, {
            path: "/v0/tokens",
          });
        }
        const byId = new Map<string, TokenInfo>();
        for (const t of parsed.data) {
          byId.set(t.assetId, {
            assetId: t.assetId,
            decimals: t.decimals,
            blockchain: t.blockchain,
            symbol: t.symbol,
            contractAddress: t.contractAddress,
          });
        }
        cache = { at: now(), byId };
        return byId;
      } finally {
        inflight = undefined;
      }
    })();
    return inflight;
  }

  return {
    async list(signal) {
      return [...(await load(signal)).values()];
    },
    async get(assetId, signal) {
      const t = (await load(signal)).get(assetId);
      if (!t) throw new IntentsError("unsupported", `asset ${assetId} is not listed by 1Click`);
      return t;
    },
  };
}
