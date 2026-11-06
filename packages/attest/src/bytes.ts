/** Isomorphic byte helpers: no Buffer, no node:crypto — runs in Node and the browser. */

const encoder = new TextEncoder();

export function utf8(s: string): Uint8Array {
  return encoder.encode(s);
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) {
    throw new Error(`invalid hex string (length ${clean.length})`);
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function toHex(bytes: Uint8Array | ArrayBuffer): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of u8) s += b.toString(16).padStart(2, "0");
  return s;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

async function subtleDigest(
  algorithm: "SHA-256" | "SHA-384",
  data: Uint8Array,
): Promise<Uint8Array> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("WebCrypto subtle API unavailable");
  // Copy into a fresh ArrayBuffer so typed-array offset/length can't confuse TS or subtle.
  const buf = new Uint8Array(data).buffer as ArrayBuffer;
  return new Uint8Array(await subtle.digest(algorithm, buf));
}

export const sha256 = (data: Uint8Array) => subtleDigest("SHA-256", data);
export const sha384 = (data: Uint8Array) => subtleDigest("SHA-384", data);

export async function sha256Hex(data: Uint8Array): Promise<string> {
  return toHex(await sha256(data));
}
