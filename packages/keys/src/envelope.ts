/**
 * Versioned, authenticated encryption envelopes.
 *
 * - Vault: the 64-byte BIP-39 seed, encrypted with AES-256-GCM under a key
 *   stretched from the passphrase with Argon2id.
 * - Address book backup: the allocation records, encrypted with AES-256-GCM
 *   under a key derived from the seed with HKDF-SHA256 (so a backup is useless
 *   without the seed, and restoring one needs the vault unlocked).
 *
 * Every header field (format, version, KDF parameters, salt, IV, vault id,
 * creation time) is bound to the ciphertext as AES-GCM associated data. The
 * header is rebuilt from validated fields in a fixed order before use, so a
 * changed, added or removed field fails authentication or parsing.
 *
 * AES-GCM comes from WebCrypto (browsers in a secure context, Node 24+).
 * Argon2id and HKDF come from @noble/hashes 2.x.
 */

import { argon2idAsync } from "@noble/hashes/argon2.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base64 } from "@scure/base";
import { KeysError } from "./errors.js";

/** Argon2id cost: memory `m` in KiB, iterations `t`, lanes `p`. */
export interface KdfParams {
  m: number;
  t: number;
  p: number;
}

/**
 * RFC 9106 section 4, second recommended option: 64 MiB, t=3, p=4.
 * About 0.5 s on a laptop in Node with the pure-JS implementation; slower on phones.
 */
export const DEFAULT_KDF: KdfParams = { m: 65536, t: 3, p: 4 };
/** OWASP Password Storage Cheat Sheet minimum for Argon2id (19 MiB, t=2, p=1). Anything weaker is refused. */
export const MIN_KDF: KdfParams = { m: 19456, t: 2, p: 1 };
/** Upper bound accepted when opening a vault, so a planted record cannot demand unbounded memory or time. */
export const MAX_KDF: KdfParams = { m: 262144, t: 10, p: 8 };

export type RandomSource = (length: number) => Uint8Array;

export const defaultRandom: RandomSource = (length) => crypto.getRandomValues(new Uint8Array(length));

const SALT_BYTES = 16;
const IV_BYTES = 12;
export const SEED_BYTES = 64;

export interface VaultEnvelopeV1 {
  format: "shelter-vault";
  v: 1;
  kdf: { alg: "argon2id"; m: number; t: number; p: number; salt: string };
  cipher: { alg: "AES-256-GCM"; iv: string };
  /** Public identifier of the seed (see `vaultIdFor`). Lets storage refuse a different seed without unlocking. */
  vaultId: string;
  createdAt: string;
  ct: string;
}

export interface BackupEnvelopeV1 {
  format: "shelter-address-book-backup";
  v: 1;
  cipher: { alg: "AES-256-GCM"; iv: string };
  vaultId: string;
  createdAt: string;
  ct: string;
}

// ---------- vault ----------

export async function sealSeed(
  seed: Uint8Array,
  passphrase: string,
  meta: { vaultId: string; createdAt: string },
  opts: { kdf?: KdfParams; random?: RandomSource } = {},
): Promise<VaultEnvelopeV1> {
  if (seed.length !== SEED_BYTES) throw new KeysError("validation", `seed must be ${SEED_BYTES} bytes`);
  assertPassphrase(passphrase);
  const kdf = opts.kdf ?? DEFAULT_KDF;
  assertKdfParams(kdf);
  const random = opts.random ?? defaultRandom;
  const salt = freshBytes(random, SALT_BYTES);
  const iv = freshBytes(random, IV_BYTES);
  const header = {
    format: "shelter-vault" as const,
    v: 1 as const,
    kdf: { alg: "argon2id" as const, m: kdf.m, t: kdf.t, p: kdf.p, salt: base64.encode(salt) },
    cipher: { alg: "AES-256-GCM" as const, iv: base64.encode(iv) },
    vaultId: meta.vaultId,
    createdAt: meta.createdAt,
  };
  const key = await stretch(passphrase, salt, kdf);
  try {
    const ct = await aesGcm("encrypt", key, iv, seed, aad(vaultHeader(header)));
    return { ...header, ct: base64.encode(ct) };
  } finally {
    key.fill(0);
  }
}

/** Returns the 64-byte seed. The caller owns the buffer and must wipe it. */
export async function openSeed(envelope: VaultEnvelopeV1, passphrase: string): Promise<Uint8Array> {
  const e = parseVaultEnvelope(envelope);
  const kdf = { m: e.kdf.m, t: e.kdf.t, p: e.kdf.p };
  const key = await stretch(passphrase, decode64(e.kdf.salt, "salt", SALT_BYTES), kdf);
  try {
    const seed = await aesGcm("decrypt", key, decode64(e.cipher.iv, "iv", IV_BYTES), decode64(e.ct, "ct"), aad(vaultHeader(e)));
    if (seed.length !== SEED_BYTES) {
      seed.fill(0);
      throw new KeysError("unsupported_format", "vault plaintext has an unexpected length");
    }
    return seed;
  } finally {
    key.fill(0);
  }
}

/** Validates shape, version and KDF bounds. Unknown or extra fields are refused. */
export function parseVaultEnvelope(raw: unknown): VaultEnvelopeV1 {
  const o = record(raw, "vault");
  exactKeys(o, ["format", "v", "kdf", "cipher", "vaultId", "createdAt", "ct"], "vault");
  if (o.format !== "shelter-vault") throw new KeysError("unsupported_format", "not a Shelter vault");
  if (o.v !== 1) throw new KeysError("unsupported_format", `vault version ${String(o.v)} is not supported`);
  const kdf = record(o.kdf, "vault.kdf");
  exactKeys(kdf, ["alg", "m", "t", "p", "salt"], "vault.kdf");
  if (kdf.alg !== "argon2id") throw new KeysError("unsupported_format", "vault KDF must be argon2id");
  const params = { m: int(kdf.m, "kdf.m"), t: int(kdf.t, "kdf.t"), p: int(kdf.p, "kdf.p") };
  assertKdfParams(params, "unsupported_format");
  const cipher = parseCipher(o.cipher, "vault.cipher");
  return {
    format: "shelter-vault",
    v: 1,
    kdf: { alg: "argon2id", ...params, salt: str(kdf.salt, "kdf.salt") },
    cipher,
    vaultId: vaultIdString(o.vaultId),
    createdAt: str(o.createdAt, "createdAt"),
    ct: str(o.ct, "ct"),
  };
}

function vaultHeader(e: Omit<VaultEnvelopeV1, "ct">) {
  // Fixed field order; this exact string is the associated data.
  return {
    format: e.format,
    v: e.v,
    kdf: { alg: e.kdf.alg, m: e.kdf.m, t: e.kdf.t, p: e.kdf.p, salt: e.kdf.salt },
    cipher: { alg: e.cipher.alg, iv: e.cipher.iv },
    vaultId: e.vaultId,
    createdAt: e.createdAt,
  };
}

// ---------- address book backup ----------

export async function sealBackup(
  seed: Uint8Array,
  plaintext: Uint8Array,
  meta: { vaultId: string; createdAt: string },
  random: RandomSource = defaultRandom,
): Promise<BackupEnvelopeV1> {
  const iv = freshBytes(random, IV_BYTES);
  const header = {
    format: "shelter-address-book-backup" as const,
    v: 1 as const,
    cipher: { alg: "AES-256-GCM" as const, iv: base64.encode(iv) },
    vaultId: meta.vaultId,
    createdAt: meta.createdAt,
  };
  const key = backupKey(seed);
  try {
    const ct = await aesGcm("encrypt", key, iv, plaintext, aad(backupHeader(header)));
    return { ...header, ct: base64.encode(ct) };
  } finally {
    key.fill(0);
  }
}

export async function openBackup(seed: Uint8Array, raw: unknown): Promise<{ envelope: BackupEnvelopeV1; plaintext: Uint8Array }> {
  const e = parseBackupEnvelope(raw);
  const key = backupKey(seed);
  try {
    const plaintext = await aesGcm("decrypt", key, decode64(e.cipher.iv, "iv", IV_BYTES), decode64(e.ct, "ct"), aad(backupHeader(e)));
    return { envelope: e, plaintext };
  } finally {
    key.fill(0);
  }
}

export function parseBackupEnvelope(raw: unknown): BackupEnvelopeV1 {
  const o = record(raw, "backup");
  exactKeys(o, ["format", "v", "cipher", "vaultId", "createdAt", "ct"], "backup");
  if (o.format !== "shelter-address-book-backup") throw new KeysError("unsupported_format", "not a Shelter address book backup");
  if (o.v !== 1) throw new KeysError("unsupported_format", `backup version ${String(o.v)} is not supported`);
  return {
    format: "shelter-address-book-backup",
    v: 1,
    cipher: parseCipher(o.cipher, "backup.cipher"),
    vaultId: vaultIdString(o.vaultId),
    createdAt: str(o.createdAt, "createdAt"),
    ct: str(o.ct, "ct"),
  };
}

function backupHeader(e: Omit<BackupEnvelopeV1, "ct">) {
  return { format: e.format, v: e.v, cipher: { alg: e.cipher.alg, iv: e.cipher.iv }, vaultId: e.vaultId, createdAt: e.createdAt };
}

function backupKey(seed: Uint8Array): Uint8Array {
  return hkdf(sha256, seed, utf8("shelter/address-book-backup"), utf8("v1 aes-256-gcm"), 32);
}

// ---------- vault id ----------

/** Public, non-secret id of a seed: 16 bytes of SHA-256 over a domain tag and the BIP-32 master public key. */
export function vaultIdFor(masterPublicKey: Uint8Array): string {
  const h = sha256(new Uint8Array([...utf8("shelter/vault-id/v1"), ...masterPublicKey]));
  return Array.from(h.subarray(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------- primitives ----------

export function assertKdfParams(k: KdfParams, kind: "validation" | "unsupported_format" = "validation"): void {
  const ok =
    Number.isSafeInteger(k.m) && Number.isSafeInteger(k.t) && Number.isSafeInteger(k.p) &&
    k.m >= MIN_KDF.m && k.m <= MAX_KDF.m &&
    k.t >= MIN_KDF.t && k.t <= MAX_KDF.t &&
    k.p >= MIN_KDF.p && k.p <= MAX_KDF.p &&
    k.m >= 8 * k.p;
  if (!ok) {
    throw new KeysError(kind, `Argon2id parameters out of bounds (m ${MIN_KDF.m}..${MAX_KDF.m} KiB, t ${MIN_KDF.t}..${MAX_KDF.t}, p ${MIN_KDF.p}..${MAX_KDF.p})`);
  }
}

function assertPassphrase(passphrase: string): void {
  if (typeof passphrase !== "string" || passphrase.length < 8) {
    throw new KeysError("validation", "passphrase must be at least 8 characters");
  }
}

async function stretch(passphrase: string, salt: Uint8Array, k: KdfParams): Promise<Uint8Array> {
  if (typeof passphrase !== "string" || passphrase.length === 0) throw new KeysError("decrypt_failed", "vault could not be decrypted");
  // NFKC so the same passphrase typed on different keyboards/platforms derives the same key.
  return argon2idAsync(utf8(passphrase.normalize("NFKC")), salt, { m: k.m, t: k.t, p: k.p, dkLen: 32, maxmem: 2 ** 30 + 2 ** 20 });
}

async function aesGcm(op: "encrypt" | "decrypt", rawKey: Uint8Array, iv: Uint8Array, data: Uint8Array, additionalData: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", rawKey as Uint8Array<ArrayBuffer>, { name: "AES-GCM" }, false, [op]);
  const params = { name: "AES-GCM", iv: iv as Uint8Array<ArrayBuffer>, additionalData: additionalData as Uint8Array<ArrayBuffer>, tagLength: 128 };
  try {
    const out = op === "encrypt"
      ? await crypto.subtle.encrypt(params, key, data as Uint8Array<ArrayBuffer>)
      : await crypto.subtle.decrypt(params, key, data as Uint8Array<ArrayBuffer>);
    return new Uint8Array(out);
  } catch (cause) {
    if (op === "decrypt") throw new KeysError("decrypt_failed", "decryption failed: wrong passphrase or the data was modified", { cause });
    throw new KeysError("storage", "encryption failed", { cause });
  }
}

function freshBytes(random: RandomSource, n: number): Uint8Array {
  const b = random(n);
  if (!(b instanceof Uint8Array) || b.length !== n) throw new KeysError("validation", "random source returned the wrong length");
  return b;
}

function aad(header: object): Uint8Array {
  return utf8(JSON.stringify(header));
}

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function parseCipher(raw: unknown, where: string): { alg: "AES-256-GCM"; iv: string } {
  const c = record(raw, where);
  exactKeys(c, ["alg", "iv"], where);
  if (c.alg !== "AES-256-GCM") throw new KeysError("unsupported_format", `${where}.alg must be AES-256-GCM`);
  return { alg: "AES-256-GCM", iv: str(c.iv, `${where}.iv`) };
}

function record(v: unknown, where: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new KeysError("unsupported_format", `${where} must be an object`);
  return v as Record<string, unknown>;
}

function exactKeys(o: Record<string, unknown>, keys: string[], where: string): void {
  const extra = Object.keys(o).filter((k) => !keys.includes(k));
  const missing = keys.filter((k) => !(k in o));
  if (extra.length || missing.length) {
    throw new KeysError("unsupported_format", `${where} fields differ from the format (extra: ${extra.join(",") || "-"}, missing: ${missing.join(",") || "-"})`);
  }
}

function str(v: unknown, where: string): string {
  if (typeof v !== "string" || v.length === 0) throw new KeysError("unsupported_format", `${where} must be a non-empty string`);
  return v;
}

function int(v: unknown, where: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v)) throw new KeysError("unsupported_format", `${where} must be an integer`);
  return v;
}

function vaultIdString(v: unknown): string {
  if (typeof v !== "string" || !/^[0-9a-f]{32}$/.test(v)) throw new KeysError("unsupported_format", "vaultId must be 32 lowercase hex characters");
  return v;
}

function decode64(s: string, where: string, length?: number): Uint8Array {
  let b: Uint8Array;
  try {
    b = base64.decode(s);
  } catch (cause) {
    throw new KeysError("unsupported_format", `${where} is not base64`, { cause });
  }
  if (length !== undefined && b.length !== length) throw new KeysError("unsupported_format", `${where} must be ${length} bytes`);
  return b;
}
