import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  FixtureReader,
  scanWallets,
  type FixtureProfile,
  type WalletRef,
} from "@shelter/core";
import {
  createDcapQuoteVerifier,
  DEFAULT_MODEL,
  explainScanReport,
  fetchAttestationReport,
  fetchResponseSignature,
  NEAR_AI_CLOUD_BASE,
  unredactText,
  verifyAttestation,
  verifyResponseSignature,
} from "@shelter/attest";
import { flag, loadEnv, nearAiKey, subArgs } from "./env.js";
import { printCheckList } from "./print.js";

function samplePath(name: string) {
  if (!/^[a-z]+$/.test(name)) throw new Error(`bad sample name: ${name}`);
  return fileURLToPath(
    new URL(
      `../../../packages/core/fixtures/sample-wallets/${name}.json`,
      import.meta.url,
    ),
  );
}

loadEnv();
const args = subArgs("explain");
const sample = flag(args, "sample") ?? "exposed";
const model = flag(args, "model") ?? process.env.NEAR_AI_MODEL ?? DEFAULT_MODEL;
const apiKey = nearAiKey();

const profile = JSON.parse(
  readFileSync(samplePath(sample), "utf8"),
) as FixtureProfile;
const report = await scanWallets(
  profile.wallets as WalletRef[],
  new FixtureReader(profile),
);
console.log(
  `sample: ${profile.name} — score ${report.score}/100 (${report.band})\n`,
);

// Preflight: verify the TEE attestation before any finding leaves the device.
console.log("verifying TEE attestation with a fresh nonce…");
const verification = await verifyAttestation({
  model,
  getReport: (m, nonce) => fetchAttestationReport({ model: m, nonce, apiKey }),
  quoteVerifier: createDcapQuoteVerifier(),
});
printCheckList(verification.checks);
if (!verification.ok) {
  console.log(
    "\nATTESTATION FAILED — refusing to send scan findings to an unverified model.",
  );
  process.exit(1);
}
console.log("");

// The completion call keeps the exact request/response bytes so the response
// signature can be bound to them afterwards.
let requestBody = "";
let responseBody = "";
const explanation = await explainScanReport(report, {
  model,
  createCompletion: async ({ model: m, messages }) => {
    requestBody = JSON.stringify({
      model: m,
      messages,
      temperature: 0.3,
      response_format: { type: "json_object" },
    });
    const res = await fetch(`${NEAR_AI_CLOUD_BASE}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "x-no-aliasing": "true",
      },
      body: requestBody,
    });
    responseBody = await res.text();
    if (!res.ok) {
      throw new Error(`completion failed: HTTP ${res.status}: ${responseBody}`);
    }
    const json = JSON.parse(responseBody) as {
      id: string;
      choices: { message: { content: string } }[];
    };
    return { id: json.id, content: json.choices[0]?.message.content ?? "" };
  },
});

// Fetch the response signature and check it binds these exact bytes to a
// verified attestation signer.
let sigOk = false;
try {
  const signature = await fetchResponseSignature({
    completionId: explanation.completionId,
    model,
    apiKey,
  });
  const sigResult = await verifyResponseSignature({
    signature,
    model,
    requestBody,
    responseBody,
    verification,
  });
  sigOk = sigResult.ok;
  console.log("response signature checks:");
  printCheckList(sigResult.checks);
  console.log("");
} catch (err) {
  console.log(
    `response signature unavailable: ${err instanceof Error ? err.message : err}`,
  );
  console.log("");
}

console.log("=== explanation ===");
const parsed = explanation.parsed;
if (parsed?.findings?.length || parsed?.summary) {
  for (const f of parsed.findings ?? []) {
    console.log(
      `  [${f.check ?? "?"}] ${unredactText(f.wallet ?? "", explanation.aliases)}: ` +
        unredactText(f.explanation ?? "", explanation.aliases),
    );
  }
  if (parsed.summary) {
    console.log(`\nsummary: ${unredactText(parsed.summary, explanation.aliases)}`);
  }
} else {
  console.log(unredactText(explanation.text, explanation.aliases));
}
console.log(
  `\n${sigOk ? "VERIFIED ANSWER" : "ANSWER NOT VERIFIED"} (completion ${explanation.completionId})`,
);
process.exit(sigOk ? 0 : 1);
