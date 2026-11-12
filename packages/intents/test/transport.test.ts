import { describe, expect, it } from "vitest";
import { IntentsError } from "../src/errors.js";
import { createFetchTransport, type FetchLike } from "../src/transport.js";
import { json } from "./helpers.js";

const JWT = "test-partner-jwt-not-a-real-token";
const SESSION = "test-user-session-not-a-real-token";

function recorder(respond: (n: number) => Response | Promise<Response>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, headers: { ...(init.headers as Record<string, string>) } });
    return respond(calls.length);
  };
  return { fetch, calls };
}

async function kindOf(p: Promise<unknown>): Promise<IntentsError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(IntentsError);
    return e as IntentsError;
  }
  throw new Error("expected rejection");
}

const instant = async () => {};

describe("credentials", () => {
  it("sends no auth header without a JWT (no-key operation is documented)", async () => {
    const r = recorder(() => json([]));
    await createFetchTransport({ fetch: r.fetch }).request({ method: "GET", path: "/v0/tokens", retry: false });
    expect(r.calls[0]!.headers["X-API-Key"]).toBeUndefined();
    expect(r.calls[0]!.headers["Authorization"]).toBeUndefined();
  });

  it("sends the partner JWT as X-API-Key and the user session as Bearer, separately", async () => {
    const r = recorder(() => json({}));
    await createFetchTransport({ fetch: r.fetch, jwt: JWT }).request({
      method: "GET",
      path: "/v0/status",
      sessionToken: SESSION,
      retry: false,
    });
    expect(r.calls[0]!.headers["X-API-Key"]).toBe(JWT);
    expect(r.calls[0]!.headers["Authorization"]).toBe(`Bearer ${SESSION}`);
  });

  it("treats a blank JWT as absent", async () => {
    const r = recorder(() => json([]));
    await createFetchTransport({ fetch: r.fetch, jwt: "  " }).request({ method: "GET", path: "/v0/tokens", retry: false });
    expect(r.calls[0]!.headers["X-API-Key"]).toBeUndefined();
  });

  it("never leaks credentials into error messages, even when the server echoes them", async () => {
    const r = recorder(() => json({ message: `invalid key ${JWT} for session ${SESSION}` }, 401));
    const e = await kindOf(
      createFetchTransport({ fetch: r.fetch, jwt: JWT }).request({
        method: "POST",
        path: "/v0/quote",
        body: {},
        sessionToken: SESSION,
        retry: false,
      }),
    );
    expect(e.kind).toBe("unauthorized");
    expect(e.message).not.toContain(JWT);
    expect(e.message).not.toContain(SESSION);
    expect(e.message).toContain("[redacted]");
    expect(JSON.stringify(e)).not.toContain(JWT);
  });

  it("redacts credentials from network error text", async () => {
    const fetch: FetchLike = async () => {
      throw new TypeError(`connect failed for ${JWT}`);
    };
    const e = await kindOf(createFetchTransport({ fetch, jwt: JWT }).request({ method: "GET", path: "/v0/tokens", retry: false }));
    expect(e.kind).toBe("network");
    expect(e.message).not.toContain(JWT);
  });
});

describe("error mapping", () => {
  it.each([
    [400, "bad_request"],
    [401, "unauthorized"],
    [403, "forbidden"],
    [404, "not_found"],
    [429, "rate_limited"],
    [500, "http"],
    [502, "http"],
  ] as const)("maps HTTP %i to %s", async (status, kind) => {
    const r = recorder(() => json({ message: "nope" }, status));
    const e = await kindOf(createFetchTransport({ fetch: r.fetch }).request({ method: "GET", path: "/v0/x", retry: false }));
    expect(e.kind).toBe(kind);
    expect(e.status).toBe(status);
    expect(e.message).toContain("nope");
  });

  it("keeps the server message short and single-line", async () => {
    const r = recorder(() => json({ message: ["a\n\nb", "c".repeat(1000)] }, 400));
    const e = await kindOf(createFetchTransport({ fetch: r.fetch }).request({ method: "GET", path: "/v0/x", retry: false }));
    expect(e.message).not.toContain("\n");
    expect(e.message.length).toBeLessThan(400);
  });

  it("rejects a non-JSON 200 body as malformed", async () => {
    const r = recorder(() => new Response("<html>gateway</html>", { status: 200 }));
    const e = await kindOf(createFetchTransport({ fetch: r.fetch }).request({ method: "GET", path: "/v0/x", retry: false }));
    expect(e.kind).toBe("malformed_response");
  });

  it("times out a hung request", async () => {
    const fetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    const e = await kindOf(
      createFetchTransport({ fetch, timeoutMs: 20 }).request({ method: "GET", path: "/v0/tokens", retry: false }),
    );
    expect(e.kind).toBe("timeout");
  });

  it("honours caller cancellation and does not retry it", async () => {
    let n = 0;
    const fetch: FetchLike = (_url, init) => {
      n++;
      return new Promise((_resolve, reject) =>
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
      );
    };
    const ctl = new AbortController();
    const p = createFetchTransport({ fetch, sleep: instant }).request({
      method: "GET",
      path: "/v0/tokens",
      retry: true,
      signal: ctl.signal,
    });
    ctl.abort();
    const e = await kindOf(p);
    expect(e.kind).toBe("aborted");
    expect(n).toBe(1);
  });

  it("fails immediately when already cancelled", async () => {
    const r = recorder(() => json([]));
    const ctl = new AbortController();
    ctl.abort();
    const e = await kindOf(
      createFetchTransport({ fetch: r.fetch }).request({ method: "GET", path: "/v0/tokens", retry: true, signal: ctl.signal }),
    );
    expect(e.kind).toBe("aborted");
    expect(r.calls).toHaveLength(0);
  });
});

describe("retry policy", () => {
  it("retries retryable reads a bounded number of times, then gives up", async () => {
    const r = recorder(() => json({ message: "down" }, 503));
    const sleeps: number[] = [];
    const e = await kindOf(
      createFetchTransport({ fetch: r.fetch, maxRetries: 2, sleep: async (ms) => void sleeps.push(ms), random: () => 0 }).request({
        method: "GET",
        path: "/v0/tokens",
        retry: true,
      }),
    );
    expect(e.kind).toBe("http");
    expect(r.calls).toHaveLength(3);
    expect(sleeps).toEqual([250, 500]);
  });

  it("succeeds after a transient failure", async () => {
    const r = recorder((n) => (n === 1 ? json({}, 502) : json(["ok"])));
    const out = await createFetchTransport({ fetch: r.fetch, sleep: instant }).request({ method: "GET", path: "/v0/tokens", retry: true });
    expect(out).toEqual(["ok"]);
  });

  it("never repeats a non-retryable call", async () => {
    const r = recorder(() => json({}, 503));
    await kindOf(createFetchTransport({ fetch: r.fetch, sleep: instant }).request({ method: "POST", path: "/v0/quote", body: {}, retry: false }));
    expect(r.calls).toHaveLength(1);
  });

  it("does not retry client errors", async () => {
    const r = recorder(() => json({}, 400));
    await kindOf(createFetchTransport({ fetch: r.fetch, sleep: instant }).request({ method: "GET", path: "/v0/tokens", retry: true }));
    expect(r.calls).toHaveLength(1);
  });

  it("waits at least Retry-After on 429, capped", async () => {
    const r = recorder((n) => (n === 1 ? json({}, 429, { "retry-after": "3" }) : json([])));
    const sleeps: number[] = [];
    await createFetchTransport({ fetch: r.fetch, sleep: async (ms) => void sleeps.push(ms), random: () => 0 }).request({
      method: "GET",
      path: "/v0/tokens",
      retry: true,
    });
    expect(sleeps).toEqual([3000]);

    const r2 = recorder((n) => (n === 1 ? json({}, 429, { "retry-after": "3600" }) : json([])));
    const sleeps2: number[] = [];
    await createFetchTransport({ fetch: r2.fetch, sleep: async (ms) => void sleeps2.push(ms) }).request({
      method: "GET",
      path: "/v0/tokens",
      retry: true,
    });
    expect(sleeps2).toEqual([10_000]);
  });
});

describe("urls", () => {
  it("joins base url and query safely", async () => {
    const r = recorder(() => json({}));
    await createFetchTransport({ fetch: r.fetch, baseUrl: "https://example.test/" }).request({
      method: "GET",
      path: "/v0/status",
      query: { depositAddress: "0xabc", depositMemo: undefined },
      retry: false,
    });
    expect(r.calls[0]!.url).toBe("https://example.test/v0/status?depositAddress=0xabc");
  });
});
