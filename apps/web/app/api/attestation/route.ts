import { DEFAULT_MODEL, NEAR_AI_CLOUD_BASE } from "@shelter/attest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Thin proxy for /v1/attestation/report: adds the API key and passes the
 * client's nonce (and every other query param) through unchanged. All
 * attestation checks run on the client; nothing is logged or stored here.
 */
export async function GET(req: Request) {
  const apiKey = process.env.NEAR_AI_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: "NEAR_AI_API_KEY is not configured on this server" },
      { status: 500 },
    );
  }

  const incoming = new URL(req.url);
  const nonce = incoming.searchParams.get("nonce") ?? "";
  if (!/^[0-9a-f]{64}$/i.test(nonce)) {
    return Response.json(
      { error: "nonce must be 32 bytes encoded as 64 hex chars" },
      { status: 400 },
    );
  }
  const model =
    incoming.searchParams.get("model") ??
    process.env.NEAR_AI_MODEL ??
    DEFAULT_MODEL;

  const params = new URLSearchParams({
    model,
    provider: "near",
    signing_algo: "ecdsa",
    include_tls_fingerprint: "false",
    nonce,
  });
  const upstream = await fetch(
    `${NEAR_AI_CLOUD_BASE}/v1/attestation/report?${params}`,
    {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
        "x-no-aliasing": "true",
      },
      cache: "no-store",
    },
  );
  const body = await upstream.text();
  return new Response(body, {
    status: upstream.status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}
