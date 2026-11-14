import { describe, expect, it } from "vitest";
import { parseRequest } from "@shelter/connect";
import fixtureJson from "../lib/fixtures/connect-recording.json";
import { ReplaySource, type ConnectRecordingFile } from "../lib/connect-source";
import { decodeDappRequest } from "../lib/request-decode";

const recording = fixtureJson as unknown as ConnectRecordingFile;
const account = recording.connect![0]!.account;

function decode(seq: number) {
  const r = account.requests.find((x) => x.seq === seq)!;
  return decodeDappRequest(parseRequest(r.method, r.params as unknown[]));
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
    const d = decode(2);
    expect(d.fields).toContainEqual(expect.objectContaining({ label: "Action", value: "Contract call" }));
    expect(d.fields.some((f) => f.label === "Contract" && f.value.includes("Uniswap"))).toBe(true);
    expect(d.warnings).toHaveLength(0);
  });

  it("decodes the blocked 0.1 USDC send with token symbol and recipient", () => {
    const d = decode(3);
    expect(d.fields).toContainEqual(expect.objectContaining({ label: "Action", value: "Send tokens" }));
    expect(d.fields).toContainEqual(expect.objectContaining({ label: "Amount", value: expect.stringContaining("0.1") }));
    expect(d.fields).toContainEqual(expect.objectContaining({ label: "Amount", value: expect.stringContaining("USDC") }));
    expect(d.fields).toContainEqual(
      expect.objectContaining({ label: "Recipient", value: expect.stringMatching(/^0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4}$/) }),
    );
  });

  it("gives list labels with contract names instead of raw hex", () => {
    expect(decode(1).listLabel).toContain("Permit2");
    expect(decode(1).listLabel).toContain("unlimited");
    expect(decode(2).listLabel).toContain("Uniswap Universal Router");
    expect(decode(3).listLabel).toContain("USDC");
    for (const seq of [1, 2, 3]) {
      expect(decode(seq).listLabel).not.toMatch(/0x[0-9a-fA-F]{30,}/);
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
    expect(view?.account.requests.map((r) => r.decision)).toEqual(["sent", "sent", "blocked"]);
    await expect(src.decide(accounts[0]!.id, 3, true)).rejects.toThrow(/read-only/);
  });

  it("rejects malformed recordings", () => {
    expect(() => ReplaySource.fromJson({ format: "nope" })).toThrow(/not a shelter demo recording/);
  });
});
