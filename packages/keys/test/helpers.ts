import { MIN_KDF } from "../src/envelope.js";
import { createSeedVault, type SeedVaultOptions } from "../src/vault.js";

/** Public BIP-39 test phrase. Test-only: never fund an address derived from it. */
export const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

/**
 * Child private keys at m/44'/60'/0'/0'/n' for TEST_MNEMONIC, computed
 * independently with Python's standard library (PBKDF2-HMAC-SHA512 seed,
 * HMAC-SHA512 hardened BIP-32 steps), not with the libraries under test.
 * The seed it produced, 5eb00bbd...ce9e38e4, matches the published BIP-39 vector.
 */
export const HARDENED_VECTORS: Record<number, `0x${string}`> = {
  0: "0xcbf330e6b543631f5a5b8c1b6f567660819fec9cc4d86f8131a0a58f76f8c158",
  1: "0xb076969ffbfc3ba7153d1a01abc882c4ca576322e21beee24d14551193ed9642",
  2147483647: "0x04dbd5a38527fe0fd26133b5587bea1a6d473fe3d97a02b5e504966ece9d5f83",
};

export const PASS = "correct horse battery staple";

/** Weakest accepted Argon2id cost, to keep tests fast. Production uses DEFAULT_KDF. */
export const FAST: SeedVaultOptions = { kdf: MIN_KDF };

export function counterRandom(): (n: number) => Uint8Array {
  let c = 1;
  return (n) => Uint8Array.from({ length: n }, () => c++ & 0xff);
}

export async function importedVault(opts: SeedVaultOptions = {}) {
  const vault = createSeedVault({ ...FAST, ...opts });
  await vault.importMnemonic(TEST_MNEMONIC, PASS);
  return vault;
}
