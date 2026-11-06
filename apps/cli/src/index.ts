#!/usr/bin/env tsx
const [cmd] = process.argv.slice(2);

const usage = `shelter <command>

Commands:
  scan                   scan wallets (--sample NAME | --address 0x.. --chain CHAIN)
  explain                explain a sample scan via the attested NEAR AI model (--sample NAME)
  demo [--dry-run]       run the judge demo
  verify-attestation     check the NEAR AI TEE attestation`;

switch (cmd) {
  case "scan":
    await import("./scan.js");
    break;
  case "explain":
    await import("./explain.js");
    break;
  case "demo":
    await import("./demo.js");
    break;
  case "verify-attestation":
    await import("./verify-attestation.js");
    break;
  default:
    console.log(usage);
}
