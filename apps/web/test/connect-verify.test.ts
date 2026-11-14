import { describe, expect, it } from "vitest";
import fixtureJson from "../lib/fixtures/connect-recording.json";
import { ReplaySource, type ConnectRecordingFile } from "../lib/connect-source";
import { verifySession } from "../lib/connect-verify";

async function checksFor(recording: unknown) {
  const src = ReplaySource.fromJson(recording);
  const [account] = await src.listAccounts();
  const view = await src.getAccount(account!.id);
  return verifySession(view!);
}

describe("verifySession marks come from the recording", () => {
  it("verifies the real recording: 1Click quotes against 1Click's own key", async () => {
    const checks = await checksFor(fixtureJson);
    expect(checks.length).toBeGreaterThan(10);
    // The fixture is the real 2026-11-12 run: every quote signature must
    // verify against 1Click's published key, never a key the file carries.
    const quotes = checks.filter((c) => c.id.endsWith("-q"));
    expect(quotes.length).toBe(4);
    expect(quotes.every((c) => c.status === "pass")).toBe(true);
    expect(checks.filter((c) => c.status === "fail")).toEqual([]);
    // Spot-check the headline categories exist.
    const ids = checks.map((c) => c.id);
    expect(ids.some((i) => i.includes("-sig"))).toBe(true); // NEP-413 / request signatures
    expect(ids.some((i) => i.includes("-hash"))).toBe(true); // tx hash = keccak of signed bytes
    expect(ids.some((i) => i.includes("-block"))).toBe(true); // recorded block
    // NEP-413 checks say honestly that the signature matches the recorded key.
    expect(checks.some((c) => c.label.includes("matches the recorded key"))).toBe(true);
  });

  it("flips to fail when the recorded block findings are stripped", async () => {
    const tampered = JSON.parse(JSON.stringify(fixtureJson)) as ConnectRecordingFile;
    const req4 = tampered.connect![0]!.account.requests.find((r) => r.seq === 4)!;
    // The blocked send keeps no params in this recording, so its check reads
    // the recorded findings: removing the block-level ones must fail it.
    req4.findings = req4.findings.filter((f) => f.level !== "block");

    const checks = await checksFor(tampered);
    expect(checks.find((c) => c.id === "4-block")!.status).toBe("fail");
    // Nothing was ever signed for it — that stays true.
    expect(checks.find((c) => c.id === "4-unsigned")!.status).toBe("pass");
  });

  it("flips to fail when a signed transaction is corrupted", async () => {
    const tampered = JSON.parse(JSON.stringify(fixtureJson)) as ConnectRecordingFile;
    const req1 = tampered.connect![0]!.account.requests.find((r) => r.seq === 1)!;
    req1.tx!.raw = req1.tx!.raw.replace(/^0x/, "0x00") as `0x${string}`;

    const checks = await checksFor(tampered);
    expect(checks.find((c) => c.id === "1-tx-hash")!.status).toBe("fail");
    expect(checks.find((c) => c.id === "1-tx-sender")!.status).toBe("fail");
  });
});
