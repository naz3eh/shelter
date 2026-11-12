# 1Click integration reference (G4)

What `packages/intents` implements against the 1Click API, with the official source for every wire detail.
Retrieved 2026-11-07 unless stated otherwise.
Re-check these sources before changing wire behaviour; the API reference wins over this file.

## Sources

| Topic | Source |
| --- | --- |
| OpenAPI document (`info.version` 0.1.10) | https://1click.chaindefuser.com/docs/v0/openapi.yaml |
| Confidential swaps, the two integration paths | https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/confidential-swaps |
| Signed intent execution (withdrawing from a confidential balance) | https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/signed-intent-execution |
| Partner JWT and User-Session token | https://docs.near-intents.org/integration/distribution-channels/1click-api/authentication |
| User-Session authentication, signer ids per wallet type | https://docs.near-intents.org/api-reference/user-auth/authenticate-user-with-signed-data |
| Fees | https://docs.near-intents.org/resources/fees |
| Quote signature verification | https://docs.near-intents.org/integration/distribution-channels/1click-api/verify-quote-signature |
| Signature field selection and manager key | `@defuse-protocol/one-click-sdk-typescript` 0.1.26 (ISC), `verifyQuoteSignature()` |
| Supported tokens (live) | `GET https://1click.chaindefuser.com/v0/tokens` |

## Decisions

- **Path:** the "embedded account" path.
  Funds rest in the owner's Confidential Intents balance between the deposit leg and the withdrawal leg.
  The foreign-to-foreign path (only setting `confidentiality`) is a one-shot swap and cannot hold a balance between legs, so it does not fit Shelter.
- **Balance owner:** a NEAR account signing with `nep413` (decided 2026-11-07).
  Its public key must be registered on `intents.near` with `add_public_key` first; that is a public NEAR transaction and needs human approval.
  The signer is injected, so the client never holds the key.
- **Runtime:** Node 24 or newer (`engines`), CI on Node 24 and 26, for the built-in `node:sqlite` used by the CLI address book in G5.
- **SDK:** the official SDK is not a dependency.
  It configures credentials through a global `OpenAPI` object and pulls axios and form-data into browser bundles.
  The client is written against the OpenAPI document with an injected `fetch`.
  Quote-signature logic mirrors the SDK and is tested for byte-equal serialisation against the SDK's `json-stable-stringify`.

## Credentials

| Credential | Header | Required | Where it lives |
| --- | --- | --- | --- |
| Partner JWT (`ONECLICK_JWT`) | `X-API-Key` | Yes, for every confidential call: `/v0/quote` with `confidentiality` other than `public`, `/v0/generate-intent` and `/v0/submit-intent`. Public quotes work without it but pay 25 bps more. | CLI or server configuration only (`.env`). Never in a browser bundle. |
| User-Session access token | `Authorization: Bearer` | Only for `/v0/account/balances` and `/v0/account/history`. Never sent to `/v0/quote`: there a Bearer token is read as a partner JWT and rejected with 401 "Invalid token". | Memory only. Never persisted. Obtained by the NEP-413 sign-in. |

The 401 text "User authentication is required for confidential intent quotes" means the partner key is missing, not the user session (verified 2026-11-08).
The client refuses a confidential quote or signed-intent execution locally (`partner_auth_required`) when no partner key is configured, and the CLI checks before asking Meteor to sign.

The hackathon FAQ (Q-006) and `docs/SPEC.md` quote a 0.2% no-key fee; the fees page above supersedes that figure.
The client never hardcodes a fee: it reports `withdrawFee`, `refundFee` and the USD amounts from each quote.

## Quote request (`POST /v0/quote`)

The client sends exactly these fields and nothing else:

| Field | Shelter value |
| --- | --- |
| `dry` | `true` unless an execution quote is requested explicitly |
| `swapType` | `EXACT_INPUT` (deposit leg) or `EXACT_OUTPUT` (withdrawal leg: the destination gets the exact amount) |
| `slippageTolerance` | basis points, default 50, at most 1000 |
| `originAsset`, `destinationAsset` | 1Click asset ids, checked against the live token list |
| `amount` | base-unit integer string |
| `depositType`, `recipientType`, `refundType` | set per leg, see below |
| `recipient`, `refundTo` | validated against the type: EVM address on `eth`/`base`, or an Intents account id |
| `deadline` | ISO-8601, default now + 30 minutes, between 1 minute and 24 hours ahead |
| `confidentiality` | `advanced` by default; `public` is refused unless the client is created with `allowPublic` |

Never sent: `connectedWallets` and `sessionId` (they would give 1Click the user's address set or a cross-request identifier), `appFees`, `referral`, `rebates`, `insured`, `virtualChain*`, `customRecipientMsg`.
A test asserts the exact key set.

### Legs

| Leg | `depositType` | `recipientType` / `recipient` | `refundType` / `refundTo` |
| --- | --- | --- | --- |
| Deposit: source wallet to confidential balance | `ORIGIN_CHAIN` | `CONFIDENTIAL_INTENTS` / owner account | `CONFIDENTIAL_INTENTS` / owner account |
| Withdrawal: confidential balance to a fresh address | `CONFIDENTIAL_INTENTS` | `DESTINATION_CHAIN` / fresh EVM address | `CONFIDENTIAL_INTENTS` / owner account |

Refunds always target the confidential balance.
The leg builders have no parameter for a public refund.
If 1Click rejects a confidential refund on a route, the quote fails and the flow must stop and report it.

## Quote response checks

1. The body must match the documented schema (unknown extra fields are allowed).
2. The echoed `quoteRequest` must equal what was sent for every routing field and for `confidentiality`.
   `confidentiality` is not covered by the 1Click signature, so this echo check is the only protection against a silent downgrade.
3. The ed25519 signature must verify against the 1Click manager key `ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc` (from the SDK).
   Dry quotes sign the amounts only; execution quotes also sign `depositAddress`, `deadline` and fees.
4. An execution quote must carry `depositAddress` and `deadline`.

The API has no quote id.
`Quote.quoteId` is the response `correlationId`, for logs and support.
Approvals bind to `depositAddress` plus the verified `signature`.
`assertFundable(quote, now)` refuses dry quotes, unverified quotes, and quotes within 5 minutes of their deadline.

## Status (`GET /v0/status`)

Documented states: `PENDING_DEPOSIT`, `KNOWN_DEPOSIT_TX`, `PROCESSING`, `SUCCESS`, `INCOMPLETE_DEPOSIT`, `REFUNDED`, `FAILED`.
Anything else maps to `UNKNOWN` with the raw string kept, never to success.
The embedded quote is verified separately and reported as `quoteVerified`; a status read does not fail on it.

## Retry and timeouts

- Per-attempt timeout 15 s; caller cancellation through `AbortSignal`.
- Retried (at most 2 extra attempts, exponential backoff with jitter, `Retry-After` honoured, capped at 10 s): `GET /v0/tokens`, `GET /v0/status` and dry quotes, on timeout, network error, 429 and 5xx.
- Never retried: execution quotes, and in later phases every submit or signed call.

## Asset ids used by Shelter

From the live token list on 2026-11-07:

| Asset | Asset id | Decimals |
| --- | --- | --- |
| USDC on Base (Circle native, `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`) | `nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near` | 6 |
| ETH on Base (native gas) | `nep141:base.omft.near` | 18 |

## Live dry-quote evidence (2026-11-07 15:49 UTC)

Read-only `dry: true` quotes against the live API, approved by the human.
No credentials were sent (request headers were only `Accept` and `Content-Type`), no funds moved.
Recipient and refund addresses were random throwaway values nobody controls.
Two signed responses and the 401 body are kept in `packages/intents/test/fixtures/live-dry-quotes-2026-11-07.json` and checked offline by `test/live-fixture.test.ts`.

| Quote (public, `allowPublic`) | In | Out | `withdrawFee` | Signature |
| --- | --- | --- | --- | --- |
| Base USDC to Base USDC, `EXACT_INPUT` | 5.000000 USDC | 4.997600 USDC (min 4.972612 at 50 bps) | 0.0024 USDC | verified |
| Base USDC to Base ETH, `EXACT_INPUT` | 1.000000 USDC | 0.000445674 ETH (about $0.996) | 0.00000056 ETH | verified |
| Base USDC to Base ETH, `EXACT_INPUT` | 0.250000 USDC | 0.000110958 ETH (about $0.248) | 0.00000056 ETH | verified |

Findings:

- **Signatures:** every real quote verified against the manager key with our digest and field selection, and fails after a one-unit change to a signed amount.
- **Minimum size:** below 0.15 USDC from Base, 1Click answers 400 "Amount is too low for bridge, try at least 150000".
- **Fee without a partner JWT:** on the same-asset USDC route the output equals the input minus `withdrawFee` only; no 25 bps platform fee was visible on these dry quotes.
  The client keeps reporting fees from each quote rather than assuming either figure.
- **Confidential quotes need credentials, even dry ones.** Both Shelter legs (deposit and withdrawal, USDC and ETH) returned 401 "User authentication is required for confidential intent quotes" with no credentials.
  The credential turned out to be the partner key, not the user session (see the 2026-11-08 evidence below).
- **Gas plan A (public baseline):** 0.25 USDC already buys about 0.00011 ETH on Base at a 0.00000056 ETH withdrawal fee, enough for several USDC transfers on Base.
  Whether the confidential balance can deliver it the same way is still unverified (401).

## Live confidential evidence (2026-11-08, partner key, `viraz.near`)

Read-only: a NEP-413 sign-in signed in Meteor and `dry: true` quotes; no funds moved.
Withdrawal recipients were random throwaway Base addresses nobody controls.

- **Sign-in:** Meteor's NEP-413 signature verified locally and 1Click accepted it; access token 15 minutes, session 7 days.
  The sign-in message is addressed to `intents.near`, whose `current_salt` was `252812b3`; it is read live.
- **Balances:** `GET /v0/account/balances` with the session token answered an empty list (nothing deposited yet).
- **Confidentiality echo:** confidential quotes echo `confidentiality: "advanced"` and their signatures verify.
- **Deposit leg** (Base USDC to the confidential balance, `EXACT_INPUT`): 0.25 in, 0.25 credited, `withdrawFee` 0, no visible partner fee.
  `refundType: CONFIDENTIAL_INTENTS` is accepted.
  Minimum 150000 (0.15 USDC); 149999 answers 400 "Amount is too low for bridge".
- **Withdrawal leg** (confidential balance to a Base address, same asset): the only fee is a flat `withdrawFee`, 4800 (0.0048 USDC) or 1120000000000 wei (0.00000112 ETH, about $0.0025), at every size tried.
  No minimum was hit down to 0.001 USDC or 0.000001 ETH out, so gas plan A (withdrawing a little native ETH to the burner) works.
- **Deposit minimums from Base, re-checked 2026-11-12 with dry quotes:** USDC 150000 (0.15); native ETH 1e11 wei (0.0000001), smaller answers "try at least 100000000000"; WETH and cbBTC accepted 0.000001.
  1Click lists 18 Base tokens; native ETH (`nep141:base.omft.near`) has no contract address, and some ids use other forms (`...omdep.near`, `1cs_v1:base:erc20:0x...`).
- **Slippage on `EXACT_OUTPUT`:** `amountIn` is `minAmountIn / (1 - slippage)`; `minAmountIn` is the real cost (output plus `withdrawFee`).
  At the default 50 bps, 0.25 USDC out quoted 0.256081 in against a real cost of 0.2548.
  `slippageTolerance: 0` is accepted and makes `amountIn` equal `minAmountIn`.

## Confidential balance contract: `intents.far` (verified 2026-11-08)

Source: [Moving solver liquidity into Confidential Intents](https://docs.near-intents.org/integration/market-makers/confidential-liquidity.md) and [Confidential Example](https://docs.near-intents.org/integration/market-makers/confidential-example.md), retrieved 2026-11-08.

- Public balances live on `intents.near`; the confidential balance lives on `intents.far`, a separate contract with no public RPC.
- `intents.far` balances are `imt:51e8f94d77b5e90dc9852ca6113771e11e8382ce69473a75e313e41665de7cbe:<public asset id>` tokens, backed by that Treasury account on `intents.near`.
- The `intents.far` versioned-nonce salt is the published production constant `e110f317`; `intents.near` has its own salt (`252812b3` on 2026-11-08).
- Live, read-only: `generate-intent` for a confidential withdrawal returned recipient `intents.far`, salt `e110f317`, one `transfer` of `imt:...:nep141:base.omft.near` for exactly the quoted `amountIn` to the deposit address, and a deadline 3 days out (the quote's own deadline was 30 minutes).
- `checkGeneratedIntent` therefore takes the expected contract, salt and token id from the quote's `depositType`: `CONFIDENTIAL_INTENTS` means `intents.far`, `e110f317` and the `imt:` id; `INTENTS` means `intents.near`, the live salt and the public id.
- The intent deadline is not bound to the quote deadline (it never is, live); it is refused only beyond 7 days.
  After the quote deadline 1Click refunds a late transfer into the deposit address to the owner's balance, so callers treat the quote deadline as the end of an attempt.
- Not verifiable without a real withdrawal: whether `intents.far` checks the signing key against its own registry or mirrors `intents.near`.
  The client still requires the key to be registered on `intents.near`.

## Still open

- Whether the slippage buffer on an `EXACT_OUTPUT` withdrawal is refunded to the confidential balance, or spent; only a real withdrawal shows it.
- Status transitions and timing of a real deposit and withdrawal (the approved mainnet run).
- Whether a confidential withdrawal signed by a key registered only on `intents.near` is accepted by `intents.far`.

## Deadlines (live 2026-11-12)

An execution quote carries two times: the deadline Shelter requested (30 minutes by default) and `quote.deadline` / `timeWhenInactive`, the deposit address expiry (3 days in the live case).
The requested one is the cutoff: a deposit that was still short at the 30-minute mark was refunded to the refund recipient with `refundReason: QUOTE_EXPIRED`, and a top-up sent after it stayed on the deposit address.
`Quote.deadline` is therefore the earlier of the two; `Quote.timeWhenInactive` keeps the address expiry.
`/v0/status` sends `null` for amounts it does not know yet (`amountIn`, `depositedAmount`, `refundReason`, ...); the client reads them as absent.
