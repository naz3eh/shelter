/** Typed errors for Shelter Connect. */

export type ConnectErrorKind =
  /** Bad input from the caller or the dapp. Nothing was signed or sent. */
  | "validation"
  /** The method is not one Connect serves. */
  | "unsupported"
  /** The linkage check refused the request. Nothing was signed. */
  | "blocked"
  /** The user declined. Nothing was signed. */
  | "rejected"
  | "not_found"
  /** The account is closing or closed, or another runner changed it first. */
  | "busy"
  /** Something is still in flight; run the same call again later. */
  | "pending"
  /** A person has to look before Connect continues. */
  | "needs_attention"
  /** The chain refused or could not run the transaction (for example it would revert). */
  | "chain"
  | "storage";

export class ConnectError extends Error {
  override readonly name = "ConnectError";
  readonly kind: ConnectErrorKind;

  constructor(kind: ConnectErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.kind = kind;
  }
}

export function isConnectError(e: unknown, kind?: ConnectErrorKind): e is ConnectError {
  return e instanceof ConnectError && (kind === undefined || e.kind === kind);
}

/**
 * EIP-1193 / JSON-RPC error a dapp understands. A blocked request is
 * reported as a user rejection (4001): every dapp handles that path, and the
 * message says why.
 */
export function toRpcError(e: unknown): { code: number; message: string } {
  if (e instanceof ConnectError) {
    switch (e.kind) {
      case "blocked":
        return { code: 4001, message: `Blocked by Shelter: ${e.message}` };
      case "rejected":
        return { code: 4001, message: "User rejected the request" };
      case "unsupported":
        return { code: 4200, message: e.message };
      case "validation":
        return { code: -32602, message: e.message };
      case "chain":
        return { code: -32000, message: e.message };
      default:
        return { code: -32603, message: e.message };
    }
  }
  return { code: -32603, message: "Internal error" };
}
