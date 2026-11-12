import { describe, expect, it } from "vitest";
import { createIntentsClient } from "../src/client.js";
import { IntentsError } from "../src/errors.js";
import { privateDepositRequest, privateWithdrawRequest } from "../src/legs.js";
import { assertFundable } from "../src/quote.js";
import type { QuoteRequest } from "../src/types.js";
import type { WireQuoteRequest } from "../src/wire.js";
import {
  BASE_ETH,
  BASE_USDC,
  echoQuote,
  FRESH,
  json,
  NOW,
  OWNER,
  quoteCalls,
  quoteResponse,
  sign,
  SOL_USDC,
  testClient,
} from "./helpers.js";

const deposit = (over: Partial<QuoteRequest> = {}): QuoteRequest => ({
  ...privateDepositRequest({ asset: { assetId: BASE_USDC, amount: "1000000" }, owner: OWNER }),
  ...over,
});
const withdraw = (over: Partial<QuoteRequest> = {}): QuoteRequest => ({
  ...privateWithdrawRequest({ asset: { assetId: BASE_USDC, amount: "250000" }, owner: OWNER, destination: FRESH }),
  ...over,
});

async function rejection(p: Promise<unknown>): Promise<IntentsError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(IntentsError);
    return e as IntentsError;
  }
  throw new Error("expected rejection");
}

describe("leg builders", () => {
  it("deposit leg: origin chain in, owner's confidential balance out, refund stays confidential", async () => {
    const { client, calls } = testClient(echoQuote());
    await client.getQuote(deposit());
    const body = quoteCalls(calls)[0]!.body as WireQuoteRequest;
    expect(body).toEqual({
      dry: true,
      swapType: "EXACT_INPUT",
      slippageTolerance: 50,
      originAsset: BASE_USDC,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: BASE_USDC,
      amount: "1000000",
      refundTo: OWNER,
      refundType: "CONFIDENTIAL_INTENTS",
      recipient: OWNER,
      recipientType: "CONFIDENTIAL_INTENTS",
      deadline: "2026-11-07T10:30:00.000Z",
      confidentiality: "advanced",
    });
  });

  it("withdraw leg: confidential balance in, exact amount to a fresh external address, refund confidential", async () => {
    const { client, calls } = testClient(echoQuote());
    await client.getQuote(withdraw());
    const body = quoteCalls(calls)[0]!.body as WireQuoteRequest;
    expect(body).toMatchObject({
      swapType: "EXACT_OUTPUT",
      depositType: "CONFIDENTIAL_INTENTS",
      recipient: FRESH,
      recipientType: "DESTINATION_CHAIN",
      refundTo: OWNER,
      refundType: "CONFIDENTIAL_INTENTS",
      confidentiality: "advanced",
      dry: true,
    });
  });

  it("never sends tracking or address-set fields", async () => {
    const { client, calls } = testClient(echoQuote());
    await client.getQuote(deposit());
    await client.getQuote(withdraw());
    for (const c of quoteCalls(calls)) {
      const keys = Object.keys(c.body as object);
      for (const forbidden of ["connectedWallets", "sessionId", "appFees", "referral", "insured", "rebates"]) {
        expect(keys).not.toContain(forbidden);
      }
    }
  });
});

describe("defaults and privacy guards", () => {
  it("defaults to dry and advanced confidentiality", async () => {
    const { client } = testClient(echoQuote());
    const q = await client.getQuote({ ...deposit(), dry: undefined, confidentiality: undefined });
    expect(q.dry).toBe(true);
    expect(q.confidentiality).toBe("advanced");
  });

  it("refuses public confidentiality unless the client opted in", async () => {
    const { client, calls } = testClient(echoQuote());
    const e = await rejection(client.getQuote(deposit({ confidentiality: "public" })));
    expect(e.kind).toBe("confidentiality_required");
    expect(quoteCalls(calls)).toHaveLength(0);

    const opted = testClient(echoQuote(), { allowPublic: true });
    await expect(opted.client.getQuote(deposit({ confidentiality: "public" }))).resolves.toMatchObject({
      confidentiality: "public",
    });
  });

  it("refuses public INTENTS balances unless the client opted in", async () => {
    const { client } = testClient(echoQuote());
    const e = await rejection(client.getQuote(deposit({ recipientType: "INTENTS" })));
    expect(e.kind).toBe("confidentiality_required");
  });

  it("rejects a response that silently downgraded confidentiality", async () => {
    const { client } = testClient((call) => {
      const sent = call.body as WireQuoteRequest;
      return json(quoteResponse({ ...sent, confidentiality: "public" }));
    });
    const e = await rejection(client.getQuote(deposit()));
    expect(e.kind).toBe("response_mismatch");
    expect(e.message).toContain("confidentiality");
  });

  it("rejects a response that changed the recipient", async () => {
    const { client } = testClient((call) => {
      const sent = call.body as WireQuoteRequest;
      return json(quoteResponse({ ...sent, recipient: "attacker.near" }));
    });
    const e = await rejection(client.getQuote(deposit()));
    expect(e.kind).toBe("response_mismatch");
    expect(e.message).toContain("recipient");
  });
});

describe("local validation (nothing is sent)", () => {
  it.each<[string, Partial<QuoteRequest>, string]>([
    ["zero amount", { amount: "0" }, "validation"],
    ["decimal amount", { amount: "1.5" }, "validation"],
    ["fractional slippage", { slippageBps: 1.5 }, "validation"],
    ["excessive slippage", { slippageBps: 5000 }, "validation"],
    ["deadline in the past", { deadline: "2026-11-07T09:00:00.000Z" }, "validation"],
    ["deadline too far out", { deadline: "2026-11-09T10:00:00.000Z" }, "validation"],
    ["bad owner account", { recipient: "Not A Near Account" }, "validation"],
    ["unlisted asset", { originAssetId: "nep141:nope.near", destinationAssetId: "nep141:nope.near" }, "unsupported"],
    ["unsupported origin chain", { originAssetId: SOL_USDC, destinationAssetId: SOL_USDC }, "unsupported"],
  ])("deposit: %s", async (_name, over, kind) => {
    const { client, calls } = testClient(echoQuote());
    const e = await rejection(client.getQuote(deposit(over)));
    expect(e.kind).toBe(kind);
    expect(quoteCalls(calls)).toHaveLength(0);
  });

  it.each<[string, Partial<QuoteRequest>, string]>([
    ["malformed destination", { recipient: "0x1234" }, "validation"],
    ["bad checksum", { recipient: "0xAbCdEf0000000000000000000000000000000001" }, "validation"],
    ["zero address", { recipient: "0x0000000000000000000000000000000000000000" }, "validation"],
    ["NEAR account as external recipient", { recipient: OWNER }, "validation"],
    ["origin-chain refund from a confidential deposit", { refundType: "ORIGIN_CHAIN", refundTo: FRESH }, "validation"],
    ["non-EVM destination chain", { originAssetId: SOL_USDC, destinationAssetId: SOL_USDC }, "unsupported"],
  ])("withdraw: %s", async (_name, over, kind) => {
    const { client, calls } = testClient(echoQuote());
    const e = await rejection(client.getQuote(withdraw(over)));
    expect(e.kind).toBe(kind);
    expect(quoteCalls(calls)).toHaveLength(0);
  });

  it("accepts lowercase and correctly checksummed EVM addresses", async () => {
    const { client } = testClient(echoQuote());
    await expect(client.getQuote(withdraw({ recipient: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045" }))).resolves.toBeTruthy();
    await expect(client.getQuote(withdraw({ recipient: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" }))).resolves.toBeTruthy();
  });
});

describe("dry vs execution quotes", () => {
  it("maps a dry quote with no deposit address, and it can never be funded", async () => {
    const { client } = testClient(echoQuote());
    const q = await client.getQuote(withdraw());
    expect(q.depositAddress).toBeUndefined();
    expect(q.deadline).toBeUndefined();
    expect(q.provenance.signatureVerified).toBe(true);
    expect(q.withdrawFee).toBe("1000");
    expect(() => assertFundable(q, NOW)).toThrowError(/never be funded/);
  });

  it("ignores a deposit address that a dry response carries anyway", async () => {
    const { client } = testClient(echoQuote({ depositAddress: "0x4444444444444444444444444444444444444444" }));
    const q = await client.getQuote(withdraw());
    expect(q.depositAddress).toBeUndefined();
  });

  it("maps an execution quote that is fundable before its deadline and not after", async () => {
    const { client } = testClient(echoQuote());
    const q = await client.getQuote(deposit({ dry: false }));
    expect(q.dry).toBe(false);
    expect(q.depositAddress).toBe("0x3333333333333333333333333333333333333333");
    expect(() => assertFundable(q, NOW)).not.toThrow();
    // 26 minutes later only 4 minutes remain, under the 5-minute safety margin.
    const late = new Date(NOW.getTime() + 26 * 60_000);
    expect(() => assertFundable(q, late)).toThrowError(/too close/);
    try {
      assertFundable(q, new Date(NOW.getTime() + 31 * 60_000));
    } catch (e) {
      expect((e as IntentsError).kind).toBe("quote_expired");
    }
  });

  it("rejects an execution quote without a deposit address", async () => {
    const { client } = testClient(echoQuote({ depositAddress: undefined, deadline: undefined }));
    const e = await rejection(client.getQuote(deposit({ dry: false })));
    expect(e.kind).toBe("malformed_response");
  });

  it("retries a dry quote on 503 but never an execution quote", async () => {
    let n = 0;
    const flaky = (call: { body: unknown }) => (++n === 1 ? json({}, 503) : json(quoteResponse(call.body as WireQuoteRequest)));
    const dry = testClient(flaky);
    await dry.client.getQuote(deposit());
    expect(quoteCalls(dry.calls)).toHaveLength(2);

    n = 0;
    const exec = testClient(flaky);
    const e = await rejection(exec.client.getQuote(deposit({ dry: false })));
    expect(e.kind).toBe("http");
    expect(quoteCalls(exec.calls)).toHaveLength(1);
  });
});

describe("signature and response validation", () => {
  it("rejects a tampered amount", async () => {
    const { client } = testClient((call) => {
      const resp = quoteResponse(call.body as WireQuoteRequest);
      return json({ ...resp, quote: { ...resp.quote, amountOut: "1" } });
    });
    const e = await rejection(client.getQuote(withdraw()));
    expect(e.kind).toBe("signature_invalid");
  });

  it("rejects a tampered deposit address on an execution quote", async () => {
    const { client } = testClient((call) => {
      const resp = quoteResponse(call.body as WireQuoteRequest);
      return json({ ...resp, quote: { ...resp.quote, depositAddress: "0x5555555555555555555555555555555555555555" } });
    });
    const e = await rejection(client.getQuote(deposit({ dry: false })));
    expect(e.kind).toBe("signature_invalid");
  });

  it("rejects a quote signed by a different key (here: the real 1Click key, which never signed this)", async () => {
    const { client } = testClient(echoQuote(), { quoteSignerPublicKey: undefined });
    const e = await rejection(client.getQuote(withdraw()));
    expect(e.kind).toBe("signature_invalid");
  });

  it("marks quotes unverified and unfundable when verification is turned off", async () => {
    const { client } = testClient(echoQuote(), { verifySignatures: false });
    const q = await client.getQuote(deposit({ dry: false }));
    expect(q.provenance.signatureVerified).toBe(false);
    expect(() => assertFundable(q, NOW)).toThrowError(/signature/);
  });

  it.each([
    ["missing quote", (r: Record<string, unknown>) => ({ ...r, quote: undefined })],
    ["float amount", (r: Record<string, unknown>) => ({ ...r, quote: { ...(r.quote as object), amountOut: "1.5" } })],
    ["no signature", (r: Record<string, unknown>) => ({ ...r, signature: undefined })],
    ["array body", () => []],
  ])("rejects a malformed response: %s", async (_name, mutate) => {
    const { client } = testClient((call) => json(mutate(quoteResponse(call.body as WireQuoteRequest) as never)));
    const e = await rejection(client.getQuote(withdraw()));
    expect(e.kind).toBe("malformed_response");
  });

  it("tolerates unknown extra fields (additive API changes)", async () => {
    const { client } = testClient((call) => {
      const resp = quoteResponse(call.body as WireQuoteRequest);
      return json({ ...resp, somethingNew: { a: 1 } });
    });
    await expect(client.getQuote(withdraw())).resolves.toBeTruthy();
  });
});

describe("auth", () => {
  it("authenticates quotes with the partner key only, never a Bearer token", async () => {
    const { client, calls } = testClient(echoQuote(), { jwt: "partner-key" });
    await client.getQuote(withdraw());
    const [call] = quoteCalls(calls);
    expect(call!.headers["X-API-Key"]).toBe("partner-key");
    expect(call!.headers["Authorization"]).toBeUndefined();
  });

  it("refuses a confidential quote locally when no partner key is configured", async () => {
    let fetched = 0;
    const client = createIntentsClient({ fetch: async () => (fetched++, new Response("{}")), now: () => NOW });
    const e = await rejection(client.getQuote(withdraw()));
    expect(e.kind).toBe("partner_auth_required");
    expect(fetched).toBe(0);
  });

  it("surfaces 401 for confidential quotes as unauthorized, without fallback", async () => {
    const { client, calls } = testClient(() =>
      json({ message: "User authentication is required for confidential intent quotes" }, 401),
    );
    const e = await rejection(client.getQuote(withdraw()));
    expect(e.kind).toBe("unauthorized");
    expect(quoteCalls(calls)).toHaveLength(1);
  });

  it("sends a partner JWT on quotes when configured", async () => {
    const { client, calls } = testClient(echoQuote(), { jwt: "partner-jwt-test" });
    await client.getQuote(withdraw());
    expect(quoteCalls(calls)[0]!.headers["X-API-Key"]).toBe("partner-jwt-test");
  });
});

describe("gas asset", () => {
  it("quotes native Base ETH as an exact-output withdrawal", async () => {
    const { client, calls } = testClient(echoQuote());
    const q = await client.getQuote(
      privateWithdrawRequest({ asset: { assetId: BASE_ETH, amount: "100000000000000" }, owner: OWNER, destination: FRESH }),
    );
    expect(q.amountOut).toBe("100000000000000");
    expect((quoteCalls(calls)[0]!.body as WireQuoteRequest).destinationAsset).toBe(BASE_ETH);
  });
});

// Keep `sign` referenced so a future fixture can re-sign a modified response.
void sign;
