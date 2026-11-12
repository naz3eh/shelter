/**
 * NEP-413 off-chain message signing, as used by NEAR Intents for the
 * `nep413` standard (User-Session login and signed-intent execution).
 *
 * Spec: https://github.com/near/NEPs/blob/master/neps/nep-0413.md
 * Hash: sha256( borsh(u32 2^31 + 413) || borsh({ message: string,
 * nonce: [u8; 32], recipient: string, callback_url: Option<string> }) ).
 * Mirrors `hashNEP413Message` in @defuse-protocol/intents-sdk 0.95.0.
 *
 * The private key never reaches this package: a wallet (Meteor through the
 * CLI bridge, or any other NEP-413 wallet) implements `Nep413Signer`. Every
 * signature that comes back is verified here against the exact payload
 * before it is sent anywhere.
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58, base64 } from "@scure/base";
import { assertIntentsAccountId } from "./accounts.js";
import { IntentsError } from "./errors.js";

export const NEP413_TAG = 2 ** 31 + 413;
export const NEP413_NONCE_BYTES = 32;

export interface Nep413Payload {
  /** The exact UTF-8 string the wallet signs. */
  message: string;
  /** 32 bytes. */
  nonce: Uint8Array;
  /** The contract the message is meant for (`intents.near`). */
  recipient: string;
  callbackUrl?: string;
}

/** What a wallet returns: `ed25519:<base58>` key and signature (base64 or `ed25519:<base58>`). */
export interface Nep413Signature {
  accountId: string;
  publicKey: string;
  signature: string;
}

/**
 * A NEP-413 wallet. `accountId` is the account the caller expects to sign;
 * a signature from any other account is rejected.
 */
export interface Nep413Signer {
  readonly accountId: string;
  sign(payload: Nep413Payload, opts?: { signal?: AbortSignal; purpose?: string }): Promise<Nep413Signature>;
}

const enc = new TextEncoder();

function borshString(s: string): Uint8Array {
  const bytes = enc.encode(s);
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length, true);
  out.set(bytes, 4);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function assertNep413Payload(p: Nep413Payload): void {
  if (typeof p.message !== "string" || p.message.length === 0) throw new IntentsError("validation", "NEP-413 message is empty");
  if (!(p.nonce instanceof Uint8Array) || p.nonce.length !== NEP413_NONCE_BYTES) {
    throw new IntentsError("validation", "NEP-413 nonce must be 32 bytes");
  }
  assertIntentsAccountId(p.recipient, "NEP-413 recipient");
}

/** The borsh bytes that are hashed (tag included). */
export function nep413Bytes(p: Nep413Payload): Uint8Array {
  assertNep413Payload(p);
  const tag = new Uint8Array(4);
  new DataView(tag.buffer).setUint32(0, NEP413_TAG, true);
  const callback = p.callbackUrl === undefined ? new Uint8Array([0]) : concat([new Uint8Array([1]), borshString(p.callbackUrl)]);
  return concat([tag, borshString(p.message), p.nonce, borshString(p.recipient), callback]);
}

export function nep413Hash(p: Nep413Payload): Uint8Array {
  return sha256(nep413Bytes(p));
}

/** Parses `ed25519:<base58>` into 32 raw bytes. */
export function parseEd25519PublicKey(key: string): Uint8Array {
  if (typeof key !== "string" || !key.startsWith("ed25519:")) {
    throw new IntentsError("validation", "public key must be ed25519:<base58>");
  }
  let raw: Uint8Array;
  try {
    raw = base58.decode(key.slice(8));
  } catch {
    throw new IntentsError("validation", "public key is not valid base58");
  }
  if (raw.length !== 32) throw new IntentsError("validation", "ed25519 public key must be 32 bytes");
  return raw;
}

/** Accepts base64 (what wallet-selector returns) or `ed25519:<base58>`; returns 64 raw bytes. */
export function parseEd25519Signature(sig: string): Uint8Array {
  if (typeof sig !== "string" || sig.length === 0) throw new IntentsError("validation", "signature is empty");
  let raw: Uint8Array;
  try {
    raw = sig.startsWith("ed25519:") ? base58.decode(sig.slice(8)) : base64.decode(sig);
  } catch {
    throw new IntentsError("validation", "signature is neither base64 nor ed25519:<base58>");
  }
  if (raw.length !== 64) throw new IntentsError("validation", "ed25519 signature must be 64 bytes");
  return raw;
}

/** `ed25519:<base58>`, the form NEAR Intents expects in `signedData.signature`. */
export function formatEd25519Signature(sig: string): string {
  return `ed25519:${base58.encode(parseEd25519Signature(sig))}`;
}

export function verifyNep413(p: Nep413Payload, publicKey: string, signature: string): boolean {
  try {
    return ed25519.verify(parseEd25519Signature(signature), nep413Hash(p), parseEd25519PublicKey(publicKey));
  } catch {
    return false;
  }
}

/**
 * Asks the signer for a signature and refuses anything that is not a valid
 * signature over exactly `payload` by `signer.accountId`.
 */
export async function signNep413Checked(
  signer: Nep413Signer,
  payload: Nep413Payload,
  opts: { signal?: AbortSignal; purpose?: string } = {},
): Promise<{ publicKey: string; signature: string }> {
  assertNep413Payload(payload);
  const res = await signer.sign(payload, opts);
  if (res.accountId !== signer.accountId) {
    throw new IntentsError("signer_mismatch", `the wallet signed as ${res.accountId}, expected ${signer.accountId}`);
  }
  parseEd25519PublicKey(res.publicKey);
  if (!verifyNep413(payload, res.publicKey, res.signature)) {
    throw new IntentsError("signature_invalid", "the wallet's NEP-413 signature does not verify over the requested payload");
  }
  return { publicKey: res.publicKey, signature: formatEd25519Signature(res.signature) };
}
