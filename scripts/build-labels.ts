/**
 * Builds the static label sets bundled in packages/core/data/.
 *
 * Sources:
 *  - dawsbot/eth-labels (MIT): data/json/accounts.json at the pinned commit.
 *    We keep only entries whose label is a known exchange, on Ethereum (1)
 *    and Base (8453).
 *  - 0xB10C/ofac-sanctioned-digital-currency-addresses (MIT): the generated
 *    `lists` branch, sanctioned_addresses_ETH.json.
 *
 * Run: pnpm --filter @shelter/cli exec tsx ../../scripts/build-labels.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ETH_LABELS_REF = "d9b21aefeded56f7fce7208d6fa173d128526c1b";
const OFAC_REF = "abad1e7bc0956b89211f8eaa28a4fc795188738d";

const ETH_LABELS_URL = `https://raw.githubusercontent.com/dawsbot/eth-labels/${ETH_LABELS_REF}/data/json/accounts.json`;
const OFAC_URL = `https://raw.githubusercontent.com/0xB10C/ofac-sanctioned-digital-currency-addresses/${OFAC_REF}/sanctioned_addresses_ETH.json`;

/** Exact-match allowlist of eth-labels `label` values that mean "centralized exchange". */
const EXCHANGE_LABELS = new Set([
  "exchange",
  "binance",
  "binance-charity",
  "bitfinex",
  "bitget",
  "bitstamp",
  "bittrex",
  "bybit",
  "cex-io",
  "coinbase",
  "crypto-com",
  "ftx",
  "gate",
  "gate-io",
  "gemini",
  "htx",
  "huobi",
  "kraken",
  "kucoin",
  "mexc",
  "okx",
  "poloniex",
  "upbit",
]);

const CHAIN_NAMES: Record<number, string> = { 1: "ethereum", 8453: "base" };

interface LabelEntry {
  address: string;
  chainId: number;
  label: string;
  nameTag?: string;
}

async function main() {
  const outDir = fileURLToPath(new URL("../packages/core/data/", import.meta.url));
  mkdirSync(outDir, { recursive: true });

  const accounts = (await (await fetch(ETH_LABELS_URL)).json()) as LabelEntry[];
  const exchanges: Record<string, Record<string, string>> = { ethereum: {}, base: {} };
  for (const e of accounts) {
    const chain = CHAIN_NAMES[e.chainId];
    if (!chain || !EXCHANGE_LABELS.has(e.label)) continue;
    exchanges[chain]![e.address.toLowerCase()] = e.label;
  }

  writeFileSync(
    `${outDir}exchange-labels.json`,
    JSON.stringify(
      {
        source: "https://github.com/dawsbot/eth-labels",
        license: "MIT",
        commit: ETH_LABELS_REF,
        chains: exchanges,
      },
      null,
      2,
    ) + "\n",
  );

  const ofac = (await (await fetch(OFAC_URL)).json()) as string[];
  writeFileSync(
    `${outDir}ofac-sanctioned.json`,
    JSON.stringify(
      {
        source:
          "https://github.com/0xB10C/ofac-sanctioned-digital-currency-addresses (lists branch)",
        license: "MIT",
        commit: OFAC_REF,
        addresses: ofac.map((a) => a.toLowerCase()),
      },
      null,
      2,
    ) + "\n",
  );

  console.log(
    `exchange-labels.json: ethereum=${Object.keys(exchanges.ethereum!).length} base=${Object.keys(exchanges.base!).length}`,
  );
  console.log(`ofac-sanctioned.json: ${ofac.length} addresses`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
