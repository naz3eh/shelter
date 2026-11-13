#!/usr/bin/env tsx
const [cmd] = process.argv.slice(2);

const usage = `shelter <command>

Commands:
  scan                   scan wallets (--sample NAME | --address 0x.. --chain CHAIN)
  explain                explain a sample scan via the attested NEAR AI model (--sample NAME)
  demo [--dry-run]       run the judge demo
  verify-attestation     check the NEAR AI TEE attestation
  near                   confidential balance owner: keys, Meteor sign-in, dry confidential quotes
  vault                  local seed vault and address book: status, create, import
  burner                 one action from a one-time address: preview, new, run, list, show, cancel
  connect                use the confidential balance in any dapp over WalletConnect, unlinked`;

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
  case "near":
    await import("./near.js");
    break;
  case "vault":
    await import("./vault.js");
    break;
  case "burner":
    await import("./burner.js");
    break;
  case "connect":
    await import("./connect.js");
    break;
  default:
    console.log(usage);
}
