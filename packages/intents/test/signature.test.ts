import { describe, expect, it } from "vitest";
import { ONE_CLICK_MANAGER_PUBLIC_KEY, quoteDigest, verifyQuoteSignature } from "../src/signature.js";
import type { WireQuoteRequest } from "../src/wire.js";
import { BASE_USDC, FRESH, OWNER, quoteResponse, TEST_SIGNER_PUBLIC_KEY } from "./helpers.js";

const sent: WireQuoteRequest = {
  dry: true,
  swapType: "EXACT_OUTPUT",
  slippageTolerance: 50,
  originAsset: BASE_USDC,
  depositType: "CONFIDENTIAL_INTENTS",
  destinationAsset: BASE_USDC,
  amount: "250000",
  refundTo: OWNER,
  refundType: "CONFIDENTIAL_INTENTS",
  recipient: FRESH,
  recipientType: "DESTINATION_CHAIN",
  deadline: "2026-11-07T10:30:00.000Z",
  confidentiality: "advanced",
};

describe("quote signature", () => {
  it("digest is independent of key order and ignores unsigned fields", () => {
    const a = quoteResponse(sent);
    const reordered = JSON.parse(JSON.stringify({ quote: a.quote, signature: a.signature, timestamp: a.timestamp, quoteRequest: a.quoteRequest, correlationId: "other" }));
    expect(quoteDigest(reordered)).toBe(quoteDigest(a));
    // connectedWallets/sessionId are explicitly excluded from the signed payload.
    const withExtras = { ...a, quoteRequest: { ...a.quoteRequest, connectedWallets: ["0xabc"], sessionId: "s" } };
    expect(quoteDigest(withExtras)).toBe(quoteDigest(a));
  });

  it("covers the signed request and quote fields", () => {
    const a = quoteResponse(sent);
    expect(quoteDigest({ ...a, quoteRequest: { ...a.quoteRequest, recipient: OWNER } })).not.toBe(quoteDigest(a));
    expect(quoteDigest({ ...a, timestamp: "2026-11-07T10:00:02.000Z" })).not.toBe(quoteDigest(a));
  });

  it("verifies against the signing key and rejects other keys and garbage", () => {
    const a = quoteResponse(sent);
    expect(verifyQuoteSignature(a, TEST_SIGNER_PUBLIC_KEY)).toBe(true);
    expect(verifyQuoteSignature(a, ONE_CLICK_MANAGER_PUBLIC_KEY)).toBe(false);
    expect(verifyQuoteSignature({ ...a, signature: "ed25519:notbase58!!" }, TEST_SIGNER_PUBLIC_KEY)).toBe(false);
    expect(verifyQuoteSignature({ ...a, signature: "" }, TEST_SIGNER_PUBLIC_KEY)).toBe(false);
  });

  it("dry quotes sign only amounts, so execution-only fields do not affect them", () => {
    const a = quoteResponse(sent);
    const withDeposit = { ...a, quote: { ...a.quote, depositAddress: "0x4444444444444444444444444444444444444444" } };
    expect(quoteDigest(withDeposit)).toBe(quoteDigest(a));
  });

  it("execution quotes sign the deposit address", () => {
    const a = quoteResponse({ ...sent, dry: false });
    const moved = { ...a, quote: { ...a.quote, depositAddress: "0x4444444444444444444444444444444444444444" } };
    expect(quoteDigest(moved)).not.toBe(quoteDigest(a));
  });
});
