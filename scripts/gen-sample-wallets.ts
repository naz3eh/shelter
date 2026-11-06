/**
 * Generates the fictional sample-wallet fixtures in
 * packages/core/fixtures/sample-wallets/.
 *
 * Wallet and unlabelled-counterparty addresses are deterministic keccak256
 * hashes ("shelter:sample:<profile>:<name>") used as fixture keys via viem's
 * privateKeyToAddress — they are NOT the well-known anvil/hardhat integer
 * accounts (0x...01, 0x...02) that carry real mainnet history, and the
 * recorded history in the fixtures is fictional. Counterparties that must be
 * labelled (one exchange address, one OFAC address) are taken from the
 * bundled label sets in packages/core/data/ so the fixtures stay consistent
 * with the shipped data.
 *
 * Run: pnpm --filter @shelter/cli exec tsx ../../scripts/gen-sample-wallets.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { keccak256, toBytes } from "viem";
import { privateKeyToAddress } from "viem/accounts";

const readJson = (rel: string) =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"),
  ) as never;
const exchangeLabels = readJson("../packages/core/data/exchange-labels.json");
const ofac = readJson("../packages/core/data/ofac-sanctioned.json");

const addr = (id: string) =>
  privateKeyToAddress(keccak256(toBytes(`shelter:sample:${id}`))).toLowerCase();
const tx = (profile: string, n: number) =>
  keccak256(toBytes(`${profile}-tx-${n}`));

/** 2025-10-15T20:00:00Z — most sends sit in this UTC hour for check G. */
const T = 1760558400;
const eth = (n: number) => (n * 10 ** 18).toString();

const chains = (exchangeLabels as { chains: Record<string, Record<string, string>> })
  .chains;
const COINBASE = Object.entries(chains["ethereum"]!).find(
  ([, l]) => l === "coinbase",
)![0]!;
const OFAC_ADDR = (ofac as { addresses: string[] }).addresses[0]!;

interface Tx {
  hash: string;
  chain: string;
  from: string;
  to: string | null;
  valueWei: string;
  timestamp: number;
  method?: string;
}

const mkTx = (
  profile: string,
  n: number,
  chain: string,
  from: string,
  to: string | null,
  valueWei: string,
  timestamp: number,
  method?: string,
): Tx => ({
  hash: tx(profile, n),
  chain,
  from: from.toLowerCase(),
  to: to?.toLowerCase() ?? null,
  valueWei,
  timestamp,
  ...(method ? { method } : {}),
});

// ---------------- exposed ----------------
// Fires every check A-I and both warnings.
{
  const W1 = addr("exposed:w1");
  const W2 = addr("exposed:w2");
  const SHARED_DEST = addr("exposed:shared-dest");
  const OTHER_DEST = addr("exposed:other-dest");
  const RANDOM_DUSTER = addr("exposed:duster");
  const LOOKALIKE_W2 = `${W2.slice(0, 6)}${"1".repeat(32)}${W2.slice(-4)}`;

  const w1txs: Tx[] = [
    // C + A: first funded by a labelled Coinbase deposit address
    mkTx("exposed", 1, "ethereum", COINBASE, W1, eth(5), T - 86400 * 30),
    // E: direct transfer W1 -> W2
    mkTx("exposed", 2, "ethereum", W1, W2, eth(1), T + 5 * 60),
    // D: W1 sends to a destination W2 also uses
    mkTx("exposed", 3, "ethereum", W1, SHARED_DEST, eth(0.5), T + 20 * 60),
    // warning: sanctioned counterparty
    mkTx("exposed", 4, "ethereum", W1, OFAC_ADDR, eth(0.1), T + 40 * 60),
    // H: second round 1 ETH send (same amount as tx 2 -> repeated + round)
    mkTx("exposed", 5, "ethereum", W1, OTHER_DEST, eth(1), T + 50 * 60),
    // warning: dust in
    mkTx("exposed", 6, "ethereum", RANDOM_DUSTER, W1, "1000000", T + 60 * 60),
    // warning: look-alike sender (same prefix/suffix as W2)
    mkTx("exposed", 7, "ethereum", LOOKALIKE_W2, W1, "5000000", T + 61 * 60),
  ];
  const w2txs: Tx[] = [
    // E/C: first funder is W1, another scanned wallet
    mkTx("exposed", 2, "ethereum", W1, W2, eth(1), T + 5 * 60),
    // D: same shared destination
    mkTx("exposed", 8, "ethereum", W2, SHARED_DEST, eth(0.25), T + 30 * 60),
    // G: keeps W2's top send-hour at 14:00 UTC, non-round amount
    mkTx("exposed", 9, "ethereum", W2, OTHER_DEST, eth(0.033), T + 45 * 60),
  ];

  const profile = {
    name: "exposed",
    description:
      "Fictional pair of linked wallets that trips every check and both warnings.",
    wallets: [
      { chain: "ethereum", address: W1, label: "main" },
      { chain: "ethereum", address: W2, label: "second" },
    ],
    accounts: {
      [W1]: {
        chain: "ethereum",
        balanceWei: eth(3.4),
        nonce: 5,
        ensName: "sample-victim.eth",
        transactions: w1txs,
        tokenTransfers: [],
        approvals: [
          // I: W1 approved W2 as spender
          {
            txHash: tx("exposed", 10),
            chain: "ethereum",
            token: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
            owner: W1,
            spender: W2,
          },
        ],
      },
      [W2]: {
        chain: "ethereum",
        balanceWei: eth(0.6),
        nonce: 2,
        ensName: null,
        transactions: w2txs,
        tokenTransfers: [],
        approvals: [],
      },
    },
  };
  write("exposed", profile);
}

// ---------------- medium ----------------
// Shared destination + exposed key + round amounts -> linkable band.
{
  const M1 = addr("medium:m1");
  const M2 = addr("medium:m2");
  const SHARED = addr("medium:shared");
  const FUNDER = addr("medium:funder");

  const profile = {
    name: "medium",
    description:
      "Fictional wallets with a shared destination and an exposed public key.",
    wallets: [
      { chain: "ethereum", address: M1, label: "main" },
      { chain: "base", address: M2, label: "base" },
    ],
    accounts: {
      [M1]: {
        chain: "ethereum",
        balanceWei: eth(1.2),
        nonce: 3,
        ensName: null,
        transactions: [
          mkTx("medium", 1, "ethereum", FUNDER, M1, eth(2), T - 86400 * 10),
          mkTx("medium", 2, "ethereum", M1, SHARED, eth(0.5), T + 10 * 60),
          // two identical round sends -> check H
          mkTx("medium", 3, "ethereum", M1, addr("medium:dest1"), eth(0.5), T + 70 * 60),
          mkTx("medium", 4, "ethereum", M1, addr("medium:dest2"), eth(0.5), T + 80 * 60),
        ],
        tokenTransfers: [],
        approvals: [],
      },
      [M2]: {
        chain: "base",
        balanceWei: eth(0.1),
        nonce: 0,
        ensName: null,
        transactions: [
          mkTx("medium", 5, "base", FUNDER, M2, eth(0.3), T - 86400 * 5),
          mkTx("medium", 6, "base", M2, SHARED, eth(0.05), T + 15 * 60),
        ],
        tokenTransfers: [],
        approvals: [],
      },
    },
  };
  write("medium", profile);
}

// ---------------- clean ----------------
// One fresh wallet, funded by an unlabelled address, never signed.
{
  const C1 = addr("clean:c1");
  const FUNDER = addr("clean:funder");
  const profile = {
    name: "clean",
    description: "Fictional fresh wallet with no exposure findings.",
    wallets: [{ chain: "base", address: C1, label: "fresh" }],
    accounts: {
      [C1]: {
        chain: "base",
        balanceWei: eth(0.75),
        nonce: 0,
        ensName: null,
        transactions: [
          mkTx("clean", 1, "base", FUNDER, C1, eth(0.75), T - 86400),
        ],
        tokenTransfers: [],
        approvals: [],
      },
    },
  };
  write("clean", profile);
}

function write(name: string, profile: unknown) {
  const dir = fileURLToPath(
    new URL("../packages/core/fixtures/sample-wallets/", import.meta.url),
  );
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}${name}.json`, JSON.stringify(profile, null, 2) + "\n");
  console.log(`wrote ${name}.json`);
}
