/** NEAR AI Cloud TEE attestation check, verified on device. */

export interface AttestationReport {
  model: string;
  /** Raw attestation quote returned by NEAR AI Cloud. */
  quote: string;
  nonce: string;
}

export interface AttestationResult {
  verified: boolean;
  model: string;
  reasons: string[];
}

export function fetchAttestation(_model: string, _nonce: string): Promise<AttestationReport> {
  throw new Error("not implemented");
}

export function verifyAttestation(_report: AttestationReport): Promise<AttestationResult> {
  throw new Error("not implemented");
}
