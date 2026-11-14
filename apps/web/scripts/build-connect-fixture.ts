/**
 * Builds lib/fixtures/connect-recording.json, the "Recorded session" the web
 * demo replays, from the real recorded run.
 *
 * Input is scripts/demo/recording.json — the 2026-11-12 Uniswap-on-Base
 * session captured by `demo record --connect` and committed on feat/connect.
 * Everything cryptographic is the recording verbatim: the four real 1Click
 * quotes signed by 1Click's own key, the two real NEP-413 withdrawals signed
 * by the run's NEAR key, the PermitSingle signature, the gas amounts, and
 * every Base transaction's signed bytes.
 *
 * Two transforms are applied, both safe because they only touch unsigned or
 * display data:
 *
 * - The linked main wallet is swapped for a demo address. The real Rabby
 *   address appears only in the blocked request's summary, its finding
 *   message and the linked list — the request was never signed, so nothing
 *   breaks.
 * - `params` are recovered for sent transactions from their signed raw
 *   bytes. The recording predates request-params retention; the signed
 *   transaction IS the request, so decoding it restores exactly what the
 *   dapp asked. Requests without a transaction (the PermitSingle signature,
 *   the blocked send) keep no params and the verifier says so honestly.
 *
 * The NEAR owner stays `viraz.near`: the NEP-413 messages and the 1Click
 * sweep quotes are signed over that account id, so renaming it would break
 * the very signatures the verified panel checks. It is already public in
 * scripts/demo/recording.json and docs/backend/ONECLICK.md.
 *
 * Run: pnpm --filter web exec tsx scripts/build-connect-fixture.ts
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress, keccak256, parseTransaction } from "viem";

const HERE = dirname(fileURLToPath(import.meta.url));
const INPUT = process.argv[2] ?? join(HERE, "..", "..", "..", "scripts", "demo", "recording.json");
const OUTPUT = join(HERE, "..", "lib", "fixtures", "connect-recording.json");

/** The run's real linked wallet, replaced everywhere it appears. */
const REAL_WALLET = "0xFd0BfAB9A7324cbDce82590B6696EABCdCD77339";
/** Stand-in demo address (same one the previous fixture used). */
const DEMO_WALLET = "0x32926c2A3A7811E0FBFA0340b65Fb3E753ecD488";

const swapWallet = (s: string): string =>
  s.split(REAL_WALLET).join(DEMO_WALLET).split(REAL_WALLET.toLowerCase()).join(DEMO_WALLET.toLowerCase());

function swapDeep(value: unknown): unknown {
  if (typeof value === "string") return swapWallet(value);
  if (Array.isArray(value)) return value.map(swapDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, swapDeep(v)]));
  }
  return value;
}

const raw = JSON.parse(readFileSync(INPUT, "utf8")) as {
  format: string;
  v: number;
  connect?: { account: Record<string, unknown> & { requests?: Record<string, unknown>[]; address?: { address: string } }; linked: { id: string; label: string }[] }[];
};
if (raw.format !== "shelter-demo-recording" || raw.v !== 1) throw new Error(`${INPUT} is not a shelter-demo-recording v1`);

const recording = swapDeep(raw) as typeof raw;

// Recover request params for sent transactions from the signed bytes.
let recovered = 0;
for (const c of recording.connect ?? []) {
  const self = c.account.address?.address;
  for (const r of c.account.requests ?? []) {
    if (r.method !== "eth_sendTransaction" || r.params !== undefined || !r.tx) continue;
    const tx = r.tx as { raw: string };
    const p = parseTransaction(tx.raw as `0x${string}`);
    r.params = [
      {
        from: self,
        to: p.to ? getAddress(p.to) : undefined,
        data: p.data ?? "0x",
        value: `0x${(p.value ?? 0n).toString(16)}`,
        ...(p.gas != null ? { gas: `0x${p.gas.toString(16)}` } : {}),
        chainId: 8453,
      },
    ];
    recovered += 1;
  }
}

// ---------- self-checks ----------

const out = JSON.stringify(recording);
if (out.toLowerCase().includes(REAL_WALLET.slice(2).toLowerCase())) {
  throw new Error("the real linked wallet still appears in the fixture");
}
for (const c of recording.connect ?? []) {
  const a = c.account as { owner?: string; requests?: { decision?: string; findings?: { level: string; message: string }[] }[] };
  if (a.owner !== "viraz.near") throw new Error(`unexpected owner ${a.owner}: NEP-413 signatures are over viraz.near`);
  for (const r of a.requests ?? []) {
    if (r.decision === "blocked") {
      const names = (r.findings ?? []).some(
        (f) => f.level === "block" && f.message.toLowerCase().includes(DEMO_WALLET.toLowerCase()),
      );
      if (!names) throw new Error(`blocked request no longer names the demo wallet: ${JSON.stringify(r.findings)}`);
    }
  }
}

writeFileSync(OUTPUT, `${JSON.stringify(recording, null, 2)}\n`);
console.log(`wrote ${OUTPUT}`);
console.log(`params recovered for ${recovered} sent transaction(s)`);
console.log(`owner kept as viraz.near (signed over it); wallet swapped to ${DEMO_WALLET}`);
