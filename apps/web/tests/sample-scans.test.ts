import { describe, expect, it } from "vitest";
import { FixtureReader, scanWallets, type CheckId, type WalletRef } from "@shelter/core";
import { SAMPLE_PROFILES, sampleWallets } from "@/lib/flow/profiles";
import type { SampleId } from "@/lib/flow/types";

/**
 * Guards the UI's headline numbers: they must come from the real engine over
 * the bundled fixtures — a regression here means the screens would lie.
 */
describe("sample profiles through the real scanner", () => {
  it.each([
    ["exposed", 98.5, "doxxed", 2],
    ["medium", 21.5, "linkable", 2],
    ["clean", 0, "clean", 0],
  ] as [SampleId, number, string, number][])(
    "%s scores %s (%s)",
    async (id, score, band, linked) => {
      const sample = SAMPLE_PROFILES[id];
      const report = await scanWallets(
        sampleWallets(sample.profile) as WalletRef[],
        new FixtureReader(sample.profile),
      );
      expect(report.score).toBe(score);
      expect(report.band).toBe(band);
      expect(report.linkedAddressCount).toBe(linked);
    },
  );

  it("exposed fires every check A–I plus both warnings", async () => {
    const sample = SAMPLE_PROFILES.exposed;
    const report = await scanWallets(
      sampleWallets(sample.profile) as WalletRef[],
      new FixtureReader(sample.profile),
    );
    const checks = new Set<CheckId>(report.findings.map((f) => f.check));
    for (const c of ["A", "B", "C", "D", "E", "F", "G", "H", "I"] as const) {
      expect(checks.has(c), `missing check ${c}`).toBe(true);
    }
    expect(report.warnings.map((w) => w.kind).sort()).toEqual([
      "address-poisoning",
      "sanctioned-counterparty",
    ]);
    // A/B identity findings propagate to the linked second wallet.
    const inherited = report.findings.filter((f) =>
      f.detail.startsWith("inherited:"),
    );
    expect(inherited.length).toBeGreaterThan(0);
  });

  it("medium shows D/F/H and no warnings", async () => {
    const sample = SAMPLE_PROFILES.medium;
    const report = await scanWallets(
      sampleWallets(sample.profile) as WalletRef[],
      new FixtureReader(sample.profile),
    );
    const checks = new Set(report.findings.map((f) => f.check));
    expect([...checks].sort()).toEqual(["D", "F", "H"]);
    expect(report.warnings).toHaveLength(0);
  });

  it("clean has zero findings and zero warnings", async () => {
    const sample = SAMPLE_PROFILES.clean;
    const report = await scanWallets(
      sampleWallets(sample.profile) as WalletRef[],
      new FixtureReader(sample.profile),
    );
    expect(report.findings).toHaveLength(0);
    expect(report.warnings).toHaveLength(0);
    expect(report.score).toBe(0);
  });
});
