# Status

**2026-11-09 09:50 UTC**

Backend session, local branch `feat/intents-quote-client`, not committed or pushed.
The backend scope (G4, G5, G6, G9) is implemented; what remains is the approved mainnet run and the recording it produces.

- G4.2: the confidential balance owner (`viraz.near`) signs in through Meteor; the NEAR key never leaves the wallet.
  Confidential quotes need the partner key, and the balance lives on `intents.far` (salt `e110f317`, `imt:` tokens), both verified live.
- G6: a crash-safe job engine runs private-move payouts (a fresh address with USDC and gas, kept) and burner actions (one transfer, then retired); gas is paid in USDC and delivered as native ETH.
- G9: `demo record` and an offline replay that re-checks every signature.
- Verified live, read-only, up to the point of signing; nothing has been signed or spent.

Previous update (2026-11-07): G4.1 quote client and G5 seed vault.

## Goals

| Goal | Status | Proof |
| --- | --- | --- |
| G1 Scan (chain reader) | done | `packages/core` (PR #1, merged `635d046`) |
| G2 Exposure score A–I | done | `packages/core` engine + 31 vitest tests; G confidence 1, inherited A/B on clustered wallets (PR #3) |
| G3 Link graph + samples | done | `packages/core/fixtures/sample-wallets/{clean,medium,exposed}.json` regenerated from `shelter:sample:*` keccak keys |
| G4 Intents layer | done (local, unreviewed) | `packages/intents` (local branch): quote client, User-Session sign-in via Meteor (NEP-413, live 2026-11-08), balances, deposit notification, signed withdrawals split into prepare/submit with `intents.far` intent checks (generated intent verified live, unsigned). `fundBurner` one-call funding. CLI `near login/quote/deposit/watch`. 143 offline tests incl. `intents.far` intent checks with a real ed25519 wallet. Not yet: a real deposit and withdrawal (mainnet run) |
| G5 Seed vault | done (local, unreviewed) | `packages/keys`: Argon2id + AES-256-GCM vault, `m/44'/60'/0'/0'/n'` with independent vectors, atomic allocation proven across 4 processes and a crash, IndexedDB + SQLite adapters, encrypted backup/restore, recovery scan; 50 offline tests |
| G6 Burner engine | done (local, unreviewed) | `packages/burner`: resumable jobs for burner actions and private-move payouts, scheduled starts, planner hand-off (`schedulePlan`), memory/SQLite/IndexedDB stores, Base client with L1 fee; CLI `vault` (incl. `recover`) and `burner` (`preview`, `new`, `payout`, `run`, ...). Live read-only run up to the first approval; 33 offline tests incl. crash matrices for both job kinds (mutation-checked). Not yet: mainnet run. See `docs/backend/BURNER.md` |
| G7 NEAR AI explainer + Verified panel | **done** | live run 2026-11-06T07:07Z by the human: `pnpm --filter @shelter/cli explain --sample exposed` - real Intel TDX DCAP quotes verified, TCB UpToDate, nonce / RTMR3 / app_compose / response-signature checks all passed; code merged in PR #2 (`f8c1959`) |
| G8 Web screens | in progress | Verified panel on `/`; other screens not started |
| G9 `pnpm demo --dry-run` | done, waiting for the recording (local) | Recorder (`demo record`, deposits saved by `near deposit`) and offline replay that re-verifies quote, NEP-413 and transaction signatures; tested on a real partial run and a tampered copy. Waiting for the recorded mainnet run |
| G10 README / LICENSE / threat model | in progress | README corrected (98.5, hashed fixture keys); threat model AI section and Intents client section added; other sections pending |
| G11 Hosted demo | not started | - |

Timeline: G4 to G6 plus one approved mainnet run were due 2026-11-11, G9 by 2026-11-13.
G4, G5, G6 and G9 are implemented; the mainnet run is waiting on the human.

## Build / typecheck / test

Run 2026-11-09 on Node 26.12.1:

- `pnpm install --frozen-lockfile` - clean
- `pnpm -r typecheck` - 7 projects pass
- `pnpm build` - passes (Next production build)
- `pnpm -r test` - 270 tests pass (core 31, intents 143, keys 50, burner 33, attest 13), no network calls
- `pnpm demo --dry-run` - prints that the recording does not exist yet (made after the mainnet run)
- `pnpm --filter @shelter/cli scan --sample exposed` - score **98.5/100**, band `doxxed`; `medium` 21.5 `linkable`; `clean` 0
- Live, read-only (2026-11-08/09): Meteor sign-in and balance read; confidential dry quotes; `burner preview` for both job kinds; the engine up to the first approval on a throwaway seed

## Open PRs

None open. Everything since PR #3 is on the local branch, awaiting review; nothing pushed.

## Blockers / what I need from a human

1. **Approve the tiny mainnet run**, step by step: a deposit of at least 0.15 USDC into the confidential balance, a payout, and one burner payment (about 0.26 USDC each, all fees included).
2. **Decide the demo identity:** the recording names the NEAR account, the payout and burner addresses, and the payee. Set `SHELTER_NEAR_ACCOUNT` and `SHELTER_DEMO_PAYEE` to ones you are happy to make public before the run.
3. `@shelter/core`'s `planRemediation` is still a stub (not ours); its owner should emit the `MoveStep`s defined in `packages/burner/src/plan.ts`.

## Next 3 tasks

1. The approved mainnet run, then `demo record` and commit the recording.
2. Record the live answers to the open questions in `docs/backend/ONECLICK.md` (key accepted by `intents.far`, slippage buffer refunded, status timings).
3. Human review, then commit and PR.

## Interface changes

`packages/intents` (no consumers yet; documented in `docs/backend/ONECLICK.md`):

- `Confidentiality` is now the API enum `"public" | "basic" | "advanced"`
  (the draft `"none"` is not a valid API value).
- `QuoteRequest` mirrors API field names (`originAssetId`,
  `destinationAssetId`, `swapType`, `amount`, explicit `depositType` /
  `recipientType` / `refundType`); use `privateDepositRequest` /
  `privateWithdrawRequest` to build it.
- `Quote.deadline` and `Quote.depositAddress` are optional (dry quotes
  carry neither); `Quote` adds provenance (signature, verified flag) and
  the full wire response.
- `IntentStatus` adds `UNKNOWN`; `StatusResult` adds chain-qualified
  transactions, settled amounts and `quoteVerified`.
- `deposit`, `withdraw`, `fundBurner` keep their names and are real:
  `fundBurner` now takes `{ burnerAddress, amount, payWithAssetId?, signer,
  approve?, client? }` and returns a `WithdrawResult`.
- New: NEP-413 signing and sign-in (`signIn`, `UserSession`), `balances`,
  `submitDeposit`, `prepareSignedIntent` / `submitSignedIntent` /
  `executeSignedIntent`, `waitForStatus`, the `intents.far` constants, and
  error kinds `partner_auth_required`, `intent_mismatch`,
  `key_not_registered`, `signer_rejected`, `session_expired`.

`packages/burner` (the stub's `createBurner` / `markUsed` / `retireBurner`
are kept as low-level helpers taking the address book):

- `createBurnerEngine`, `BurnerJob` (format v1), actions `erc20_transfer`
  and `hold`, `schedulePlan` + `MoveStep`, `createBaseChain`, job stores
  (memory, `@shelter/burner/sqlite`, `@shelter/burner/idb`).

`packages/keys` (additive; names kept):

- `createSeedVault(options?)` now takes `{ store, kdf, random, now }`;
  `SeedVault` keeps `isUnlocked`/`unlock`/`lock` and adds `exists`,
  `vaultId`, `create`, `importMnemonic`, `changePassphrase`, `address(i)`,
  `account(i)` (viem `LocalAccount`, no private key exposed).
- `deriveHardened(vault, index)` unchanged in shape (`{ path, address }`);
  `DerivedKey` keeps `path` and `address` only.
- New: `createAddressBook`, `createMemoryStore`, `KeysError`, subpaths
  `@shelter/keys/idb` and `@shelter/keys/sqlite` (Node only).
- Integration dependency: `@shelter/core`'s `AddressBook` (user labels
  for scanned wallets) is unchanged and separate from the derived-address
  book; the planner will need `AddressRecord` ids for burner and
  destination steps (see Decision 4).

Repo-wide: `engines.node` is `>=24`; CI runs Node 24 and 26.
