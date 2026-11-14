import OpenAI from "openai";
import { ensureRootEnv } from "@/lib/server-env";
import {
  buildExplainMessages,
  DEFAULT_MODEL,
  fetchResponseSignature,
  NEAR_AI_CLOUD_BASE,
  type RedactedScanReport,
} from "@shelter/attest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EVM_ADDRESS = /\b0x[0-9a-fA-F]{40}\b/;
const TX_HASH = /\b0x?[0-9a-fA-F]{64}\b/;

/**
 * Stateless explainer call: the browser sends an already-redacted scan
 * (addresses are Wallet/Counterparty aliases, no tx hashes — enforced below),
 * we relay it to NEAR AI Cloud's TEE model and return the answer plus the
 * exact request/response bytes and the response signature so the browser can
 * verify everything itself. No request bodies are logged or stored.
 */
export async function POST(req: Request) {
  ensureRootEnv();
  const apiKey = process.env.NEAR_AI_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: "NEAR_AI_API_KEY is not configured on this server" },
      { status: 500 },
    );
  }
  const model = process.env.NEAR_AI_MODEL ?? DEFAULT_MODEL;

  const raw = await req.text();
  let redacted: RedactedScanReport;
  try {
    redacted = JSON.parse(raw) as RedactedScanReport;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (
    typeof redacted !== "object" ||
    redacted === null ||
    typeof redacted.score !== "number" ||
    typeof redacted.band !== "string" ||
    !Array.isArray(redacted.findings) ||
    !Array.isArray(redacted.warnings)
  ) {
    return Response.json(
      { error: "body must be a redacted ScanReport" },
      { status: 400 },
    );
  }
  // Hard guard: never forward raw addresses or tx hashes upstream.
  if (EVM_ADDRESS.test(raw) || TX_HASH.test(raw)) {
    return Response.json(
      { error: "body contains unredacted addresses or tx hashes" },
      { status: 422 },
    );
  }

  // Wrap fetch so the exact bytes openai sends/receives are kept — the
  // response signature covers these hashes, and the client checks them.
  let requestBody = "";
  let responseBody = "";
  const captureFetch: typeof fetch = async (input, init) => {
    const res = await fetch(input, init);
    if (typeof init?.body === "string") requestBody = init.body;
    responseBody = await res.clone().text();
    return res;
  };

  const client = new OpenAI({
    apiKey,
    baseURL: `${NEAR_AI_CLOUD_BASE}/v1`,
    fetch: captureFetch,
  });

  let completion;
  try {
    completion = await client.chat.completions.create(
      {
        model,
        messages: buildExplainMessages(redacted),
        temperature: 0.3,
        response_format: { type: "json_object" },
      },
      {
        headers: {
          "x-no-aliasing": "true",
          "Accept-Encoding": "identity",
        },
      },
    );
  } catch (err) {
    return Response.json(
      {
        error: `completion failed: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 502 },
    );
  }

  // The signature can lag the completion by a beat; fetch with the bounded
  // retry built into the helper. An unavailable signature means the client
  // marks the answer unverified — it is still returned.
  let signature = null;
  try {
    signature = await fetchResponseSignature({
      completionId: completion.id,
      model,
      apiKey,
    });
  } catch {
    signature = null;
  }

  return Response.json({
    model,
    completionId: completion.id,
    content: completion.choices[0]?.message?.content ?? "",
    signature,
    requestBody,
    responseBody,
  });
}
