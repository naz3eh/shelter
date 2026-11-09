/**
 * Typed errors for the seed vault and address book.
 *
 * Messages never include a passphrase, mnemonic, seed or private key.
 */

export type KeysErrorKind =
  /** Input failed local validation (bad index, malformed address, bad parameters). */
  | "validation"
  /** The mnemonic is not a valid English BIP-39 phrase (word list or checksum). */
  | "invalid_mnemonic"
  /** The operation needs an unlocked vault. */
  | "locked"
  /** No vault exists in the store yet. */
  | "no_vault"
  /** A vault already exists; creating or importing would overwrite it. */
  | "vault_exists"
  /**
   * Decryption failed: wrong passphrase, or the ciphertext or its authenticated
   * header was changed. AES-GCM cannot tell these apart, by design.
   */
  | "decrypt_failed"
  /** A stored or imported record is not a format this version understands. */
  | "unsupported_format"
  /** The address was retired and must never be handed out or used for a new action again. */
  | "retired"
  /** No address book entry for that index or address. */
  | "not_found"
  /** A write would contradict durable state (index reused, address mismatch, other seed). */
  | "conflict"
  /** The persistence adapter failed. */
  | "storage";

export class KeysError extends Error {
  override readonly name = "KeysError";
  readonly kind: KeysErrorKind;

  constructor(kind: KeysErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.kind = kind;
  }
}

export function isKeysError(e: unknown, kind?: KeysErrorKind): e is KeysError {
  return e instanceof KeysError && (kind === undefined || e.kind === kind);
}
