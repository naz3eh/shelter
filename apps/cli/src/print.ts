import type { AttestationCheck, VerificationResult } from "@shelter/attest";

export function printCheckList(checks: AttestationCheck[]): void {
  for (const c of checks) {
    console.log(`  [${c.ok ? "PASS" : "FAIL"}] ${c.name} — ${c.detail}`);
  }
}

export function printChecks(result: VerificationResult): void {
  printCheckList(result.checks);
}
