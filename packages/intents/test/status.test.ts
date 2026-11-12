import { describe, expect, it } from "vitest";
import { IntentsError } from "../src/errors.js";
import { isTerminalStatus } from "../src/status.js";
import type { WireQuoteRequest } from "../src/wire.js";
import { BASE_USDC, json, OWNER, quoteResponse, testClient } from "./helpers.js";

const DEPOSIT_ADDRESS = "0x3333333333333333333333333333333333333333";

const sentDeposit: WireQuoteRequest = {
  dry: false,
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
};

function statusBody(status: string, details: Record<string, unknown> = {}, quoteResponseOverride?: unknown) {
  return {
    correlationId: "corr-status",
    quoteResponse: quoteResponseOverride ?? quoteResponse(sentDeposit),
    status,
    updatedAt: "2026-11-07T10:05:00.000Z",
    swapDetails: {
      intentHashes: [],
      nearTxHashes: [],
      originChainTxHashes: [],
      destinationChainTxHashes: [],
      ...details,
    },
  };
}

describe("status", () => {
  it.each(["PENDING_DEPOSIT", "KNOWN_DEPOSIT_TX", "PROCESSING", "SUCCESS", "INCOMPLETE_DEPOSIT", "REFUNDED", "FAILED"])(
    "maps %s unchanged",
    async (s) => {
      const { client } = testClient(() => json(statusBody(s)));
      const r = await client.status(DEPOSIT_ADDRESS);
      expect(r.status).toBe(s);
      expect(r.rawStatus).toBe(s);
    },
  );

  it("surfaces a new state as UNKNOWN, never as success", async () => {
    const { client } = testClient(() => json(statusBody("SETTLING_SOMEWHERE_NEW")));
    const r = await client.status(DEPOSIT_ADDRESS);
    expect(r.status).toBe("UNKNOWN");
    expect(r.rawStatus).toBe("SETTLING_SOMEWHERE_NEW");
    expect(isTerminalStatus(r.status)).toBe(false);
  });

  it("collects chain-qualified hashes and settled amounts", async () => {
    const { client } = testClient(() =>
      json(
        statusBody("SUCCESS", {
          intentHashes: ["intent1"],
          nearTxHashes: ["nearTx1"],
          originChainTxHashes: [{ hash: "0xorigin", explorerUrl: "https://basescan.org/tx/0xorigin" }],
          destinationChainTxHashes: [{ hash: "0xdest", explorerUrl: "https://basescan.org/tx/0xdest" }],
          amountIn: "1000000",
          amountOut: "999000",
          depositedAmount: "1000000",
        }),
      ),
    );
    const r = await client.status(DEPOSIT_ADDRESS);
    expect(r.txHashes).toEqual(["0xorigin", "0xdest", "nearTx1"]);
    expect(r.originChainTxs[0]!.explorerUrl).toContain("basescan");
    expect(r.amountOut).toBe("999000");
    expect(r.quoteVerified).toBe(true);
  });

  it("reports refunds with amount and reason", async () => {
    const { client } = testClient(() => json(statusBody("REFUNDED", { refundedAmount: "1000000", refundReason: "deadline" })));
    const r = await client.status(DEPOSIT_ADDRESS);
    expect(r.refundedAmount).toBe("1000000");
    expect(r.refundReason).toBe("deadline");
    expect(isTerminalStatus(r.status)).toBe(true);
  });

  it("still returns status when the embedded quote does not verify, but flags it", async () => {
    const { client } = testClient(() => json(statusBody("PROCESSING", {}, { not: "a quote" })));
    const r = await client.status(DEPOSIT_ADDRESS);
    expect(r.status).toBe("PROCESSING");
    expect(r.quoteVerified).toBe(false);
  });

  it("flags an embedded quote for a different deposit address", async () => {
    const { client } = testClient(() => json(statusBody("PROCESSING")));
    const r = await client.status("0x9999999999999999999999999999999999999999");
    expect(r.quoteVerified).toBe(false);
  });

  it("passes the deposit memo and maps 404 to not_found", async () => {
    const { client, calls } = testClient(() => json({ message: "Deposit address not found" }, 404));
    await expect(client.status(DEPOSIT_ADDRESS, { depositMemo: "m1" })).rejects.toMatchObject({ kind: "not_found" });
    expect(calls.at(-1)!.url).toContain("depositMemo=m1");
  });

  it("rejects malformed status bodies and empty deposit addresses", async () => {
    const { client } = testClient(() => json({ status: "SUCCESS" }));
    await expect(client.status(DEPOSIT_ADDRESS)).rejects.toMatchObject({ kind: "malformed_response" });
    await expect(client.status(" ")).rejects.toBeInstanceOf(IntentsError);
  });
});
