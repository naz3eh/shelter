import { describe, expect, it, vi } from "vitest";
import {
  parseExplanation,
  requestExplanation,
} from "@/lib/explain-client";
import { SAMPLE_PROFILES, sampleWallets } from "@/lib/flow/profiles";
import { FixtureReader, scanWallets, type WalletRef } from "@shelter/core";

async function realReport() {
  const sample = SAMPLE_PROFILES.medium;
  return scanWallets(
    sampleWallets(sample.profile) as WalletRef[],
    new FixtureReader(sample.profile),
  );
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("requestExplanation", () => {
  it("sends a redacted report and returns the signed answer", async () => {
    const report = await realReport();
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      // The payload must be redacted: no raw wallet addresses leak.
      const serialized = JSON.stringify(sent);
      for (const w of report.wallets) {
        expect(serialized).not.toContain(w.wallet.address.toLowerCase());
      }
      return jsonResponse(200, {
        content: '{"summary":"ok","findings":[]}',
        model: "z-ai/glm-5.3-flash",
        completionId: "c1",
        signature: { alg: "ed25519", sig: "abc", key: "def" },
        requestBody: "{}",
        responseBody: "{}",
      });
    });
    const out = await requestExplanation(report, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(out.kind).toBe("answered");
    if (out.kind !== "answered") return;
    expect(out.answer.signature).not.toBeNull();
    expect(out.answer.completionId).toBe("c1");
    expect(Object.keys(out.answer.aliases).length).toBeGreaterThan(0);
  });

  it("maps a missing-key 500 to the unavailable state", async () => {
    const report = await realReport();
    const fetchImpl = vi.fn(async () =>
      jsonResponse(500, { error: "NEAR_AI_API_KEY is not configured" }),
    );
    const out = await requestExplanation(report, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(out.kind).toBe("unavailable");
  });

  it("maps other failures to error", async () => {
    const report = await realReport();
    const fetchImpl = vi.fn(async () => jsonResponse(502, { error: "bad gateway" }));
    const out = await requestExplanation(report, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(out.kind).toBe("error");
  });

  it("treats a network throw as error, not a crash", async () => {
    const report = await realReport();
    const fetchImpl = vi.fn(async () => {
      throw new Error("offline");
    });
    const out = await requestExplanation(report, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(out.kind).toBe("error");
  });

  it("rejects an empty answer body", async () => {
    const report = await realReport();
    const fetchImpl = vi.fn(async () => jsonResponse(200, { content: "" }));
    const out = await requestExplanation(report, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(out.kind).toBe("error");
  });
});

describe("parseExplanation", () => {
  it("parses the JSON contract", () => {
    const p = parseExplanation(
      '{"summary":"s","findings":[{"check":"A","wallet":"Wallet 1","explanation":"e"}]}',
    );
    expect(p?.summary).toBe("s");
    expect(p?.findings?.[0]?.check).toBe("A");
  });
  it("strips markdown fences and tolerates prose", () => {
    expect(parseExplanation("```json\n{\"summary\":\"x\"}\n```")?.summary).toBe("x");
    expect(parseExplanation("not json")).toBeNull();
    expect(parseExplanation("null")).toBeNull();
  });
});
