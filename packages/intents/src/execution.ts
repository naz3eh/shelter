/**
 * Moving funds through 1Click: notifying a deposit (deposit leg), and
 * spending the confidential balance with a signed intent (withdrawal leg).
 * Also the confidential balance read.
 *
 * Signed intent execution
 * (https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/signed-intent-execution,
 * retrieved 2026-11-08):
 *   quote (depositType CONFIDENTIAL_INTENTS, dry false)
 *   -> POST /v0/generate-intent { type: swap_transfer, standard: nep413, signerId, depositAddress }
 *   -> the wallet signs the returned NEP-413 payload unchanged
 *   -> POST /v0/submit-intent { type: swap_transfer, signedData }
 *   -> GET /v0/status?depositAddress=...
 *
 * The confidential balance lives on `intents.far`, not `intents.near`
 * (https://docs.near-intents.org/integration/market-makers/confidential-liquidity,
 * retrieved 2026-11-08). It has no public RPC, its versioned-nonce salt is
 * the published production constant `e110f317`, and balances there are
 * `imt:<treasury>:<public asset id>` tokens. Observed live on 2026-11-08:
 * generate-intent for a CONFIDENTIAL_INTENTS quote returns exactly that
 * (recipient intents.far, salt e110f317, the imt token, deadline 3 days out).
 *
 * The generated intent comes from 1Click, so it is checked before it is
 * shown to the wallet: it must be addressed to the contract that holds the
 * quote's deposit balance, signed as the balance owner, carry a versioned
 * nonce with that contract's salt, expire within a bounded window, and
 * contain nothing but `transfer`s of the quote's origin asset (in that
 * contract's token form) totalling at most the quoted input, to the quote's
 * deposit address. Anything else stops the flow (`intent_mismatch`) before
 * the wallet is asked. Neither call is ever retried.
 */

import { base64 } from "@scure/base";
import * as z from "zod/mini";
import { IntentsError } from "./errors.js";
import { INTENTS_CONTRACT, type NearView } from "./near-rpc.js";
import { signNep413Checked, type Nep413Payload, type Nep413Signer } from "./nep413.js";
import { decodeVersionedNonce } from "./nonce.js";
import { assertFundable } from "./quote.js";
import { assertKeyRegistered, toSignedData, type SignedNep413 } from "./session.js";
import { mapStatusResponse } from "./status.js";
import type { Transport } from "./transport.js";
import type { Quote, StatusResult } from "./types.js";
import { describeIssue } from "./wire.js";

const uint = () => z.string().check(z.regex(/^(0|[1-9][0-9]*)$/));

const GenerateIntentResponse = z.object({
  intent: z.looseObject({
    standard: z.literal("nep413"),
    payload: z.looseObject({
      recipient: z.string(),
      nonce: z.string(),
      message: z.string(),
      callbackUrl: z.optional(z.nullable(z.string())),
    }),
  }),
  correlationId: z.string(),
});
const SubmitIntentResponse = z.object({ intentHash: z.string().check(z.minLength(1)), correlationId: z.string() });
const BalancesResponse = z.object({
  balances: z.array(z.looseObject({ tokenId: z.string().check(z.minLength(1)), available: uint(), source: z.string() })),
});

/** Confidential Intents contract (private balances). */
export const CONFIDENTIAL_INTENTS_CONTRACT = "intents.far";
/** intents.far versioned-nonce salt, a published production constant (no public RPC to read it). */
export const CONFIDENTIAL_INTENTS_SALT = "e110f317";
/** Treasury account that backs `imt:` tokens on intents.far. */
export const CONFIDENTIAL_TREASURY = "51e8f94d77b5e90dc9852ca6113771e11e8382ce69473a75e313e41665de7cbe";
/** A generated intent may stay valid at most this long (1Click used 3 days on 2026-11-08). */
const MAX_INTENT_LIFETIME_MS = 7 * 24 * 60 * 60_000;

/** Token id of a public asset id as held on intents.far. */
export function confidentialTokenId(assetId: string): string {
  return `imt:${CONFIDENTIAL_TREASURY}:${assetId}`;
}

/** What a generated intent must match, by where the quote's balance lives. */
export interface IntentExpectation {
  contract: string;
  salt: string;
  tokenId: string;
}

/** Keys allowed in the signed NEP-413 message. */
const MESSAGE_KEYS = new Set(["deadline", "intents", "signer_id"]);
const TRANSFER_KEYS = new Set(["intent", "receiver_id", "tokens", "memo"]);

export interface Balance {
  tokenId: string;
  /** Base units. */
  available: string;
  source: string;
}

/** What the wallet is asked to approve, for display before signing. */
export interface IntentSummary {
  signerId: string;
  deadline: string;
  transfers: { receiverId: string; tokenId: string; amount: string; memo?: string }[];
}

export interface WithdrawResult {
  intentHash: string;
  correlationId: string;
  summary: IntentSummary;
  status: StatusResult;
}

export interface ExecutionDeps {
  transport: Transport;
  near: NearView;
  signerPublicKey: string;
  now?: () => Date;
}

/** GET /v0/account/balances with a User-Session token. */
export async function getBalances(
  transport: Transport,
  accessToken: string,
  opts: { tokenIds?: string[]; signal?: AbortSignal } = {},
): Promise<Balance[]> {
  const raw = await transport.request({
    method: "GET",
    path: "/v0/account/balances",
    query: { tokenIds: opts.tokenIds?.length ? opts.tokenIds.join(",") : undefined },
    sessionToken: accessToken,
    retry: true,
    signal: opts.signal,
  });
  const p = BalancesResponse.safeParse(raw);
  if (!p.success) throw new IntentsError("malformed_response", `/v0/account/balances: ${describeIssue(p.error)}`);
  return p.data.balances.map((b) => ({ tokenId: b.tokenId, available: b.available, source: b.source }));
}

/**
 * POST /v0/deposit/submit: tells 1Click the on-chain transfer into
 * `quote.depositAddress` was sent. Optional (1Click also watches the chain)
 * but speeds settlement. Not retried; a repeat is harmless, so callers may
 * call it again by hand.
 */
export async function submitDeposit(
  deps: Pick<ExecutionDeps, "transport" | "signerPublicKey">,
  quote: Quote,
  txHash: string,
  opts: { signal?: AbortSignal } = {},
): Promise<StatusResult> {
  if (!quote.depositAddress) throw new IntentsError("not_fundable", "quote has no deposit address");
  if (quote.request.depositType !== "ORIGIN_CHAIN") {
    throw new IntentsError("validation", "deposit notification only applies to ORIGIN_CHAIN deposits");
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new IntentsError("validation", "txHash must be a 32-byte 0x hash");
  const raw = await deps.transport.request({
    method: "POST",
    path: "/v0/deposit/submit",
    body: { txHash, depositAddress: quote.depositAddress, ...(quote.depositMemo ? { memo: quote.depositMemo } : {}) },
    retry: false,
    signal: opts.signal,
  });
  return mapStatusResponse(raw, quote.depositAddress, { signerPublicKey: deps.signerPublicKey });
}

/**
 * Validates an intent payload 1Click generated for `quote` and returns what
 * it does. Throws `intent_mismatch` on anything unexpected.
 */
export function checkGeneratedIntent(
  payload: Nep413Payload,
  quote: Quote,
  ownerAccountId: string,
  expect: IntentExpectation,
  now: Date,
): IntentSummary {
  const fail = (why: string): never => {
    throw new IntentsError("intent_mismatch", `refusing to sign the generated intent: ${why}`, { correlationId: quote.quoteId });
  };
  if (payload.recipient !== expect.contract) fail(`recipient is ${payload.recipient}, not ${expect.contract}`);
  if (payload.callbackUrl !== undefined) fail("it carries a callback URL");

  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(payload.message) as Record<string, unknown>;
  } catch {
    return fail("the message is not JSON");
  }
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) fail("the message is not an object");
  for (const k of Object.keys(msg)) if (!MESSAGE_KEYS.has(k)) fail(`unexpected message field "${k}"`);
  if (msg.signer_id !== ownerAccountId) fail(`signer_id is ${String(msg.signer_id)}, not ${ownerAccountId}`);

  const deadline = typeof msg.deadline === "string" ? Date.parse(msg.deadline) : Number.NaN;
  if (Number.isNaN(deadline)) fail("deadline is missing or invalid");
  if (deadline <= now.getTime()) fail("deadline has already passed");
  // Not bound to the quote deadline: 1Click issues intents valid for days.
  // After the quote deadline a late transfer into the deposit address is
  // refunded to the owner's balance, so only an unbounded lifetime is refused.
  if (deadline > now.getTime() + MAX_INTENT_LIFETIME_MS) fail("deadline is more than 7 days away");

  let nonce;
  try {
    nonce = decodeVersionedNonce(payload.nonce);
  } catch {
    return fail("nonce is not a versioned intents nonce");
  }
  if (nonce.version !== 0) fail(`unknown nonce version ${nonce.version}`);
  if (nonce.salt !== expect.salt) fail(`nonce salt ${nonce.salt} is not ${expect.contract}'s salt ${expect.salt}`);
  if (nonce.deadline.getTime() !== deadline) fail("nonce deadline differs from the message deadline");

  if (!Array.isArray(msg.intents) || msg.intents.length === 0) fail("it contains no intents");
  const origin = expect.tokenId;
  const maxIn = BigInt(quote.amountIn);
  const transfers: IntentSummary["transfers"] = [];
  let total = 0n;
  for (const it of msg.intents as unknown[]) {
    const i = it as Record<string, unknown>;
    if (!i || typeof i !== "object" || i.intent !== "transfer") fail(`intent kind "${String(i?.intent)}" is not allowed`);
    for (const k of Object.keys(i)) if (!TRANSFER_KEYS.has(k)) fail(`unexpected transfer field "${k}"`);
    if (i.receiver_id !== quote.depositAddress) fail(`transfer goes to ${String(i.receiver_id)}, not the quote deposit address`);
    if (i.memo !== undefined && typeof i.memo !== "string") fail("memo is not a string");
    const tokens = i.tokens as Record<string, unknown>;
    if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) fail("tokens is not an object");
    for (const [tokenId, amount] of Object.entries(tokens)) {
      if (tokenId !== origin) fail(`it spends ${tokenId}, but the quote spends ${origin}`);
      if (typeof amount !== "string" || !/^[1-9][0-9]*$/.test(amount)) fail("amount is not a positive integer string");
      total += BigInt(amount as string);
      transfers.push({ receiverId: i.receiver_id as string, tokenId, amount: amount as string, ...(i.memo ? { memo: i.memo as string } : {}) });
    }
  }
  if (transfers.length === 0) fail("it transfers nothing");
  if (total > maxIn) fail(`it spends ${total}, more than the quoted ${maxIn}`);
  return { signerId: ownerAccountId, deadline: new Date(deadline).toISOString(), transfers };
}

/** A signed withdrawal intent, ready to submit. Safe to persist: it holds no secret. */
export interface PreparedIntent {
  /** The quote's deposit address; the intent pays into it. */
  depositAddress: string;
  depositMemo?: string;
  signedData: SignedNep413;
  summary: IntentSummary;
  /** After this the intent can never execute. */
  deadline: string;
  /**
   * The quote's deadline. After it, 1Click refunds anything that reaches the
   * deposit address to the owner's balance, so an attempt that has not
   * executed by then can be abandoned and requoted.
   */
  quoteDeadline: string;
}

export interface SubmittedIntent {
  intentHash: string;
  correlationId: string;
}

/**
 * First half of signed intent execution: generate the intent for `quote`,
 * check it, ask `approve`, have the wallet sign it, and verify the signature
 * and key. Sends nothing that spends; the result can be persisted and
 * submitted later (or again after a crash: intents.near accepts a nonce
 * once, so re-submitting the same signed intent cannot spend twice).
 */
export async function prepareSignedIntent(
  deps: ExecutionDeps,
  quote: Quote,
  signer: Nep413Signer,
  opts: { approve?: (s: IntentSummary) => Promise<boolean> | boolean; signal?: AbortSignal } = {},
): Promise<PreparedIntent> {
  const now = deps.now ?? (() => new Date());
  const { signal } = opts;
  assertFundable(quote, now());
  if (quote.request.depositType !== "CONFIDENTIAL_INTENTS") {
    throw new IntentsError("validation", "signed intent execution needs a CONFIDENTIAL_INTENTS quote");
  }
  if (quote.confidentiality === "public") throw new IntentsError("confidentiality_required", "quote is not confidential");
  if (quote.request.refundTo !== signer.accountId) {
    throw new IntentsError("validation", "the quote refunds to a different account than the signer");
  }

  const raw = await deps.transport.request({
    method: "POST",
    path: "/v0/generate-intent",
    body: { type: "swap_transfer", standard: "nep413", signerId: signer.accountId, depositAddress: quote.depositAddress },
    retry: false,
    signal,
  });
  const g = GenerateIntentResponse.safeParse(raw);
  if (!g.success) throw new IntentsError("malformed_response", `/v0/generate-intent: ${describeIssue(g.error)}`);
  const p = g.data.intent.payload;
  let nonce: Uint8Array;
  try {
    nonce = base64.decode(p.nonce);
  } catch {
    throw new IntentsError("intent_mismatch", "generated nonce is not base64");
  }
  const payload: Nep413Payload = {
    message: p.message,
    nonce,
    recipient: p.recipient,
    ...(p.callbackUrl != null ? { callbackUrl: p.callbackUrl } : {}),
  };

  const confidential = quote.request.depositType === "CONFIDENTIAL_INTENTS";
  const expect: IntentExpectation = confidential
    ? { contract: CONFIDENTIAL_INTENTS_CONTRACT, salt: CONFIDENTIAL_INTENTS_SALT, tokenId: confidentialTokenId(quote.request.originAssetId) }
    : { contract: INTENTS_CONTRACT, salt: await deps.near.currentSalt({ signal }), tokenId: quote.request.originAssetId };
  const summary = checkGeneratedIntent(payload, quote, signer.accountId, expect, now());
  if (opts.approve && !(await opts.approve(summary))) {
    throw new IntentsError("signer_rejected", "withdrawal was not approved");
  }

  const { publicKey, signature } = await signNep413Checked(signer, payload, { signal, purpose: "withdraw" });
  await assertKeyRegistered(deps.near, signer.accountId, publicKey, signal);
  return {
    depositAddress: quote.depositAddress!,
    ...(quote.depositMemo ? { depositMemo: quote.depositMemo } : {}),
    signedData: toSignedData(payload, publicKey, signature),
    summary,
    deadline: summary.deadline,
    quoteDeadline: quote.deadline!,
  };
}

/**
 * Second half: POST /v0/submit-intent. Never retried automatically; a caller
 * that does not know whether an earlier submit landed may submit the same
 * `prepared` again, or read the status first.
 */
export async function submitSignedIntent(
  deps: Pick<ExecutionDeps, "transport">,
  prepared: PreparedIntent,
  opts: { signal?: AbortSignal } = {},
): Promise<SubmittedIntent> {
  const sub = await deps.transport.request({
    method: "POST",
    path: "/v0/submit-intent",
    body: { type: "swap_transfer", signedData: prepared.signedData },
    retry: false,
    signal: opts.signal,
  });
  const s = SubmitIntentResponse.safeParse(sub);
  if (!s.success) throw new IntentsError("malformed_response", `/v0/submit-intent: ${describeIssue(s.error)}`);
  return { intentHash: s.data.intentHash, correlationId: s.data.correlationId };
}

/**
 * Spends from the confidential balance per a verified execution quote whose
 * depositType is CONFIDENTIAL_INTENTS, in one call: prepare, submit, read
 * the status. `approve` sees exactly what will be signed and must resolve
 * true; the wallet then shows it again. Callers that must survive a crash
 * between signing and submitting use the two halves and persist in between.
 */
export async function executeSignedIntent(
  deps: ExecutionDeps,
  quote: Quote,
  signer: Nep413Signer,
  opts: { approve?: (s: IntentSummary) => Promise<boolean> | boolean; signal?: AbortSignal } = {},
): Promise<WithdrawResult> {
  const prepared = await prepareSignedIntent(deps, quote, signer, opts);
  const sub = await submitSignedIntent(deps, prepared, { signal: opts.signal });
  const statusRaw = await deps.transport.request({
    method: "GET",
    path: "/v0/status",
    query: { depositAddress: prepared.depositAddress, depositMemo: prepared.depositMemo },
    retry: true,
    signal: opts.signal,
  });
  return {
    ...sub,
    summary: prepared.summary,
    status: mapStatusResponse(statusRaw, prepared.depositAddress, { signerPublicKey: deps.signerPublicKey }),
  };
}
