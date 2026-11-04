import {
  createDcapQuoteVerifier,
  DEFAULT_MODEL,
  fetchAttestationReport,
  verifyAttestation,
} from "@shelter/attest";
import { flag, loadEnv, nearAiKey, subArgs } from "./env.js";
import { printChecks } from "./print.js";

export async function runVerifyAttestation(model: string): Promise<boolean> {
  const apiKey = nearAiKey();
  const result = await verifyAttestation({
    model,
    getReport: (m, nonce) =>
      fetchAttestationReport({ model: m, nonce, apiKey }),
    quoteVerifier: createDcapQuoteVerifier(),
  });

  console.log(`model:          ${result.model}`);
  console.log(`nonce:          ${result.nonce}`);
  console.log(`fetched at:     ${result.fetchedAt}`);
  if (result.signingAddress)
    console.log(
      `model signer:   ${result.signingAddress} (${result.signingAlgo})`,
    );
  if (result.gateway?.signingAddress)
    console.log(`gateway signer: ${result.gateway.signingAddress}`);
  console.log(`\nchecks:`);
  printChecks(result);
  console.log(
    `\n${result.ok ? "VERIFIED" : "NOT VERIFIED"} — ` +
      `${result.checks.filter((c) => c.ok).length}/${result.checks.length} checks passed`,
  );
  return result.ok;
}

loadEnv();
const args = subArgs("verify-attestation");
const model = flag(args, "model") ?? process.env.NEAR_AI_MODEL ?? DEFAULT_MODEL;

const ok = await runVerifyAttestation(model);
process.exit(ok ? 0 : 1);
