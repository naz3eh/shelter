import { describe, expect, it } from "vitest";
import * as intents from "../src/index.js";

describe("package entry points", () => {
  it("keeps the agreed entry-point names", () => {
    for (const name of ["getQuote", "deposit", "withdraw", "fundBurner", "status", "createIntentsClient"]) {
      expect(typeof (intents as Record<string, unknown>)[name]).toBe("function");
    }
  });

  it("fundBurner through the default client (no partner key) refuses before sending anything", async () => {
    const signer = { accountId: "owner.near", sign: () => Promise.reject(new Error("must not be asked")) };
    await expect(
      intents.fundBurner({
        burnerAddress: "0x1111111111111111111111111111111111111111",
        amount: { assetId: "nep141:base.omft.near", amount: "2000000000000" },
        signer,
      }),
    ).rejects.toMatchObject({ kind: "partner_auth_required" });
  });
});
