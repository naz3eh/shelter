#!/usr/bin/env tsx
const [cmd] = process.argv.slice(2);

const usage = `shelter <command>

Commands:
  demo [--dry-run]       run the judge demo
  verify-attestation     check the NEAR AI TEE attestation`;

switch (cmd) {
  case "demo":
    await import("./demo.js");
    break;
  case "verify-attestation":
    await import("./verify-attestation.js");
    break;
  default:
    console.log(usage);
}
