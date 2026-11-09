import { describe, expect, it } from "vitest";
import fixture from "./fixtures/live-dry-quotes-2026-11-07.json" with { type: "json" };
import { ONE_CLICK_MANAGER_PUBLIC_KEY, verifyQuoteSignature } from "../src/signature.js";
import { quoteResponseSchema } from "../src/wire.js";
import * as z from "zod/mini";

// Recorded from the live API (see docs/backend/ONECLICK.md, "Live dry-quote evidence").
// These prove the digest and field selection match 1Click's real signer, not only our test key.
describe("recorded live dry quotes", () => {
  for (const name of ["sameAssetUsdc", "usdcToEth"] as const) {
    const resp = z.parse(quoteResponseSchema, fixture[name]);

    it(`${name}: real 1Click signature verifies against the manager key`, () => {
      expect(verifyQuoteSignature(resp, ONE_CLICK_MANAGER_PUBLIC_KEY)).toBe(true);
    });

    it(`${name}: any change to a signed amount breaks the signature`, () => {
      const tampered = { ...resp, quote: { ...resp.quote, amountOut: String(BigInt(resp.quote.amountOut) + 1n) } };
      expect(verifyQuoteSignature(tampered, ONE_CLICK_MANAGER_PUBLIC_KEY)).toBe(false);
    });
  }

  it("confidential quotes without a user session are refused with 401", () => {
    expect(fixture.confidentialNoSession.statusCode).toBe(401);
    expect(fixture.confidentialNoSession.message).toMatch(/User authentication is required/);
  });
});
