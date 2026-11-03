import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  FixtureAccount,
  FixtureProfile,
} from "../src/reader/fixture.js";
import type { TxRecord } from "../src/reader/types.js";
import { scanWallets, type ScanReport } from "../src/exposure/engine.js";
import { FixtureReader } from "../src/reader/fixture.js";

/** Deterministic fake address from a single hex character, e.g. a(1). */
export const a = (n: number) =>
  `0x${n.toString(16).repeat(40)}` as string;

export const a2 = (n: number) => `0x${n.toString(16).padStart(40, "f")}`;

const readJson = (rel: string) =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"),
  ) as never;

const exchangeChains = (
  readJson("../data/exchange-labels.json") as {
    chains: Record<string, Record<string, string>>;
  }
).chains;
export const EXCHANGE_ADDR = Object.entries(exchangeChains["ethereum"]!).find(
  ([, l]) => l === "coinbase",
)![0]!;
export const OFAC_ADDR = (
  readJson("../data/ofac-sanctioned.json") as { addresses: string[] }
).addresses[0]!;

export const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
export const eth = (n: number) =>
  (BigInt(Math.round(n * 1000)) * 10n ** 15n).toString();
export const T = 1760558400; // 2026-10-15T14:00:00Z

export function tx(
  from: string,
  to: string | null,
  valueWei: string,
  timestamp: number,
  n: number,
  chain = "ethereum",
): TxRecord {
  return {
    hash: hash(n),
    chain,
    from: from.toLowerCase(),
    to: to?.toLowerCase() ?? null,
    valueWei,
    timestamp,
  };
}

export function profile(
  accounts: Record<string, FixtureAccount>,
  extra?: Partial<FixtureProfile>,
): FixtureProfile {
  return {
    name: "test",
    wallets: Object.entries(accounts).map(([address, acc]) => ({
      chain: acc.chain,
      address,
    })),
    accounts,
    ...extra,
  };
}

export function scan(p: FixtureProfile): Promise<ScanReport> {
  return scanWallets(p.wallets, new FixtureReader(p));
}

export const checks = (r: ScanReport, wallet?: string) =>
  new Set(
    r.findings
      .filter((f) => !wallet || f.wallet === wallet.toLowerCase())
      .map((f) => f.check),
  );
