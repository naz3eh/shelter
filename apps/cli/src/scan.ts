import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createChainReader,
  FixtureReader,
  scanWallets,
  type ChainId,
  type FixtureProfile,
  type ScanReport,
  type WalletRef,
} from "@shelter/core";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const usage = `shelter scan --sample exposed|medium|clean
       shelter scan --address 0x... --chain ethereum|base`;

function samplePath(name: string) {
  if (!/^[a-z]+$/.test(name)) throw new Error(`bad sample name: ${name}`);
  return fileURLToPath(
    new URL(
      `../../../packages/core/fixtures/sample-wallets/${name}.json`,
      import.meta.url,
    ),
  );
}

function print(report: ScanReport) {
  console.log(`score: ${report.score}/100 (${report.band})`);
  console.log(`\nfindings:`);
  for (const f of report.findings) {
    console.log(
      `  [${f.check}] ${f.kind}  ${f.points} pts (${f.weight} x ${f.confidence})`,
    );
    console.log(`      ${f.detail}`);
    if (f.evidence.txHashes?.length)
      console.log(`      tx: ${f.evidence.txHashes.join(", ")}`);
    if (f.evidence.name) console.log(`      name: ${f.evidence.name}`);
    if (f.evidence.label) console.log(`      label: ${f.evidence.label}`);
  }
  if (report.warnings.length) {
    console.log(`\nwarnings (0 pts):`);
    for (const w of report.warnings) console.log(`  [!] ${w.detail}`);
  }
  console.log(`\nlinkedAddressCount: ${report.linkedAddressCount}`);
}

const sample = flag("sample");
const address = flag("address");
const chain = (flag("chain") ?? "ethereum") as ChainId;

if (sample) {
  const profile = JSON.parse(
    readFileSync(samplePath(sample), "utf8"),
  ) as FixtureProfile;
  const report = await scanWallets(
    profile.wallets as WalletRef[],
    new FixtureReader(profile),
  );
  console.log(`sample: ${profile.name}\n`);
  print(report);
} else if (address) {
  const report = await scanWallets(
    [{ chain, address }],
    createChainReader(),
  );
  print(report);
} else {
  console.log(usage);
}
