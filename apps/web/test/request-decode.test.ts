import { describe, expect, it } from "vitest";
import { parseRequest } from "@shelter/connect";
import fixtureJson from "../lib/fixtures/connect-recording.json";
import { ReplaySource, type ConnectRecordingFile } from "../lib/connect-source";
import { decodeDappRequest, requestListLabel } from "../lib/request-decode";

const recording = fixtureJson as unknown as ConnectRecordingFile;
const account = recording.connect![0]!.account;

function decode(seq: number) {
  const r = account.requests.find((x) => x.seq === seq)!;
  return decodeDappRequest(parseRequest(r.method, r.params as unknown[]));
}

function label(seq: number) {
  const r = account.requests.find((x) => x.seq === seq)!;
  return requestListLabel(r);
}

describe("decodeDappRequest", () => {
  it("decodes the recorded unlimited USDC approval", () => {
    const d = decode(1);
    expect(d.method).toBe("eth_sendTransaction");
    expect(d.fields).toContainEqual(expect.objectContaining({ label: "Action", value: "Approve tokens" }));
    expect(d.fields).toContainEqual(expect.objectContaining({ label: "Allowance", value: "Unlimited", warn: true }));
    expect(d.fields.some((f) => f.label === "Spender" && f.value.includes("Permit2"))).toBe(true);
    expect(d.warnings.join(" ")).toMatch(/unlimited/i);
  });

  it("decodes the recorded Uniswap contract call", () => {
    const d = decode(3);
    expect(d.fields).toContainEqual(expect.objectContaining({ label: "Action", value: "Contract call" }));
    expect(d.fields.some((f) => f.label === "Contract" && f.value.includes("Uniswap"))).toBe(true);
    expect(d.warnings).toHaveLength(0);
  });

  it("labels the blocked send from the recorded summary, addresses shortened", () => {
    // The blocked request was never sent, so the recording keeps no params;
    // the list label falls back to the engine's summary with short addresses.
    const l = label(4);
    expect(l).toContain("100000 base units");
    expect(l).toMatch(/0x3292…D488/i);
    expect(l).not.toMatch(/0x[0-9a-fA-F]{30,}/);
  });

  it("gives list labels with contract names instead of raw hex", () => {
    expect(decode(1).listLabel).toContain("Permit2");
    expect(decode(1).listLabel).toContain("unlimited");
    expect(decode(3).listLabel).toContain("Uniswap Universal Router");
    expect(label(2)).toContain("PermitSingle");
    expect(label(2)).toContain("Permit2");
    for (const seq of [1, 2, 3, 4]) {
      expect(label(seq)).not.toMatch(/0x[0-9a-fA-F]{30,}/);
    }
  });
});

describe("ReplaySource", () => {
  it("serves the recorded account read-only", async () => {
    const src = ReplaySource.fromJson(fixtureJson);
    expect(src.mode).toBe("replay");
    const accounts = await src.listAccounts();
    expect(accounts).toHaveLength(1);
    const view = await src.getAccount(accounts[0]!.id);
    expect(view?.account.dapp.origin).toBe("https://app.uniswap.org");
    expect(view?.account.requests.map((r) => r.decision)).toEqual(["sent", "signed", "sent", "blocked"]);
    await expect(src.decide(accounts[0]!.id, 4, true)).rejects.toThrow(/read-only/);
  });

  it("rejects malformed recordings", () => {
    expect(() => ReplaySource.fromJson({ format: "nope" })).toThrow(/not a shelter demo recording/);
  });
});
