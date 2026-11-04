import { describe, expect, it } from "vitest";
import { generateNonce, verifyAttestation } from "../src/index";
import { checkNamed, fixtureQuoteVerifier, loadFixture } from "./helpers.js";

const verify = (name: string) => {
  const fixture = loadFixture(name);
  return verifyAttestation({
    model: fixture.model,
    nonce: fixture.clientNonce,
    getReport: async () => fixture.response,
    quoteVerifier: fixtureQuoteVerifier(fixture),
  });
};

describe("verifyAttestation", () => {
  it("generates a 64-hex fresh nonce per call", () => {
    const a = generateNonce();
    const b = generateNonce();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });

  it("passes every check on a consistent report", async () => {
    const result = await verify("pass");
    expect(result.ok).toBe(true);
    expect(result.checks.every((c) => c.ok)).toBe(true);
    // Required evidence ran on the gateway and on the model candidate.
    for (const prefix of ["gateway:", "model[0]:"]) {
      for (const name of [
        "dcap-quote",
        "tdx-debug-disabled",
        "quote-binds-nonce",
        "echoed-nonce",
        "app-compose-hash",
        "rtmr3-replay",
        "gpu-evidence",
      ]) {
        expect(checkNamed(result.checks, `${prefix}${name}`)?.ok).toBe(true);
      }
    }
    expect(result.signingAddress?.toLowerCase()).toBe(
      "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    );
    expect(result.verifiedModelSigners).toHaveLength(1);
    expect(result.gateway?.signingAddress.toLowerCase()).toBe(
      "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
    );
  });

  it("rejects a report bound to a different nonce", async () => {
    const result = await verify("wrong-nonce");
    expect(result.ok).toBe(false);
    for (const prefix of ["gateway:", "model[0]:"]) {
      expect(checkNamed(result.checks, `${prefix}echoed-nonce`)?.ok).toBe(false);
      expect(checkNamed(result.checks, `${prefix}quote-binds-nonce`)?.ok).toBe(
        false,
      );
    }
    expect(result.verifiedModelSigners).toHaveLength(0);
  });

  it("rejects a tampered app_compose", async () => {
    const result = await verify("tampered-app-compose");
    expect(result.ok).toBe(false);
    for (const prefix of ["gateway:", "model[0]:"]) {
      expect(
        checkNamed(result.checks, `${prefix}app-compose-hash`)?.ok,
      ).toBe(false);
    }
    // The rest of the report is still well-formed.
    expect(checkNamed(result.checks, "model[0]:echoed-nonce")?.ok).toBe(true);
  });

  it("rejects a response with no model_attestations", async () => {
    const result = await verify("missing-model-attestations");
    expect(result.ok).toBe(false);
    expect(
      checkNamed(result.checks, "model-attestations-present")?.ok,
    ).toBe(false);
    // Gateway evidence is still verified on its own.
    expect(checkNamed(result.checks, "gateway:dcap-quote")?.ok).toBe(true);
    expect(result.verifiedModelSigners).toHaveLength(0);
  });

  it("fails cleanly when the report cannot be fetched", async () => {
    const result = await verifyAttestation({
      model: "z-ai/glm-5.3-flash",
      nonce: "00".repeat(32),
      getReport: async () => {
        throw new Error("HTTP 401");
      },
      quoteVerifier: fixtureQuoteVerifier(loadFixture("pass")),
    });
    expect(result.ok).toBe(false);
    expect(checkNamed(result.checks, "report-fetch")?.ok).toBe(false);
  });
});
