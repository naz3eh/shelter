import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { createHash } from "node:crypto";
import {
  verifyAttestation,
  verifyResponseSignature,
  type SignaturePayload,
} from "../src/index";
import { fixtureQuoteVerifier, loadFixture } from "./helpers.js";

// Hardhat/Anvil account #0 — public test key, signs for the fixture's model
// signing_address (0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266).
const MODEL_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
// Hardhat/Anvil account #2 — a different signer, used for the mismatch case.
const OTHER_KEY =
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";

const sha256hex = (s: string) =>
  createHash("sha256").update(s, "utf8").digest("hex");

async function verified() {
  const fixture = loadFixture("pass");
  return verifyAttestation({
    model: fixture.model,
    nonce: fixture.clientNonce,
    getReport: async () => fixture.response,
    quoteVerifier: fixtureQuoteVerifier(fixture),
  });
}

const REQUEST_BODY = '{"model":"z-ai/glm-5.3-flash","messages":[]}';
const RESPONSE_BODY = '{"id":"chatcmpl-test","choices":[]}';

async function signWith(key: `0x${string}`, text: string) {
  const account = privateKeyToAccount(key);
  return account.signMessage({ message: text });
}

describe("verifyResponseSignature", () => {
  it("accepts a provider_tee signature bound to the exact bytes", async () => {
    const model = "z-ai/glm-5.3-flash";
    const text = `${model}:${sha256hex(REQUEST_BODY)}:${sha256hex(RESPONSE_BODY)}`;
    const signature: SignaturePayload = {
      signature_kind: "provider_tee",
      text,
      signature: await signWith(MODEL_KEY, text),
      signing_algo: "ecdsa",
    };
    const result = await verifyResponseSignature({
      signature,
      model,
      requestBody: REQUEST_BODY,
      responseBody: RESPONSE_BODY,
      verification: await verified(),
    });
    expect(result.ok).toBe(true);
    expect(result.checks.every((c) => c.ok)).toBe(true);
    expect(result.signer?.toLowerCase()).toBe(
      "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    );
  });

  it("rejects a signature from a key that is not the attested signer", async () => {
    const model = "z-ai/glm-5.3-flash";
    const text = `${model}:${sha256hex(REQUEST_BODY)}:${sha256hex(RESPONSE_BODY)}`;
    const signature: SignaturePayload = {
      signature_kind: "provider_tee",
      text,
      signature: await signWith(OTHER_KEY, text),
      signing_algo: "ecdsa",
    };
    const result = await verifyResponseSignature({
      signature,
      model,
      requestBody: REQUEST_BODY,
      responseBody: RESPONSE_BODY,
      verification: await verified(),
    });
    expect(result.ok).toBe(false);
    const match = result.checks.find(
      (c) => c.name === "signer-matches-attestation",
    );
    expect(match?.ok).toBe(false);
  });

  it("rejects when the signed text does not bind the received bytes", async () => {
    const model = "z-ai/glm-5.3-flash";
    const text = `${model}:${sha256hex(REQUEST_BODY)}:${sha256hex(RESPONSE_BODY)}`;
    const signature: SignaturePayload = {
      signature_kind: "provider_tee",
      text,
      signature: await signWith(MODEL_KEY, text),
      signing_algo: "ecdsa",
    };
    const result = await verifyResponseSignature({
      signature,
      model,
      requestBody: REQUEST_BODY,
      responseBody: '{"id":"chatcmpl-other","choices":[]}',
      verification: await verified(),
    });
    expect(result.ok).toBe(false);
    expect(
      result.checks.find((c) => c.name === "response-hash-bound")?.ok,
    ).toBe(false);
  });

  it("matches a gateway signature against the verified gateway report", async () => {
    const text = `${sha256hex(REQUEST_BODY)}:${sha256hex(RESPONSE_BODY)}`;
    // Hardhat account #1 = the fixture's gateway signing_address.
    const signature: SignaturePayload = {
      signature_kind: "gateway",
      text,
      signature: await signWith(
        "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
        text,
      ),
      signing_algo: "ecdsa",
    };
    const result = await verifyResponseSignature({
      signature,
      model: "z-ai/glm-5.3-flash",
      requestBody: REQUEST_BODY,
      responseBody: RESPONSE_BODY,
      verification: await verified(),
    });
    expect(result.ok).toBe(true);
  });
});
