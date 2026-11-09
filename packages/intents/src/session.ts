/**
 * User-Session: proves to 1Click that the caller controls the NEAR account
 * that owns the confidential balance, and holds the resulting tokens.
 *
 * Flow (https://docs.near-intents.org/api-reference/user-auth/authenticate-user-with-signed-data,
 * retrieved 2026-11-08):
 * 1. Build an empty intent `{"deadline","intents":[],"signer_id"}` with a
 *    versioned, timestamped nonce and recipient `intents.near`.
 * 2. The wallet signs it with NEP-413. The signature is verified locally
 *    and the key is checked against `intents.near` before anything is sent.
 * 3. POST /v0/auth/authenticate returns an access and a refresh token.
 * 4. The access token is refreshed through POST /v0/auth/refresh shortly
 *    before it expires. When that fails the session is over.
 *
 * An empty intent moves nothing; it only invalidates its own nonce.
 * Tokens live in this object's closure only: never persisted, never logged,
 * and redacted from every error the transport builds.
 */

import { base64 } from "@scure/base";
import * as z from "zod/mini";
import { assertIntentsAccountId } from "./accounts.js";
import { IntentsError, isIntentsError } from "./errors.js";
import { INTENTS_CONTRACT, type NearView } from "./near-rpc.js";
import { signNep413Checked, type Nep413Payload, type Nep413Signer } from "./nep413.js";
import { encodeVersionedNonce, timestampedRandomBytes } from "./nonce.js";
import type { Transport } from "./transport.js";

/** Login message lifetime. The server rejects a start time more than 5 minutes off. */
const LOGIN_DEADLINE_MS = 5 * 60_000;
/** Refresh this long before the access token expires. */
const REFRESH_MARGIN_MS = 60_000;

const AuthResponse = z.object({
  accessToken: z.string().check(z.minLength(1)),
  refreshToken: z.string().check(z.minLength(1)),
  expiresIn: z.number().check(z.positive()),
  refreshExpiresIn: z.number().check(z.positive()),
});
const RefreshResponse = z.object({
  accessToken: z.string().check(z.minLength(1)),
  expiresIn: z.number().check(z.positive()),
});

/** The `nep413` MultiPayload shape intents.near and 1Click accept as `signedData`. */
export interface SignedNep413 {
  standard: "nep413";
  payload: { message: string; nonce: string; recipient: string };
  public_key: string;
  signature: string;
}

export interface UserSession {
  readonly accountId: string;
  /** The key that signed in; it is registered on intents.near for `accountId`. */
  readonly publicKey: string;
  /** A valid access token, refreshed when close to expiry. Throws `session_expired` when it cannot be. */
  accessToken(opts?: { signal?: AbortSignal }): Promise<string>;
  /** When the current access token expires. */
  expiresAt(): Date;
  /** When the session ends unless the user signs in again. */
  refreshExpiresAt(): Date;
  /** Forgets both tokens. */
  end(): void;
}

export interface SignInOptions {
  transport: Transport;
  signer: Nep413Signer;
  near: NearView;
  now?: () => Date;
  random?: (n: number) => Uint8Array;
  signal?: AbortSignal;
}

/** Builds the empty-intent NEP-413 payload a User-Session login signs. */
export function loginPayload(accountId: string, salt: string, now: Date, random?: (n: number) => Uint8Array): Nep413Payload {
  assertIntentsAccountId(accountId, "accountId");
  const deadline = new Date(now.getTime() + LOGIN_DEADLINE_MS);
  return {
    // Key order matches the official SDK's IntentSignerNEP413.
    message: JSON.stringify({ deadline: deadline.toISOString(), intents: [], signer_id: accountId }),
    nonce: encodeVersionedNonce(salt, deadline, timestampedRandomBytes(now, random)),
    recipient: INTENTS_CONTRACT,
  };
}

export function toSignedData(p: Nep413Payload, publicKey: string, signature: string): SignedNep413 {
  return {
    standard: "nep413",
    payload: { message: p.message, nonce: base64.encode(p.nonce), recipient: p.recipient },
    public_key: publicKey,
    signature,
  };
}

/** Throws `key_not_registered` unless `publicKey` may sign intents for `accountId`. */
export async function assertKeyRegistered(near: NearView, accountId: string, publicKey: string, signal?: AbortSignal): Promise<void> {
  if (!(await near.hasPublicKey(accountId, publicKey, { signal }))) {
    throw new IntentsError(
      "key_not_registered",
      `${publicKey} is not registered for ${accountId} on ${INTENTS_CONTRACT}; call add_public_key from the wallet first`,
    );
  }
}

export async function signIn(opts: SignInOptions): Promise<UserSession> {
  const now = opts.now ?? (() => new Date());
  const { signer, near, transport, signal } = opts;
  assertIntentsAccountId(signer.accountId, "signer.accountId");

  const salt = await near.currentSalt({ signal });
  const payload = loginPayload(signer.accountId, salt, now(), opts.random);
  const { publicKey, signature } = await signNep413Checked(signer, payload, { signal, purpose: "sign-in" });
  await assertKeyRegistered(near, signer.accountId, publicKey, signal);

  const raw = await transport.request({
    method: "POST",
    path: "/v0/auth/authenticate",
    body: { signedData: toSignedData(payload, publicKey, signature) },
    retry: false,
    signal,
  });
  const parsed = AuthResponse.safeParse(raw);
  if (!parsed.success) throw new IntentsError("malformed_response", "/v0/auth/authenticate: unexpected response shape");

  const t0 = now().getTime();
  let access = parsed.data.accessToken;
  let refresh: string | undefined = parsed.data.refreshToken;
  let accessExp = t0 + parsed.data.expiresIn * 1000;
  const refreshExp = t0 + parsed.data.refreshExpiresIn * 1000;
  let inflight: Promise<string> | undefined;

  const doRefresh = async (s?: AbortSignal): Promise<string> => {
    if (!refresh || now().getTime() >= refreshExp) {
      session.end();
      throw new IntentsError("session_expired", "the 1Click session has expired; sign in again");
    }
    let r: unknown;
    try {
      r = await transport.request({
        method: "POST",
        path: "/v0/auth/refresh",
        body: { refreshToken: refresh },
        redact: [refresh, access],
        retry: false,
        signal: s,
      });
    } catch (e) {
      if (isIntentsError(e, "unauthorized")) {
        session.end();
        throw new IntentsError("session_expired", "the 1Click session was rejected on refresh; sign in again");
      }
      throw e;
    }
    const p = RefreshResponse.safeParse(r);
    if (!p.success) throw new IntentsError("malformed_response", "/v0/auth/refresh: unexpected response shape");
    access = p.data.accessToken;
    accessExp = now().getTime() + p.data.expiresIn * 1000;
    return access;
  };

  const session: UserSession = {
    accountId: signer.accountId,
    publicKey,
    async accessToken(o = {}) {
      if (!refresh) throw new IntentsError("session_expired", "the session was ended; sign in again");
      if (now().getTime() < accessExp - REFRESH_MARGIN_MS) return access;
      inflight ??= doRefresh(o.signal).finally(() => {
        inflight = undefined;
      });
      return inflight;
    },
    expiresAt: () => new Date(accessExp),
    refreshExpiresAt: () => new Date(refreshExp),
    end() {
      access = "";
      refresh = undefined;
      accessExp = 0;
    },
  };
  return session;
}
