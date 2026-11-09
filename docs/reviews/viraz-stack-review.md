# Review notes: Viraz's G4-G6/G9 stack (PRs #4-#9)

Review-only audit of the six-PR stack in `naz3eh/shelter` (author: viraj124), reviewed
2026-11-09 against each PR's own base, plus a combined run at the stack top
(`docs/backend-status` @ `4962bed`). No commits were pushed to any of Viraz's
branches; nothing was approved, merged or closed.

## Verdicts

| PR | Scope | Verdict | Blockers |
| --- | --- | --- | --- |
| #4 | `chore/node-24` -> `main` | Ready to merge | 0 |
| #5 | `feat/keys-vault` -> `chore/node-24` (G5) | Ready to merge | 0 |
| #6 | `feat/intents-confidential` -> `feat/keys-vault` (G4) | Ready to merge | 0 |
| #7 | `feat/burner-engine` -> `feat/intents-confidential` (G6) | Ready to merge | 0 |
| #8 | `feat/cli-confidential-flows` -> `feat/burner-engine` (G9) | Ready to merge | 0 |
| #9 | `docs/backend-status` -> `feat/cli-confidential-flows` | Ready to merge | 0 |

**Headline caveat (not a code defect):** the G9 demo cannot be shown yet.
`scripts/demo/recording.json` does not exist, so `pnpm demo --dry-run` prints
"No recording ... yet" and exits 0. The replay code is complete and verified
offline, but it needs the approved mainnet run (`near deposit` + `burner run`)
plus `demo record`. That run is the critical path to a working demo and needs
the human's sign-off and ~0.7 USDC of funds (STATUS.md "Blockers" section says
the same). Everything else in the stack checks out.

## Blockers

None found in code. Per-PR details and nits are in the review comments on each PR.

## Commands run and results

Environment: macOS arm64, pnpm 10.34.6, Node v24.10.0 (standalone tarball) and
v22.16.0 (system) for comparison. Stack top = `docs/backend-status`.

| Check | Command | Result |
| --- | --- | --- |
| Install | `pnpm install --frozen-lockfile` | clean, lockfile in sync |
| Typecheck | `pnpm -r typecheck` | 7/7 projects pass (after removing a stale `apps/web/.next` left by another branch; not a PR issue) |
| Build | `pnpm build` | Next 16.4.4 production build passes |
| Tests (Node 24.10.0) | `pnpm -r test` | **270/270 pass**: core 31, intents 143, keys 50, burner 33, attest 13. Matches STATUS.md's claim exactly. `node:sqlite` prints an ExperimentalWarning on Node 24 too |
| Tests (Node 22.16.0) | `pnpm -r test` | also 270/270 (engines warning only) |
| Secrets scan | `gitleaks dir` on `git log -p` for each of the 6 PR ranges | 1 hit in #7: the public Base USDC contract address `0x8335...2913` — false positive. No `.env`, keys, mnemonics, JWTs or tokens committed |
| Mutation spot-check | broke the confidentiality echo check in `packages/intents/src/quote.ts`, reran intents tests | exactly the "rejects a response that silently downgraded confidentiality" test failed; reverted |
| Derivation vectors (G5) | BIP-39 seed `5eb00bbd...ce9e38e4` expanded independently (Python stdlib) | child privkeys for indexes 0, 1, 2147483647 match `HARDENED_VECTORS`; addresses derived via viem: idx 0 `0xcf6335E1C68B1F7C9D8Aa84c647FFcd9595f0b03`, idx 1 `0x4B4dE798e77cF830AdCb49Cccb3D75bf2A149327`, idx 2147483647 `0xCa32ca28dd954fd5160f0390904e48Bcd8db5e2e` |
| Bridge probes (G9) | live `createMeteorSigner` on 127.0.0.1 | wrong Host -> 421; `/api/*` without/with wrong `X-Shelter-Token` -> 403; good token -> 200; `POST /api/result` wrong Origin -> 403; non-JSON -> 415; >16 KB body -> 400; unknown/already-consumed result id -> 409; OPTIONS preflight -> 403 (no CORS headers); after `close()` -> ECONNREFUSED |
| Demo replay | `pnpm demo --dry-run` | prints "No recording at scripts/demo/recording.json yet" — see headline caveat |
| CI on the PRs | — | **not verified**: repo is private, no `gh` CLI or token available in this environment. Local verification above is on the stack top only, not per-PR heads |
| `feat/web-flow` vs #4 | `git merge-tree` + file inspection | real conflicts (5 hunks: `pnpm-lock.yaml`, `package.json` engines/`@types/node`). web-flow pins `@types/node ^20.17.0` and `engines >=20`; it needs a rebase after #4 lands |
| Licenses | `npm view` on published packages | `@meteorwallet/sdk@1.0.24` declares **no license** (README #9 documents this correctly); `near-api-js@6.5.1` = "MIT AND Apache-2.0"; `fake-indexeddb@6.2.7` = Apache-2.0; `json-stable-stringify@1.3.0` = MIT — all match the README table |

## Per-PR findings (detail in the PR comments)

### #4 chore/node-24
- `engines >=24`, CI matrix Node 24 + 26 (`fail-fast: false`), `@types/node ^24.19.2`.
- `node:sqlite` is the driver for `packages/keys/src/sqlite.ts` and
  `packages/burner/src/sqlite.ts`; it exists on Node 22.5+ but stays
  experimental (warning observed on both 22 and 24). README/KEYS.md document
  Node 24 as the requirement; the warning itself is not called out — nit.
- Everything else (Next build, Playwright deps absent on this branch,
  `process.loadEnvFile`) is unaffected. Local run green on 24.10.0.

### #5 feat/keys-vault (G5)
- Vault stores the 64-byte BIP-39 seed, never the mnemonic; AES-256-GCM with
  fresh 12-byte IV per seal; Argon2id m=65536/t=3/p=4 with bounds checked
  before the KDF; hardened path `m/44'/60'/0'/0'/n'` (verified independently,
  addresses above); address-book allocation atomic via `updateBook`
  read-modify-write + `BEGIN IMMEDIATE`/WAL/`synchronous=FULL` on sqlite;
  multiprocess + crash-after-commit allocation tests pass; wrong
  passphrase/tampered header/truncated file all fail closed; `recover()`
  scans chain with gap limit. KEYS.md documents limits honestly (no
  memory-erasure guarantee, unencrypted address book).

### #6 feat/intents-confidential (G4)
- `confidentiality` defaults to `"advanced"`; `public` refused unless
  `allowPublic` (Shelter never sets it). Echo check rejects any response whose
  echoed request differs — including a silent downgrade to public — and the
  mutation test proves the suite catches it.
- `dry` defaults true; execution quotes (`dry:false`) get `retry:false` and
  `assertFundable` (verified signature + deposit address + 5 min deadline
  margin) before any funds move.
- ed25519 quote signature verified against the 1Click manager key before use;
  `signature_invalid` fails closed. Signed payload excludes `confidentiality`
  (documented), which is why the echo check exists.
- JWT optional, sent as `X-API-Key` only; never a Bearer on quote paths.
  **Keyless question answered:** `client.ts:121-128` refuses confidential
  calls locally with `partner_auth_required` when no JWT is configured, and
  `docs/backend/ONECLICK.md` records the live evidence — keyless dry
  confidential quotes returned 401 "User authentication is required for
  confidential intent quotes" on 2026-11-08, and confidential quotes/withdrawals
  were then verified live *with* the partner key (read-only, nothing signed or
  spent). The code does not assume keyless works; no blocker.
- Retries: only reads and dry quotes (`retry:true` on GETs and `dry` quotes);
  generate-intent, submit-intent, deposit-submit all `retry:false`.
- Session tokens memory-only, refreshed 60 s before expiry with inflight
  dedup, cleared on `end()`, redacted from every error via the transport's
  `redact` list (tested: server-echoed JWT/session strings are stripped).
- NEP-413 signing is an injected `Nep413Signer`; no NEAR key material in the
  package. Generated intents are checked against contract `intents.far`, salt
  `e110f317`, signer, deadline (<=7 d), nonce version/salt/deadline, and must
  be only `transfer`s of the quote's `imt:` token totalling <= `amountIn` to
  the quote's deposit address — 17 tamper cases tested, each refusing before
  the wallet is asked.
- USDC and ETH legs are separate quotes with separate deposit addresses and
  status tracking (each `FundingLeg` in burner carries its own attempts).
- Nit: with a JWT configured but rejected, the surfaced error is the generic
  `unauthorized (401): <server message>`; the server message does say auth is
  required, but mapping it to the partner-key hint locally would be clearer.

### #7 feat/burner-engine (G6)
- Job state machine persists before every side effect; signed withdrawal
  intents and signed txs are stored before submit/broadcast, so resume
  replays identical bytes (intents.near accepts a nonce once; an EVM tx
  cannot be mined twice). Allocation crash is handled by the
  `burner-job:<id>` label lookup; lease + CAS (`rev`) prevents double runners.
- Crash-injection test kills the engine before/after **every** outside call
  (~60+ points across both job kinds) and asserts paid-once, exactly two
  deliveries, one broadcast, <=1 intent per settlement, one retired book
  record. Covers death between fund and transfer and between transfer and
  sweep.
- Fresh-address check queries chain nonce+balance and refuses used addresses
  (tested, including retire-and-retry).
- One USDC `transfer` then retire; `hold` payouts never sign. `approve()`
  gates every withdrawal and transaction; payee equal to one of the user's
  own book addresses is refused; nonzero nonce on allocate retires the job.
- Gas plan A arithmetic verified: `gasBudget` = 90 000 gas * maxFeePerGas +
  OP-stack L1 data fee (`estimateL1Fee`), *2 headroom, rounded up to 1e12 wei;
  test asserts `"2000000000000"`. Re-price adds 20% before signing; top-ups
  capped at 2. Leftover swept only at/above the 1Click deposit minimum (150k
  base units for USDC); ETH dust never swept (`depositMinimum` = 2^255).
- bigint/base units end to end; no floats on amounts.
- Nit: none blocking.

### #8 feat/cli-confidential-flows (G9)
- Bridge verified live (probes above): 127.0.0.1 only, Host check (421),
  32-byte token in `X-Shelter-Token` (custom header => preflight, never
  answered => 403), own-Origin results only, 16 KB cap, strict CSP,
  `frame-ancestors 'none'`, `no-store`/`no-referrer`/`nosniff`, one-shot
  results (409 on replay), shuts down on `close()`.
- Token arrives in `#t=` fragment, moved to memory, `history.replaceState`
  strips it before Meteor loads (`near-signer-page/main.ts:29-30`).
- NEAR key never enters the CLI: `@meteorwallet/sdk` `signMessage` runs in the
  browser page (Meteor iframe); the CLI only receives
  `{accountId, publicKey, signature}` and verifies the NEP-413 signature
  locally before use.
- Every fund-moving path requires explicit confirmation: `burner run`'s
  `approve()` prints amounts/fees and prompts y/N per withdrawal and per
  transaction; `near deposit` prints the exact send instructions and only
  watches; `near quote` is always `dry:true` with a throwaway destination.
- `near deposit` persists `~/.shelter/deposits/<addr>.json` (0600/0700) and
  prints the resume command; `near watch --deposit-address` reloads it.
- `@meteorwallet/sdk@1.0.24` confirmed to declare no license in the published
  package; near-api-js is its peer dep. Allowed per hackathon rules; README
  #9 lists it accurately.
- Nit: `burner cancel` does not check `job.owner === --account` (cancel uses a
  dummy signer); harmless on a single-user local DB but inconsistent with
  `run`'s owner check.
- **Demo gap:** `scripts/demo/recording.json` absent => `pnpm demo --dry-run`
  is a no-op notice. Recorder + offline replay (quote sigs, NEP-413 sigs, tx
  hash=keccak(raw), sender recovery, exact transfer decode; exit 1 on any
  failed check) are complete and tested on a real partial run per STATUS.md.

### #9 docs/backend-status
- README/STATUS/threat-model match the code: Node 24 requirement, command
  list, "270 tests" (exact), "17 kinds of tampered intent" (exactly 17 in
  `execution.test.ts`), "about 60 outside calls" (>30 calls x 2 phases),
  library table versions+licenses verified against npm.
- Public-copy rules hold: no novelty claims, no hype, em dashes replaced with
  hyphens, no "destroyed keys" claim (threat model explicitly disclaims
  memory erasure), scan described as on device, only the explainer uses the
  NEAR AI TEE.
- STATUS.md is honest: "done (local, unreviewed)", "waiting for the
  recording", "nothing has been signed or spent".
- Nit: THREAT_MODEL.md:155 calls the bridge token "one-time"; it is a
  per-session token (43-char base64url of 32 bytes) that authorizes every API
  call until `close()` — "session" would be more accurate. Everything else in
  that paragraph verified by probe.

## Recommended merge order

As stacked: #4 -> #5 -> #6 -> #7 -> #8 -> #9. Each PR's base is the previous
branch, so merging in order keeps every diff clean. `feat/web-flow` must be
rebased after #4 (lockfile + engines/@types/node conflicts).

## Not verified

- CI status on the six PRs (no `gh`/token in this environment; private repo).
  Local install/typecheck/build/test are green at the stack top on Node
  24.10.0; per-PR heads were reviewed by diff, not executed.
- Any live 1Click/NEAR calls (by design; tests use recorded fixtures).
