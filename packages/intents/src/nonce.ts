/**
 * Versioned, salted, expirable nonces for `intents.near`.
 *
 * Layout (32 bytes), from `VersionedNonceBuilder` in
 * @defuse-protocol/intents-sdk 0.95.0 and the intents.near contract:
 *
 *   magic  [0x56, 0x28, 0xf6, 0xc6]   4 bytes
 *   version 0                          1 byte
 *   salt   current_salt()              4 bytes
 *   deadline  u64 LE, unix nanoseconds 8 bytes (equals the intent deadline)
 *   random                            15 bytes
 *
 * The 1Click auth endpoint additionally expects the first 8 random bytes to
 * hold the start time (i64 LE nanoseconds) within 5 minutes of its clock
 * ("timestamped" nonce). A purely random nonce is answered with
 * "invalid nonce".
 *
 * The salt rotates: the docs quote e110f317, but on 2026-11-08 intents.near
 * returned 252812b3 from current_salt and is_valid_salt("e110f317") was
 * false. It is always read live (see near-rpc.ts), never hardcoded.
 */

import { hex } from "@scure/base";
import { IntentsError } from "./errors.js";

export const VERSIONED_NONCE_MAGIC = Uint8Array.of(0x56, 0x28, 0xf6, 0xc6);
export const NONCE_RANDOM_BYTES = 15;

export interface DecodedNonce {
  version: number;
  salt: string;
  deadline: Date;
  random: Uint8Array;
  /** Start time from the first 8 random bytes, if the nonce is timestamped. */
  startedAt: Date;
}

const nsOf = (d: Date) => BigInt(d.getTime()) * 1_000_000n;

export function parseSalt(salt: string | Uint8Array): Uint8Array {
  const bytes = typeof salt === "string" ? (/^[0-9a-f]{8}$/i.test(salt) ? hex.decode(salt.toLowerCase()) : null) : salt;
  if (!bytes || bytes.length !== 4) throw new IntentsError("validation", "intents salt must be 4 bytes (8 hex characters)");
  return bytes;
}

/** 15 bytes: start time (i64 LE ns) followed by 7 random bytes. */
export function timestampedRandomBytes(startedAt: Date, random: (n: number) => Uint8Array = defaultRandom): Uint8Array {
  const out = new Uint8Array(NONCE_RANDOM_BYTES);
  new DataView(out.buffer).setBigInt64(0, nsOf(startedAt), true);
  out.set(random(NONCE_RANDOM_BYTES - 8), 8);
  return out;
}

export function encodeVersionedNonce(salt: string | Uint8Array, deadline: Date, randomBytes: Uint8Array): Uint8Array {
  const s = parseSalt(salt);
  if (randomBytes.length !== NONCE_RANDOM_BYTES) throw new IntentsError("validation", "nonce random part must be 15 bytes");
  if (!Number.isFinite(deadline.getTime())) throw new IntentsError("validation", "nonce deadline is not a valid date");
  const out = new Uint8Array(32);
  out.set(VERSIONED_NONCE_MAGIC, 0);
  out[4] = 0;
  out.set(s, 5);
  new DataView(out.buffer).setBigUint64(9, nsOf(deadline), true);
  out.set(randomBytes, 17);
  return out;
}

export function decodeVersionedNonce(nonce: Uint8Array): DecodedNonce {
  if (nonce.length !== 32) throw new IntentsError("validation", "nonce must be 32 bytes");
  if (!VERSIONED_NONCE_MAGIC.every((b, i) => nonce[i] === b)) throw new IntentsError("validation", "nonce is not versioned");
  const dv = new DataView(nonce.buffer, nonce.byteOffset, nonce.byteLength);
  const random = nonce.slice(17);
  return {
    version: nonce[4]!,
    salt: hex.encode(nonce.slice(5, 9)),
    deadline: new Date(Number(dv.getBigUint64(9, true) / 1_000_000n)),
    random,
    startedAt: new Date(Number(new DataView(random.buffer).getBigInt64(0, true) / 1_000_000n)),
  };
}

function defaultRandom(n: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}
