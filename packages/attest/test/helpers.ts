import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  fromHex,
  type AttestationResponse,
  type QuoteMeasurements,
} from "../src/index";

export interface RecordedFixture {
  description: string;
  model: string;
  clientNonce: string;
  response: AttestationResponse;
  quoteExpectations: Record<
    string,
    {
      status: string;
      advisoryIds: string[];
      tdAttributes: string;
      reportData: string;
      mrConfigId: string;
      rtMr3: string;
    }
  >;
}

export function loadFixture(name: string): RecordedFixture {
  const path = fileURLToPath(
    new URL(`../fixtures/${name}.json`, import.meta.url),
  );
  return JSON.parse(readFileSync(path, "utf8")) as RecordedFixture;
}

/**
 * Test double for the DCAP quote verifier: returns the "verified quote"
 * measurements recorded in the fixture instead of verifying real Intel
 * evidence. Everything downstream (nonce binding, RTMR3 replay, app_compose)
 * still runs the real check logic.
 */
export function fixtureQuoteVerifier(fixture: RecordedFixture) {
  return async (intelQuoteHex: string): Promise<QuoteMeasurements> => {
    const e = fixture.quoteExpectations[intelQuoteHex.toLowerCase()];
    if (!e) throw new Error(`no recorded quote for ${intelQuoteHex.slice(0, 20)}…`);
    return {
      status: e.status,
      advisoryIds: e.advisoryIds,
      tdAttributes: fromHex(e.tdAttributes),
      reportData: fromHex(e.reportData),
      mrConfigId: fromHex(e.mrConfigId),
      rtMr3: fromHex(e.rtMr3),
    };
  };
}

export const checkNamed = (
  checks: { name: string; ok: boolean }[],
  name: string,
) => checks.find((c) => c.name === name);
