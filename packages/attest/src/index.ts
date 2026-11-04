/** NEAR AI Cloud TEE attestation checks + private explainer, verified on device. */

export {
  bytesEqual,
  concatBytes,
  fromHex,
  sha256,
  sha256Hex,
  sha384,
  toHex,
  utf8,
} from "./bytes";
export {
  checkNearReport,
  errMessage,
  replayRtmr3,
} from "./report";
export type {
  AttestationCheck,
  CheckNearReportOptions,
  EventLogEntry,
  NearReport,
  QuoteMeasurements,
  QuoteVerifier,
} from "./report";
export {
  ATTESTATION_PATH,
  createDcapQuoteVerifier,
  DEFAULT_MODEL,
  fetchAttestationReport,
  generateNonce,
  NEAR_AI_CLOUD_BASE,
  verifyAttestation,
} from "./verify";
export type {
  AttestationResponse,
  ReportFetcher,
  VerificationResult,
  VerifiedSigner,
  VerifyAttestationOptions,
} from "./verify";
export {
  buildExplainMessages,
  explainScanReport,
  redactScanReport,
  unredactText,
} from "./explain";
export type {
  ChatMessage,
  CompletionCaller,
  CompletionResult,
  Explanation,
  ExplanationJson,
  RedactedFinding,
  RedactedScanReport,
  RedactedWarning,
  RedactionResult,
} from "./explain";
export {
  fetchResponseSignature,
  verifyResponseSignature,
} from "./signature";
export type {
  SignaturePayload,
  SignatureVerification,
  VerifySignatureOptions,
} from "./signature";
