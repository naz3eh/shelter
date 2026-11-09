/**
 * Signed withdrawals from the confidential balance (intents.far): the checks
 * on the intent 1Click generates, and the prepare/submit split that lets a
 * caller persist the signed intent before submitting it.
 *
 * The wallet is a real ed25519 key, so signatures are really verified.
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import { base58, base64 } from "@scure/base";
import { describe, expect, it } from "vitest";
import { IntentsError } from "../src/errors.js";
import {
  CONFIDENTIAL_INTENTS_CONTRACT,
  CONFIDENTIAL_INTENTS_SALT,
  checkGeneratedIntent,
  confidentialTokenId,
} from "../src/execution.js";
import { privateWithdrawRequest } from "../src/legs.js";
import type { NearView } from "../src/near-rpc.js";
import { nep413Hash, type Nep413Payload, type Nep413Signer } from "../src/nep413.js";
import { decodeVersionedNonce, encodeVersionedNonce } from "../src/nonce.js";
import type { Quote } from "../src/types.js";
import { BASE_USDC, FRESH, json, NOW, OWNER, quoteResponse, testClient, type RecordedCall } from "./helpers.js";
import type { WireQuoteRequest } from "../src/wire.js";

const SK = new Uint8Array(32).fill(7);
const PK = `ed25519:${base58.encode(ed25519.getPublicKey(SK))}`;
const DEPOSIT = "6b03a2ba226fa968924c8f75fcec0db3c1e64c5b19d7b9e535773b6a66a08471";
const TOKEN = confidentialTokenId(BASE_USDC);

const wallet = (accountId = OWNER, sk = SK): Nep413Signer & { signed: Nep413Payload[] } => {
  const signed: Nep413Payload[] = [];
  return {
    accountId,
    signed,
    async sign(p) {
      signed.push(p);
      return { accountId, publicKey: `ed25519:${base58.encode(ed25519.getPublicKey(sk))}`, signature: base64.encode(ed25519.sign(nep413Hash(p), sk)) };
    },
  };
};

const near = (registered = true): NearView => ({
  call: async () => {
    throw new Error("unused");
  },
  currentSalt: async () => "252812b3", // intents.near's salt; must not be used for intents.far
  hasPublicKey: async () => registered,
  publicKeysOf: async () => (registered ? [PK] : []),
});

interface IntentOpts {
  recipient?: string;
  salt?: string;
  deadline?: Date;
  nonceDeadline?: Date;
  signer?: string;
  intents?: unknown[];
  extra?: Record<string, unknown>;
  callbackUrl?: string;
}

/** What 1Click's generate-intent returned live on 2026-11-08, parameterised for the bad cases. */
function generated(o: IntentOpts = {}, amountIn = "254800") {
  const deadline = o.deadline ?? new Date(NOW.getTime() + 3 * 86_400_000);
  const nonce = encodeVersionedNonce(o.salt ?? CONFIDENTIAL_INTENTS_SALT, o.nonceDeadline ?? deadline, new Uint8Array(15).fill(1));
  const message = JSON.stringify({
    deadline: deadline.toISOString(),
    intents: o.intents ?? [{ intent: "transfer", receiver_id: DEPOSIT, tokens: { [TOKEN]: amountIn } }],
    signer_id: o.signer ?? OWNER,
    ...o.extra,
  });
  return {
    intent: {
      standard: "nep413",
      payload: { recipient: o.recipient ?? CONFIDENTIAL_INTENTS_CONTRACT, nonce: base64.encode(nonce), message, ...(o.callbackUrl ? { callbackUrl: o.callbackUrl } : {}) },
    },
    correlationId: "gen-1",
  };
}

function setup(intent = generated(), opts: { registered?: boolean; submit?: (c: RecordedCall) => Response } = {}) {
  let lastQuote = {} as WireQuoteRequest;
  return testClient(
    (c) => {
      if (c.url.includes("/v0/quote")) lastQuote = c.body as WireQuoteRequest;
      if (c.url.includes("/v0/quote")) return json(quoteResponse(c.body as WireQuoteRequest, { depositAddress: DEPOSIT, amountIn: "254800", amountOut: "250000" }));
      if (c.url.includes("/v0/generate-intent")) return json(intent);
      if (c.url.includes("/v0/submit-intent")) return opts.submit ? opts.submit(c) : json({ intentHash: "IH1", correlationId: "sub-1" });
      if (c.url.includes("/v0/status")) {
        return json({
          correlationId: "s",
          quoteResponse: quoteResponse(lastQuote, { depositAddress: DEPOSIT, amountIn: "254800" }),
          status: "PROCESSING",
          updatedAt: NOW.toISOString(),
          swapDetails: { intentHashes: ["IH1"], nearTxHashes: [], originChainTxHashes: [], destinationChainTxHashes: [] },
        });
      }
      return json({}, 404);
    },
    { jwt: "partner", near: near(opts.registered ?? true) },
  );
}

const withdrawReq = () => privateWithdrawRequest({ asset: { assetId: BASE_USDC, amount: "250000" }, owner: OWNER, destination: FRESH, dry: false });

async function quoted(client: ReturnType<typeof setup>["client"]): Promise<Quote> {
  return client.getQuote(withdrawReq());
}

async function refusal(p: Promise<unknown>): Promise<IntentsError> {
  const e = await p.then(
    () => undefined,
    (x) => x,
  );
  expect(e).toBeInstanceOf(IntentsError);
  return e as IntentsError;
}

describe("prepareSignedIntent on intents.far", () => {
  it("accepts the live shape, signs it unchanged, and spends nothing", async () => {
    const { client, calls } = setup();
    const w = wallet();
    const p = await client.prepareSignedIntent(await quoted(client), w);

    expect(calls.some((c) => c.url.includes("/v0/submit-intent"))).toBe(false);
    expect(w.signed).toHaveLength(1);
    expect(w.signed[0]!.recipient).toBe("intents.far");
    expect(p.depositAddress).toBe(DEPOSIT);
    expect(p.signedData.payload.recipient).toBe("intents.far");
    expect(p.signedData.public_key).toBe(PK);
    expect(p.signedData.signature).toMatch(/^ed25519:/);
    expect(decodeVersionedNonce(base64.decode(p.signedData.payload.nonce)).salt).toBe(CONFIDENTIAL_INTENTS_SALT);
    expect(p.summary.transfers).toEqual([{ receiverId: DEPOSIT, tokenId: TOKEN, amount: "254800" }]);
    expect(p.quoteDeadline).toBe("2026-11-07T10:30:00.000Z");
    // A persisted PreparedIntent survives a JSON round trip.
    expect(JSON.parse(JSON.stringify(p))).toEqual(p);
  });

  it("asks approve with the checked summary before the wallet, and stops on no", async () => {
    const { client } = setup();
    const w = wallet();
    const seen: unknown[] = [];
    const e = await refusal(client.prepareSignedIntent(await quoted(client), w, { approve: (s) => (seen.push(s), false) }));
    expect(e.kind).toBe("signer_rejected");
    expect(seen).toHaveLength(1);
    expect(w.signed).toHaveLength(0);
  });

  const bad: [string, IntentOpts | (() => ReturnType<typeof generated>), RegExp][] = [
    ["the public contract", { recipient: "intents.near" }, /not intents\.far/],
    ["another contract", { recipient: "evil.near" }, /not intents\.far/],
    ["intents.near's salt", { salt: "252812b3" }, /salt 252812b3 is not intents\.far's salt e110f317/],
    ["someone else as signer", { signer: "mallory.near" }, /signer_id is mallory\.near/],
    ["a deadline in the past", { deadline: new Date(NOW.getTime() - 1000) }, /already passed/],
    ["a deadline beyond 7 days", { deadline: new Date(NOW.getTime() + 8 * 86_400_000) }, /more than 7 days/],
    ["a nonce deadline that differs", { nonceDeadline: new Date(NOW.getTime() + 86_400_000) }, /nonce deadline differs/],
    ["a callback URL", { callbackUrl: "https://x" }, /callback URL/],
    ["an extra message field", { extra: { referral: "x" } }, /unexpected message field "referral"/],
    ["a token_diff intent", { intents: [{ intent: "token_diff", diff: { [TOKEN]: "-1" } }] }, /intent kind "token_diff"/],
    ["a transfer to another receiver", { intents: [{ intent: "transfer", receiver_id: "mallory.near", tokens: { [TOKEN]: "1" } }] }, /not the quote deposit address/],
    ["the public token id", { intents: [{ intent: "transfer", receiver_id: DEPOSIT, tokens: { [BASE_USDC]: "254800" } }] }, /it spends nep141/],
    ["another asset", { intents: [{ intent: "transfer", receiver_id: DEPOSIT, tokens: { [confidentialTokenId("nep141:wrap.near")]: "1" } }] }, /it spends imt/],
    ["more than the quote", () => generated({}, "254801"), /more than the quoted 254800/],
    [
      "two transfers summing above the quote",
      { intents: [1, 2].map(() => ({ intent: "transfer", receiver_id: DEPOSIT, tokens: { [TOKEN]: "200000" } })) },
      /more than the quoted/,
    ],
    ["no intents", { intents: [] }, /contains no intents/],
    ["an unknown transfer field", { intents: [{ intent: "transfer", receiver_id: DEPOSIT, tokens: { [TOKEN]: "1" }, msg: "x" }] }, /unexpected transfer field "msg"/],
  ];

  for (const [name, o, why] of bad) {
    it(`refuses ${name} before the wallet is asked`, async () => {
      const { client } = setup(typeof o === "function" ? o() : generated(o));
      const w = wallet();
      const e = await refusal(client.prepareSignedIntent(await quoted(client), w));
      expect(e.kind).toBe("intent_mismatch");
      expect(e.message).toMatch(why);
      expect(w.signed).toHaveLength(0);
    });
  }

  it("refuses a wallet signature that does not verify", async () => {
    const { client } = setup();
    const w = wallet();
    const forged: Nep413Signer = { accountId: OWNER, sign: async (p) => ({ ...(await w.sign(p)), signature: base64.encode(new Uint8Array(64)) }) };
    const e = await refusal(client.prepareSignedIntent(await quoted(client), forged));
    expect(e.kind).not.toBe("intent_mismatch");
  });

  it("refuses a key that is not registered for the owner", async () => {
    const { client } = setup(generated(), { registered: false });
    const e = await refusal(client.prepareSignedIntent(await quoted(client), wallet()));
    expect(e.kind).toBe("key_not_registered");
  });

  it("refuses a dry quote and a quote refunding elsewhere", async () => {
    const { client } = setup();
    const dry = await client.getQuote({ ...withdrawReq(), dry: true });
    expect((await refusal(client.prepareSignedIntent(dry, wallet()))).kind).toBe("not_fundable");
    const q = await quoted(client);
    expect((await refusal(client.prepareSignedIntent(q, wallet("mallory.near")))).message).toMatch(/refunds to a different account/);
  });
});

describe("submitSignedIntent", () => {
  it("submits exactly the persisted signed data, and can submit it again", async () => {
    const { client, calls } = setup();
    const p = await client.prepareSignedIntent(await quoted(client), wallet());
    const stored = JSON.parse(JSON.stringify(p));
    const a = await client.submitSignedIntent(stored);
    const b = await client.submitSignedIntent(stored);
    expect(a).toEqual({ intentHash: "IH1", correlationId: "sub-1" });
    expect(b).toEqual(a);
    const subs = calls.filter((c) => c.url.includes("/v0/submit-intent"));
    expect(subs).toHaveLength(2);
    expect(subs[0]!.body).toEqual({ type: "swap_transfer", signedData: p.signedData });
    expect(subs[1]!.body).toEqual(subs[0]!.body);
  });

  it("is never retried automatically", async () => {
    const { client, calls } = setup(generated(), { submit: () => json({ message: "boom" }, 503) });
    const p = await client.prepareSignedIntent(await quoted(client), wallet());
    await refusal(client.submitSignedIntent(p));
    expect(calls.filter((c) => c.url.includes("/v0/submit-intent"))).toHaveLength(1);
  });

  it("needs the partner key, and sends nothing without it", async () => {
    let fetched = 0;
    const { createIntentsClient } = await import("../src/client.js");
    const c = createIntentsClient({ fetch: async () => (fetched++, new Response("{}")), now: () => NOW });
    const e = await refusal(c.submitSignedIntent({} as never));
    expect(e.kind).toBe("partner_auth_required");
    expect(fetched).toBe(0);
  });
});

describe("fundBurner", () => {
  it("quotes EXACT_OUTPUT into the burner, paid from another balance asset, then checks, signs and submits", async () => {
    const { fundBurner } = await import("../src/index.js");
    const { BASE_ETH } = await import("./helpers.js");
    const { client, calls } = setup();
    const w = wallet();
    const r = await fundBurner({
      client,
      burnerAddress: FRESH,
      amount: { assetId: BASE_ETH, amount: "2000000000000" },
      payWithAssetId: BASE_USDC,
      signer: w,
    });
    const q = calls.find((c) => c.url.includes("/v0/quote"))!.body as WireQuoteRequest;
    expect(q).toMatchObject({
      dry: false,
      swapType: "EXACT_OUTPUT",
      originAsset: BASE_USDC,
      destinationAsset: BASE_ETH,
      depositType: "CONFIDENTIAL_INTENTS",
      recipient: FRESH,
      recipientType: "DESTINATION_CHAIN",
      refundTo: OWNER,
      refundType: "CONFIDENTIAL_INTENTS",
      confidentiality: "advanced",
    });
    expect(w.signed).toHaveLength(1);
    expect(r.intentHash).toBe("IH1");
    expect(r.summary.transfers[0]!.tokenId).toBe(TOKEN);
  });
});

describe("checkGeneratedIntent for public INTENTS balances", () => {
  it("expects intents.near, its live salt and the public token id", async () => {
    const { client } = setup();
    const q = await quoted(client);
    const deadline = new Date(NOW.getTime() + 60_000);
    const payload: Nep413Payload = {
      recipient: "intents.near",
      nonce: encodeVersionedNonce("252812b3", deadline, new Uint8Array(15)),
      message: JSON.stringify({ deadline: deadline.toISOString(), intents: [{ intent: "transfer", receiver_id: DEPOSIT, tokens: { [BASE_USDC]: "1" } }], signer_id: OWNER }),
    };
    const s = checkGeneratedIntent(payload, q, OWNER, { contract: "intents.near", salt: "252812b3", tokenId: BASE_USDC }, NOW);
    expect(s.transfers[0]!.tokenId).toBe(BASE_USDC);
    expect(() => checkGeneratedIntent(payload, q, OWNER, { contract: "intents.far", salt: CONFIDENTIAL_INTENTS_SALT, tokenId: TOKEN }, NOW)).toThrow(/not intents\.far/);
  });
});
