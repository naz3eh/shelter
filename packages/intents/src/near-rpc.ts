/**
 * Minimal read-only NEAR JSON-RPC client: view calls on `intents.near`.
 *
 * Only `query/call_function` with `finality` is used; nothing here can sign
 * or send a transaction. Results are re-validated by the caller.
 * RPC: https://docs.near.org/api/rpc/contracts#call-a-contract-function
 */

import { base64 } from "@scure/base";
import { IntentsError } from "./errors.js";
import type { FetchLike } from "./transport.js";

export const INTENTS_CONTRACT = "intents.near";
/** FastNear's free mainnet endpoint; rpc.mainnet.near.org is rate limited. Override with `rpcUrl`. */
export const DEFAULT_NEAR_RPC_URL = "https://free.rpc.fastnear.com";

export interface NearViewOptions {
  rpcUrl?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

export interface NearView {
  call<T = unknown>(contract: string, method: string, args: Record<string, unknown>, opts?: { signal?: AbortSignal }): Promise<T>;
  /** The salt the next intents.near nonce must carry. */
  currentSalt(opts?: { signal?: AbortSignal }): Promise<string>;
  hasPublicKey(accountId: string, publicKey: string, opts?: { signal?: AbortSignal }): Promise<boolean>;
  publicKeysOf(accountId: string, opts?: { signal?: AbortSignal }): Promise<string[]>;
}

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });

export function createNearView(opts: NearViewOptions = {}): NearView {
  const rpcUrl = opts.rpcUrl ?? DEFAULT_NEAR_RPC_URL;
  const doFetch: FetchLike = opts.fetch ?? ((i, init) => globalThis.fetch(i, init));
  const timeoutMs = opts.timeoutMs ?? 15_000;

  async function call<T>(contract: string, method: string, args: Record<string, unknown>, o: { signal?: AbortSignal } = {}): Promise<T> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const onAbort = () => ctl.abort();
    o.signal?.addEventListener("abort", onAbort, { once: true });
    const path = `near:${contract}.${method}`;
    let body: unknown;
    try {
      const res = await doFetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "shelter",
          method: "query",
          params: {
            request_type: "call_function",
            finality: "final",
            account_id: contract,
            method_name: method,
            args_base64: base64.encode(enc.encode(JSON.stringify(args))),
          },
        }),
        signal: ctl.signal,
      });
      if (!res.ok) throw new IntentsError("http", `${path}: NEAR RPC answered ${res.status}`, { status: res.status, path });
      body = await res.json();
    } catch (e) {
      if (e instanceof IntentsError) throw e;
      if (o.signal?.aborted) throw new IntentsError("aborted", `${path} cancelled`, { path });
      throw new IntentsError(ctl.signal.aborted ? "timeout" : "network", `${path}: NEAR RPC request failed`, { path, cause: e });
    } finally {
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
    }
    const r = body as { error?: unknown; result?: { result?: unknown; error?: unknown } };
    if (r?.error || r?.result?.error) {
      throw new IntentsError("http", `${path}: NEAR RPC error ${JSON.stringify(r.error ?? r.result?.error).slice(0, 300)}`, { path });
    }
    const bytes = r?.result?.result;
    if (!Array.isArray(bytes) || !bytes.every((b) => Number.isInteger(b) && b >= 0 && b < 256)) {
      throw new IntentsError("malformed_response", `${path}: NEAR RPC result is not a byte array`, { path });
    }
    try {
      return JSON.parse(dec.decode(Uint8Array.from(bytes as number[]))) as T;
    } catch {
      throw new IntentsError("malformed_response", `${path}: view result is not JSON`, { path });
    }
  }

  return {
    call,
    async currentSalt(o) {
      const v = await call<unknown>(INTENTS_CONTRACT, "current_salt", {}, o);
      if (typeof v !== "string" || !/^[0-9a-f]{8}$/.test(v)) {
        throw new IntentsError("malformed_response", "intents.near current_salt is not 8 hex characters");
      }
      return v;
    },
    async hasPublicKey(accountId, publicKey, o) {
      const v = await call<unknown>(INTENTS_CONTRACT, "has_public_key", { account_id: accountId, public_key: publicKey }, o);
      if (typeof v !== "boolean") throw new IntentsError("malformed_response", "intents.near has_public_key is not a boolean");
      return v;
    },
    async publicKeysOf(accountId, o) {
      const v = await call<unknown>(INTENTS_CONTRACT, "public_keys_of", { account_id: accountId }, o);
      if (!Array.isArray(v) || !v.every((k) => typeof k === "string")) {
        throw new IntentsError("malformed_response", "intents.near public_keys_of is not a list of keys");
      }
      return v as string[];
    },
  };
}
