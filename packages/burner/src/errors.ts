/** Typed errors for the burner engine. */

export type BurnerErrorKind =
  /** The input failed local checks. Nothing was sent. */
  | "validation"
  /** Another runner holds the job, or saved a newer version first. */
  | "busy"
  | "not_found"
  /** The user declined an approval. The job stays where it was. */
  | "rejected"
  /**
   * Something is still in flight (a 1Click status or an on-chain receipt did
   * not settle within the wait). Run the job again later; it resumes.
   */
  | "pending"
  /** The job cannot continue safely on its own; a person has to look. */
  | "needs_attention"
  /** An RPC call to the chain failed. */
  | "chain"
  | "storage";

export class BurnerError extends Error {
  override readonly name = "BurnerError";
  readonly kind: BurnerErrorKind;

  constructor(kind: BurnerErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.kind = kind;
  }
}

export function isBurnerError(e: unknown, kind?: BurnerErrorKind): e is BurnerError {
  return e instanceof BurnerError && (kind === undefined || e.kind === kind);
}
