/**
 * Checks for one NEAR attestation report (gateway_attestation or a
 * model_attestations[] candidate), following docs.near.ai "Quote, Nonce, and
 * Signer Bindings". The Intel quote verification itself is injected so tests
 * can run offline against recorded fixtures.
 */

import {
  bytesEqual,
  concatBytes,
  fromHex,
  sha256,
  sha384,
  toHex,
  utf8,
} from "./bytes";

export interface AttestationCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * The measurements a verified Intel quote must expose for our checks.
 * Produced by a QuoteVerifier — the real one wraps @phala/dcap-qvl.
 */
export interface QuoteMeasurements {
  /** TCB status string from the verifier, e.g. "UpToDate". */
  status: string;
  advisoryIds: string[];
  /** TD10 td_attributes (8 bytes); bit 0 of byte 0 is the debug flag. */
  tdAttributes: Uint8Array;
  /** 64 bytes: bound signer identity (32) || client nonce (32). */
  reportData: Uint8Array;
  /** 48 bytes: 0x01 || SHA-256(app_compose) || 15 zero bytes. */
  mrConfigId: Uint8Array;
  /** 48-byte runtime measurement register 3. */
  rtMr3: Uint8Array;
}

/** Verifies a raw intel_quote and returns the measurements inside it. */
export type QuoteVerifier = (
  intelQuoteHex: string,
) => Promise<QuoteMeasurements>;

/** The fields this package reads off a NEAR attestation report. */
export interface NearReport {
  intel_quote?: string;
  event_log?: string | unknown[];
  request_nonce?: string;
  report_data?: string;
  signing_address?: string;
  signing_algo?: string;
  tls_cert_fingerprint?: string;
  nvidia_payload?: string | unknown;
  info?: { tcb_info?: string | Record<string, unknown> };
  [key: string]: unknown;
}

export interface EventLogEntry {
  imr?: number;
  event_type?: number;
  event?: string;
  event_payload?: string;
  digest?: string;
}

export interface CheckNearReportOptions {
  /** TCB statuses the policy accepts. Default: ["UpToDate"]. */
  acceptedTcbStatuses?: string[];
}

const ok = (name: string, detail: string): AttestationCheck => ({
  name,
  ok: true,
  detail,
});
const fail = (name: string, detail: string): AttestationCheck => ({
  name,
  ok: false,
  detail,
});

const asJson = <T>(value: string | T | undefined): T | undefined =>
  typeof value === "string" ? (JSON.parse(value) as T) : value;

/**
 * Replays the imr==3 events of a NEAR event_log and returns the resulting
 * RTMR3 (48 bytes). Throws on a digest mismatch — the caller turns that into
 * a failed check.
 */
export async function replayRtmr3(
  eventLog: string | EventLogEntry[] | undefined,
): Promise<Uint8Array> {
  const events = asJson(eventLog as string | EventLogEntry[] | undefined);
  let rtmr3: Uint8Array = new Uint8Array(48);
  for (const event of events ?? []) {
    if (event.imr !== 3) continue;
    const eventType = new Uint8Array(4);
    new DataView(eventType.buffer).setUint32(0, event.event_type ?? 0, true);
    const digest = await sha384(
      concatBytes(
        eventType,
        utf8(":"),
        utf8(event.event ?? ""),
        utf8(":"),
        fromHex(event.event_payload || ""),
      ),
    );
    if (event.digest && !bytesEqual(fromHex(event.digest), digest)) {
      throw new Error(`digest mismatch for event ${event.event}`);
    }
    rtmr3 = await sha384(concatBytes(rtmr3, digest));
  }
  return rtmr3;
}

function signingIdentityBytes(report: NearReport): Uint8Array {
  const algo = report.signing_algo;
  const address = report.signing_address;
  if (!algo || !address) throw new Error("missing signing_address/signing_algo");
  const identity = fromHex(address);
  const expected = algo === "ecdsa" ? 20 : algo === "ed25519" ? 32 : -1;
  if (identity.length !== expected) {
    throw new Error(
      `unsupported signing identity: algo=${algo} length=${identity.length}`,
    );
  }
  return identity;
}

/**
 * Runs every documented check on one report. If the Intel quote itself fails
 * to verify, the dependent checks are reported as failed (not silently
 * skipped) so the caller sees the full picture.
 */
export async function checkNearReport(
  report: NearReport,
  nonceHex: string,
  verifyQuote: QuoteVerifier,
  opts: CheckNearReportOptions = {},
): Promise<AttestationCheck[]> {
  const accepted = opts.acceptedTcbStatuses ?? ["UpToDate"];
  const checks: AttestationCheck[] = [];
  const nonce = nonceHex.toLowerCase();

  let quote: QuoteMeasurements | null = null;
  try {
    quote = await verifyQuote(report.intel_quote ?? "");
    checks.push(
      accepted.includes(quote.status)
        ? ok("dcap-quote", `Intel TDX quote verified (TCB ${quote.status})`)
        : fail(
            "dcap-quote",
            `TCB status ${quote.status} not accepted; advisories: ${
              quote.advisoryIds.join(", ") || "none"
            }`,
          ),
    );
  } catch (err) {
    checks.push(
      fail("dcap-quote", `quote verification failed: ${errMessage(err)}`),
    );
  }

  const run = async (
    name: string,
    fn: (q: QuoteMeasurements) => AttestationCheck | Promise<AttestationCheck>,
  ) => {
    if (!quote) return fail(name, "not run: quote did not verify");
    try {
      return await fn(quote);
    } catch (err) {
      return fail(name, errMessage(err));
    }
  };

  // 2. Debug mode must be off (bit 0 of td_attributes byte 0).
  checks.push(
    await run("tdx-debug-disabled", (q) => {
      const debug = ((q.tdAttributes[0] ?? 0) & 1) !== 0;
      return debug
        ? fail("tdx-debug-disabled", "TDX debug mode is enabled")
        : ok("tdx-debug-disabled", "TDX debug mode off");
    }),
  );

  // 3. The quote's report_data binds our nonce and the reported signer.
  checks.push(
    await run("quote-binds-nonce", async (q) => {
      const identity = signingIdentityBytes(report);
      const fingerprint = report.tls_cert_fingerprint;
      const boundIdentity = fingerprint
        ? await sha256(concatBytes(identity, fromHex(fingerprint)))
        : concatBytes(identity, new Uint8Array(32 - identity.length));
      const expected = concatBytes(boundIdentity, fromHex(nonce));
      if (!bytesEqual(q.reportData, expected)) {
        return fail(
          "quote-binds-nonce",
          "quote report_data does not bind the signer and our nonce",
        );
      }
      if (
        report.report_data &&
        !bytesEqual(fromHex(report.report_data), q.reportData)
      ) {
        return fail(
          "quote-binds-nonce",
          "echoed report_data differs from the verified quote",
        );
      }
      return ok("quote-binds-nonce", "report_data binds signer + fresh nonce");
    }),
  );

  // 4. The echoed request_nonce must equal our client nonce.
  checks.push(
    await run("echoed-nonce", () =>
      (report.request_nonce ?? "").toLowerCase() === nonce
        ? ok("echoed-nonce", "request_nonce matches our nonce")
        : fail(
            "echoed-nonce",
            `request_nonce ${report.request_nonce ?? "missing"} != ${nonce}`,
          ),
    ),
  );

  // 5. SHA-256 of the raw app_compose string must match MRCONFIGID.
  checks.push(
    await run("app-compose-hash", async (q) => {
      const tcbInfo = asJson(report.info?.tcb_info) as
        | Record<string, unknown>
        | undefined;
      const appCompose = tcbInfo?.app_compose;
      if (typeof appCompose !== "string") {
        return fail("app-compose-hash", "info.tcb_info.app_compose missing");
      }
      const expected = concatBytes(
        new Uint8Array([1]),
        await sha256(utf8(appCompose)),
        new Uint8Array(15),
      );
      return bytesEqual(q.mrConfigId, expected)
        ? ok("app-compose-hash", "MRCONFIGID matches SHA-256(app_compose)")
        : fail("app-compose-hash", "MRCONFIGID does not match app_compose");
    }),
  );

  // 6. Replay event_log and compare with the quote's RTMR3.
  checks.push(
    await run("rtmr3-replay", async (q) => {
      try {
        const replayed = await replayRtmr3(
          report.event_log as string | EventLogEntry[] | undefined,
        );
        return bytesEqual(replayed, q.rtMr3)
          ? ok("rtmr3-replay", "event log replays to the quote's RTMR3")
          : fail("rtmr3-replay", "event log does not match RTMR3");
      } catch (err) {
        return fail("rtmr3-replay", errMessage(err));
      }
    }),
  );

  // 7. NVIDIA GPU evidence: displayed but not cryptographically verified
  //    (no open-source JS NRAS/EAT verifier; see docs/THREAT_MODEL.md).
  const gpu = report.nvidia_payload;
  const gpuPresent =
    gpu !== undefined && gpu !== null && gpu !== "" && gpu !== "{}";
  checks.push(
    ok(
      "gpu-evidence",
      gpuPresent
        ? "NVIDIA GPU evidence present, not verified"
        : "no NVIDIA GPU evidence in this report",
    ),
  );

  return checks;
}

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
