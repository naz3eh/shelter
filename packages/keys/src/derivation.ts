/**
 * Hardened EVM key derivation and local signing.
 *
 * Path: m/44'/60'/0'/0'/n' (BIP-44 coin type 60), hardened at every level,
 * including the change and index levels. A leaked child private key plus the
 * parent public data cannot be used to compute the parent or its siblings,
 * which is not true for the usual non-hardened m/44'/60'/0'/0/n.
 * Consequence: these addresses differ from what MetaMask and most wallets
 * derive from the same phrase, and an xpub cannot be used to watch them.
 *
 * Private keys only ever exist as Uint8Array for the length of one signing
 * call and are zeroed afterwards. They are never converted to hex strings.
 */

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import type { HDKey } from "@scure/bip32";
import {
  getAddress,
  hashMessage,
  hashTypedData,
  keccak256,
  serializeSignature,
  serializeTransaction,
  type Hex,
  type LocalAccount,
  type SerializeTransactionFn,
  type TransactionSerializable,
  type TypedDataDefinition,
} from "viem";
import { toAccount, type CustomSource } from "viem/accounts";
import { KeysError } from "./errors.js";

/** Highest index: hardened indexes are 0 .. 2^31 - 1. */
export const MAX_INDEX = 2 ** 31 - 1;
export const PATH_PREFIX = "m/44'/60'/0'/0'";

export function derivationPath(index: number): string {
  assertIndex(index);
  return `${PATH_PREFIX}/${index}'`;
}

export function assertIndex(index: number): void {
  if (!Number.isSafeInteger(index) || index < 0 || index > MAX_INDEX) {
    throw new KeysError("validation", `derivation index must be an integer in 0..${MAX_INDEX}`);
  }
}

/** Child private key at `index`. The caller must wipe the returned buffer. */
export function childPrivateKey(root: HDKey, index: number): Uint8Array {
  const child = root.derive(derivationPath(index));
  try {
    if (!child.privateKey) throw new KeysError("locked", "no private key available");
    return Uint8Array.from(child.privateKey);
  } finally {
    child.wipePrivateData();
  }
}

/** Checksummed EVM address for a secp256k1 private key. */
export function addressOf(privateKey: Uint8Array): `0x${string}` {
  const pub = secp256k1.getPublicKey(privateKey, false);
  const hash = keccak_256(pub.subarray(1));
  return getAddress(toHex(hash.subarray(12)));
}

/** Signs a 32-byte digest. Low-s, RFC 6979 deterministic nonces (noble defaults). */
function signDigest(privateKey: Uint8Array, digest: Hex) {
  const raw = secp256k1.sign(hexToBytes(digest), privateKey, { prehash: false, format: "recovered" });
  const sig = secp256k1.Signature.fromBytes(raw, "recovered");
  if (sig.recovery === undefined) throw new KeysError("storage", "signature has no recovery id");
  return {
    r: toHex(numberTo32Bytes(sig.r)),
    s: toHex(numberTo32Bytes(sig.s)),
    // Same shape as viem's sign(): legacy serialisation needs v, typed ones use yParity.
    v: sig.recovery ? 28n : 27n,
    yParity: sig.recovery,
  } as const;
}

/**
 * A viem `LocalAccount` whose signing operations ask `withKey` for the private
 * key each time. `withKey` throws when the vault is locked, so a locked vault
 * blocks every signature, including ones on an account object taken earlier.
 */
export function signingAccount(
  address: `0x${string}`,
  withKey: <T>(use: (privateKey: Uint8Array) => T) => T,
): LocalAccount {
  const sign = (digest: Hex) => withKey((sk) => signDigest(sk, digest));
  // Same steps as viem's own signTransaction (accounts/utils/signTransaction.ts):
  // EIP-4844 signs the payload without sidecars, then serialises with the signature.
  const signTransaction = async (transaction: TransactionSerializable, options?: { serializer?: SerializeTransactionFn<TransactionSerializable> }) => {
    const serializer = options?.serializer ?? serializeTransaction;
    const signable = (transaction.type === "eip4844" ? { ...transaction, sidecars: false } : transaction) as TransactionSerializable;
    const sig = sign(keccak256(await serializer(signable)));
    return serializer(transaction, sig);
  };
  const source: CustomSource = {
    address,
    async sign({ hash }) {
      return serializeSignature(sign(hash));
    },
    async signMessage({ message }) {
      return serializeSignature(sign(hashMessage(message)));
    },
    signTransaction: signTransaction as CustomSource["signTransaction"],
    async signTypedData(typedData) {
      return serializeSignature(sign(hashTypedData(typedData as TypedDataDefinition)));
    },
  };
  return toAccount(source) as LocalAccount;
}

function numberTo32Bytes(n: bigint): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

function toHex(b: Uint8Array): `0x${string}` {
  return `0x${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`;
}

function hexToBytes(h: Hex): Uint8Array {
  const s = h.slice(2);
  if (s.length !== 64 || !/^[0-9a-fA-F]+$/.test(s)) throw new KeysError("validation", "digest must be 32 bytes of hex");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
