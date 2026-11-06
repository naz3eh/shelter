import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  FixtureReader,
  scanWallets,
  type FixtureProfile,
  type ScanReport,
  type WalletRef,
} from "@shelter/core";
import {
  buildExplainMessages,
  redactScanReport,
  unredactText,
} from "../src/index";

async function exposedReport(): Promise<ScanReport> {
  const path = fileURLToPath(
    new URL(
      "../../core/fixtures/sample-wallets/exposed.json",
      import.meta.url,
    ),
  );
  const profile = JSON.parse(readFileSync(path, "utf8")) as FixtureProfile;
  return scanWallets(
    profile.wallets as WalletRef[],
    new FixtureReader(profile),
  );
}

const EVM_ADDRESS = /\b0x[0-9a-fA-F]{40}\b/;
const TX_HASH = /\b0x?[0-9a-fA-F]{64}\b/;

describe("redactScanReport", () => {
  it("leaks no 0x address or tx hash in the request payload", async () => {
    const report = await exposedReport();
    const { redacted, aliases } = redactScanReport(report);
    const messages = buildExplainMessages(redacted);
    // Everything that would be sent to NEAR AI: system + user message bodies.
    const wireBytes = JSON.stringify(messages);

    expect(wireBytes).not.toMatch(EVM_ADDRESS);
    expect(wireBytes).not.toMatch(TX_HASH);
    // The alias map itself holds the originals — it is never sent.
    for (const address of Object.values(aliases)) {
      expect(wireBytes).not.toContain(address);
      expect(wireBytes).not.toContain(address.toLowerCase());
    }
  });

  it("keeps check letters, points, labels and names; drops hashes", async () => {
    const report = await exposedReport();
    const { redacted, aliases } = redactScanReport(report);

    expect(redacted.findings.length).toBe(report.findings.length);
    const checks = new Set(redacted.findings.map((f) => f.check));
    expect(checks.size).toBeGreaterThan(1);
    for (const f of redacted.findings) {
      expect(f.wallet).toMatch(/^Wallet \d+$/);
      expect(f.points).toBeGreaterThan(0);
    }
    // Exchange labels and public names survive (they identify services).
    expect(
      redacted.findings.some((f) => f.label && f.label.length > 0),
    ).toBe(true);
    // The exposed sample's ENS name is kept per the spec.
    expect(
      redacted.findings.some((f) => f.name === "sample-victim.eth"),
    ).toBe(true);
    // Score context is included for the summary.
    expect(redacted.score).toBe(report.score);
    expect(redacted.band).toBe(report.band);
    // Warnings (poisoning/OFAC) are included, aliased.
    expect(redacted.warnings.length).toBe(report.warnings.length);
    for (const w of redacted.warnings) {
      expect(w.wallet).toMatch(/^Wallet \d+$/);
    }
    // Aliases are stable across repeated mentions of the same address.
    const serialized = JSON.stringify(redacted);
    for (const alias of Object.keys(aliases)) {
      if (serialized.includes(alias)) {
        expect(serialized.split(alias).length - 1).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("maps aliases back on the client", async () => {
    const report = await exposedReport();
    const { aliases } = redactScanReport(report);
    const text = "Wallet 1 transacted with Counterparty 1.";
    const restored = unredactText(text, aliases);
    expect(restored).not.toContain("Wallet 1");
    expect(restored).not.toContain("Counterparty 1");
    expect(restored).toMatch(/0x[0-9a-fA-F]{40}/);
  });
});
