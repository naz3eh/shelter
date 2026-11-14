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
  it("verifies 1Click quotes against 1Click's own key, not the fixture's", async () => {
    const checks = await checksFor(fixtureJson);
    expect(checks.length).toBeGreaterThan(10);
    // The shipped fixture was self-signed; until it is rebuilt from the real
    // recording these quote checks must fail — the panel may not vouch for
    // signatures it cannot verify against 1Click's published key.
    const quotes = checks.filter((c) => c.id.endsWith("-q"));
    expect(quotes.length).toBeGreaterThan(0);
    expect(quotes.every((c) => c.status === "fail")).toBe(true);
    const others = checks.filter((c) => !c.id.endsWith("-q"));
    expect(others.filter((c) => c.status === "fail")).toEqual([]);
    // Spot-check the headline categories exist.
    const ids = checks.map((c) => c.id);
    expect(ids.some((i) => i.includes("-sig"))).toBe(true); // NEP-413 / request signatures
    expect(ids.some((i) => i.includes("-hash"))).toBe(true); // tx hash = keccak of signed bytes
    expect(ids.some((i) => i.includes("-block"))).toBe(true); // linkage re-check
  });

  it("flips to fail when the recording is tampered with", async () => {
    const tampered = JSON.parse(JSON.stringify(fixtureJson)) as ConnectRecordingFile;
    const req3 = tampered.connect![0]!.account.requests.find((r) => r.seq === 3)!;
    // Rewrite the blocked transfer so its calldata no longer names a linked
    // wallet: the recorded block finding stays, but the re-check must fail.
    const params = req3.params as { data: string }[];
    params[0]!.data =
      "0xa9059cbb0000000000000000000000001111111111111111111111111111111111111111" +
      "00000000000000000000000000000000000000000000000000000000000186a0";

    const checks = await checksFor(tampered);
    const blockCheck = checks.find((c) => c.id === "3-block")!;
    expect(blockCheck.status).toBe("fail");
  });

  it("flips to fail when a signed transaction is corrupted", async () => {
    const tampered = JSON.parse(JSON.stringify(fixtureJson)) as ConnectRecordingFile;
    const req1 = tampered.connect![0]!.account.requests.find((r) => r.seq === 1)!;
    req1.tx!.raw = req1.tx!.raw.replace(/^0x/, "0x00") as `0x${string}`;

    const checks = await checksFor(tampered);
    expect(checks.find((c) => c.id === "1-tx-hash")!.status).toBe("fail");
  });
});
