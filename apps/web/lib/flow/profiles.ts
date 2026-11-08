/**
 * Bundled fictional sample profiles. These are the same recorded fixtures the
 * CLI scans (`packages/core/fixtures/sample-wallets/*.json`), imported as
 * JSON so the browser computes reports with the real core engine and no
 * filesystem or network access.
 */

import type { FixtureProfile, WalletRef } from "@shelter/core";
import exposedJson from "../../../../packages/core/fixtures/sample-wallets/exposed.json";
import mediumJson from "../../../../packages/core/fixtures/sample-wallets/medium.json";
import cleanJson from "../../../../packages/core/fixtures/sample-wallets/clean.json";
import type { SampleId } from "./types";

export interface SampleProfile {
  id: SampleId;
  /** Short card title. */
  title: string;
  /** What the recorded history contains, in plain words. */
  blurb: string;
  profile: FixtureProfile;
}

const asProfile = (json: unknown): FixtureProfile =>
  json as FixtureProfile;

export const SAMPLE_PROFILES: Record<SampleId, SampleProfile> = {
  exposed: {
    id: "exposed",
    title: "Exposed pair",
    blurb:
      "Two linked Ethereum wallets with exchange, name, funding and timing links — fires every check plus both warnings.",
    profile: asProfile(exposedJson),
  },
  medium: {
    id: "medium",
    title: "Medium exposure",
    blurb:
      "An Ethereum and a Base wallet sharing a destination, with a public key already exposed.",
    profile: asProfile(mediumJson),
  },
  clean: {
    id: "clean",
    title: "Clean",
    blurb:
      "A single fresh Base wallet with one incoming transfer and no detected links in this data.",
    profile: asProfile(cleanJson),
  },
};

export function sampleWallets(profile: FixtureProfile): WalletRef[] {
  return profile.wallets as WalletRef[];
}
