/**
 * Seed vault, hardened derivation and the derived-address book.
 * Secrets never leave the device and are only used through signing calls.
 *
 * Browser-safe entry point. Durable adapters live in subpaths:
 * `@shelter/keys/idb` (IndexedDB) and `@shelter/keys/sqlite` (Node only).
 */

export { createSeedVault, deriveHardened, normalizeMnemonic } from "./vault.js";
export type { DerivedKey, SeedVault, SeedVaultOptions } from "./vault.js";

export { createAddressBook } from "./address-book.js";
export type { AddressBook, AllocateInput, RecoverOptions, RecoverResult } from "./address-book.js";

export { createMemoryStore } from "./store.js";
export type { AddressPurpose, AddressRecord, AddressStatus, BookState, BookUpdate, KeyStore } from "./store.js";

export { derivationPath, MAX_INDEX, PATH_PREFIX } from "./derivation.js";
export { DEFAULT_KDF, MAX_KDF, MIN_KDF } from "./envelope.js";
export type { BackupEnvelopeV1, KdfParams, RandomSource, VaultEnvelopeV1 } from "./envelope.js";

export { isKeysError, KeysError } from "./errors.js";
export type { KeysErrorKind } from "./errors.js";
