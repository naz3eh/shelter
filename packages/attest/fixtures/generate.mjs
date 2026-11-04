/**
 * Regenerates packages/attest/fixtures/*.json — recorded attestation reports
 * used by the offline tests. The intel_quote values are placeholders: the
 * tests inject a quote verifier that returns the matching "verified quote"
 * measurements stored under `quoteExpectations`. Everything else (nonce
 * binding, event-log digests, app_compose hashing) is computed for real here,
 * so the checks exercised in tests behave exactly as they would on a live
 * report. Run: node fixtures/generate.mjs
 */

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const sha256 = (b) => createHash("sha256").update(b).digest();
const sha384 = (b) => createHash("sha384").update(b).digest();
const hex = (b) => Buffer.from(b).toString("hex");
const fromHex = (h) => Buffer.from(h.replace(/^0x/i, ""), "hex");

// Well-known Hardhat/Anvil test addresses — public, no secrets.
const MODEL_SIGNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const GATEWAY_SIGNER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

function eventDigest(e) {
  const t = Buffer.alloc(4);
  t.writeUInt32LE(e.event_type);
  return sha384(
    Buffer.concat([
      t,
      Buffer.from(":"),
      Buffer.from(e.event, "utf8"),
      Buffer.from(":"),
      Buffer.from(e.event_payload || "", "hex"),
    ]),
  );
}

function makeEvents() {
  const events = [
    { imr: 0, event_type: 1, event: "td-shim-init", event_payload: "ab", digest: "" },
    {
      imr: 3,
      event_type: 134217729,
      event: "compose-hash",
      event_payload: "11".repeat(32),
      digest: "",
    },
    {
      imr: 3,
      event_type: 134217730,
      event: "app-id",
      event_payload: "22".repeat(20),
      digest: "",
    },
    {
      imr: 3,
      event_type: 134217731,
      event: "instance-id",
      event_payload: "33".repeat(16),
      digest: "",
    },
    { imr: 2, event_type: 9, event: "other-mr", event_payload: "ff", digest: "" },
  ];
  for (const e of events) {
    if (e.imr === 3) e.digest = hex(eventDigest(e));
  }
  return events;
}

function replayRtmr3(events) {
  let r = Buffer.alloc(48);
  for (const e of events) {
    if (e.imr !== 3) continue;
    r = sha384(Buffer.concat([r, eventDigest(e)]));
  }
  return r;
}

const APP_COMPOSE =
  '{"manifest_version":2,"name":"shelter-explainer-tee","runner":"docker-compose",' +
  '"docker-compose":"version: \\"3.8\\"\\nservices:\\n  app:\\n    image: nearai/vllm-tee@sha256:abc\\n",' +
  '"features":["tproxy"],"kms_enabled":true}';

function buildReport({ nonce, signingAddress, intelQuote, appCompose = APP_COMPOSE }) {
  const events = makeEvents();
  const identity = fromHex(signingAddress);
  const reportData = Buffer.concat([
    identity,
    Buffer.alloc(32 - identity.length),
    fromHex(nonce),
  ]);
  const mrConfigId = Buffer.concat([
    Buffer.from([1]),
    sha256(Buffer.from(appCompose, "utf8")),
    Buffer.alloc(15),
  ]);
  const tcbInfo = JSON.stringify({
    app_compose: appCompose,
    mrtd: "aa".repeat(48),
    tcb_status: "UpToDate",
    os_image_hash: "bb".repeat(32),
  });
  const report = {
    intel_quote: intelQuote,
    event_log: JSON.stringify(events),
    request_nonce: nonce,
    signing_address: signingAddress,
    signing_algo: "ecdsa",
    nvidia_payload: JSON.stringify({ nonce, arch: "H100", evidence: "nras-jwt-payload" }),
    info: { tcb_info: tcbInfo },
  };
  const expectations = {
    status: "UpToDate",
    advisoryIds: [],
    tdAttributes: "0000000000000000",
    reportData: hex(reportData),
    mrConfigId: hex(mrConfigId),
    rtMr3: hex(replayRtmr3(events)),
  };
  return { report, expectations };
}

const NONCE = "ab".repeat(32);
const OTHER_NONCE = "cd".repeat(32);

function scenario(name, mutate) {
  const quoteGw = `0400${"aa".repeat(200)}`;
  const quoteModel = `0400${"bb".repeat(200)}`;
  const gw = buildReport({ nonce: NONCE, signingAddress: GATEWAY_SIGNER, intelQuote: quoteGw });
  const model = buildReport({ nonce: NONCE, signingAddress: MODEL_SIGNER, intelQuote: quoteModel });
  const fixture = {
    description: name,
    model: "z-ai/glm-5.3-flash",
    clientNonce: NONCE,
    response: {
      gateway_attestation: gw.report,
      model_attestations: [model.report],
    },
    quoteExpectations: {
      [gw.report.intel_quote]: gw.expectations,
      [model.report.intel_quote]: model.expectations,
    },
  };
  mutate?.(fixture);
  return fixture;
}

const fixtures = {
  "pass": scenario("all checks pass"),

  "wrong-nonce": scenario("report bound to a different nonce", (f) => {
    // Rebuild both reports against OTHER_NONCE while the client asks NONCE.
    const gw = buildReport({
      nonce: OTHER_NONCE,
      signingAddress: GATEWAY_SIGNER,
      intelQuote: f.response.gateway_attestation.intel_quote,
    });
    const model = buildReport({
      nonce: OTHER_NONCE,
      signingAddress: MODEL_SIGNER,
      intelQuote: f.response.model_attestations[0].intel_quote,
    });
    f.response.gateway_attestation = gw.report;
    f.response.model_attestations = [model.report];
    f.quoteExpectations = {
      [gw.report.intel_quote]: gw.expectations,
      [model.report.intel_quote]: model.expectations,
    };
  }),

  "tampered-app-compose": scenario(
    "app_compose changed after the quote was measured",
    (f) => {
      // Mutate the compose string but keep the stored MRCONFIGID expectation.
      const tampered = APP_COMPOSE.replace(
        "shelter-explainer-tee",
        "shelter-explainer-tee-evil",
      );
      for (const report of [
        f.response.gateway_attestation,
        ...f.response.model_attestations,
      ]) {
        const tcb = JSON.parse(report.info.tcb_info);
        tcb.app_compose = tampered;
        report.info.tcb_info = JSON.stringify(tcb);
      }
    },
  ),

  "missing-model-attestations": scenario(
    "no model_attestations field in the response",
    (f) => {
      delete f.response.model_attestations;
    },
  ),
};

for (const [name, fixture] of Object.entries(fixtures)) {
  const path = join(dir, `${name}.json`);
  writeFileSync(path, JSON.stringify(fixture, null, 2) + "\n");
  console.log("wrote", path);
}
