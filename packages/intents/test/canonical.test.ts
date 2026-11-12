import stableStringify from "json-stable-stringify";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/canonical.js";
import type { WireQuoteRequest } from "../src/wire.js";
import { BASE_USDC, FRESH, OWNER, quoteResponse } from "./helpers.js";

const sent: WireQuoteRequest = {
  dry: false,
  swapType: "EXACT_INPUT",
  slippageTolerance: 50,
  originAsset: BASE_USDC,
  depositType: "ORIGIN_CHAIN",
  destinationAsset: BASE_USDC,
  amount: "1000000",
  refundTo: OWNER,
  refundType: "CONFIDENTIAL_INTENTS",
  recipient: FRESH,
  recipientType: "CONFIDENTIAL_INTENTS",
  deadline: "2026-11-07T10:30:00.000Z",
  confidentiality: "advanced",
};

const cases: [string, unknown][] = [
  ["primitives", [null, true, false, 0, -1.5, 1e21, "", "a\"b\\c\n ", "ünï"]],
  ["undefined members dropped, array holes become null", { a: undefined, b: [undefined, () => 1, 2], c: () => 1 }],
  ["nested key order", { z: { y: 1, b: [{ d: 1, c: 2 }] }, a: { k: "v", A: "upper", _: 0, "10": 1, "9": 2 } }],
  ["toJSON honoured", { when: new Date("2026-11-07T10:00:00.000Z"), x: { toJSON: () => ({ b: 1, a: 2 }) } }],
  ["non-finite numbers", { nan: Number.NaN, inf: Number.POSITIVE_INFINITY }],
  ["empty containers", { a: {}, b: [], c: [{}] }],
  ["dry quote response", quoteResponse({ ...sent, dry: true })],
  ["execution quote response", quoteResponse(sent)],
];

describe("canonicalJson matches json-stable-stringify (the SDK's serializer)", () => {
  it.each(cases)("%s", (_name, value) => {
    expect(canonicalJson(value)).toBe(stableStringify(value));
  });

  it("returns undefined where JSON would", () => {
    expect(canonicalJson(undefined)).toBe(stableStringify(undefined));
    expect(canonicalJson(() => 1)).toBe(undefined);
  });

  it("throws on cycles but allows repeated, non-circular references", () => {
    const shared = { k: 1 };
    expect(canonicalJson({ a: shared, b: shared })).toBe(stableStringify({ a: shared, b: shared }));
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(() => canonicalJson(loop)).toThrow(TypeError);
  });
});
