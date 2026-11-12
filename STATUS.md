# Status

**2026-11-12 UTC**

Backend session, branch `feat/connect`, not committed or pushed.
PRs #4 to #9 (G4, G5, G6, G9 and docs) are merged into `main`.
New this session: **Shelter Connect** (`packages/connect`), the confidential balance usable in any dapp over WalletConnect, one unlinked address per dapp.

- Each dapp origin gets its own seed-derived address, funded by burner engine `fund` jobs (new action kind) from the confidential balance, with gas and ETH value topped up just in time.
- A linkage check refuses any request that names the user's linked wallets, NEAR accounts or other Shelter addresses, in recipients, calldata, messages or typed data, before the user is asked.
- `close` sweeps every 1Click-listed Base token and the remaining ETH back into the confidential balance and retires the address; crash-tested at all 70 outside calls.
- CLI: `connect link`, `connect start [wc:URI]`, `connect list/show/fund/top-up/close`.
- Live (2026-11-12, nothing funded): paired with Reown's AppKit lab over the real relay (Verify: VALID); message and typed-data signatures accepted by the dapp; a typed-data request naming a linked wallet blocked before approval.
- Live finding: dapps estimate gas from the address before asking the wallet, so the opening budget must hold what will be spent; just-in-time top-ups are the fallback. Docs and CLI wording updated.
- Live funded (2026-11-12, mainnet): Uniswap on Base from a 1 USDC budget; approval, permit and a 0.5 USDC swap; a send to the linked main wallet blocked; close swept USDC and ETH back and retired the address. Links in `docs/backend/CONNECT.md`.
- Fixed from that run: `/v0/status` nulls broke the deposit watcher; `Quote.deadline` now means the requested cutoff (1Click refunds after it), not the 3-day address expiry; `connect list/show` no longer need `--account`.
- Added after it: the running wallet takes pasted `wc:` links (`wc link>` prompt; tested over the real relay with a WalletConnect dapp client); `near balance`; request records keep the dapp's params; `demo record --connect` and a replay that re-checks Connect sessions offline (today's run: 28 checks pass; tampered copies fail); the replay now binds quote fields to their signed response and reports malformed signatures instead of crashing; README judge path and NEAR section; threat model limits.

Previous update (2026-11-09): G4.2 Meteor-owned confidential balance, G6 burner engine, G9 recording and replay.

## Goals

| Goal | Status | Proof |
| --- | --- | --- |
| G1 Scan (chain reader) | done | `packages/core` (PR #1, merged `635d046`) |
| G2 Exposure score A–I | done | `packages/core` engine + 31 vitest tests; G confidence 1, inherited A/B on clustered wallets (PR #3) |
| G3 Link graph + samples | done | `packages/core/fixtures/sample-wallets/{clean,medium,exposed}.json` regenerated from `shelter:sample:*` keccak keys |
| G4 Intents layer | done (merged, PR #6) | `packages/intents`: quote client, User-Session sign-in via Meteor (NEP-413, live 2026-11-08), balances, deposit notification, signed withdrawals split into prepare/submit with `intents.far` intent checks (generated intent verified live, unsigned). `fundBurner` one-call funding. CLI `near login/quote/deposit/watch`. 143 offline tests incl. `intents.far` intent checks with a real ed25519 wallet. Not yet: a real deposit and withdrawal (mainnet run) |
| G5 Seed vault | done (merged, PR #5) | `packages/keys`: Argon2id + AES-256-GCM vault, `m/44'/60'/0'/0'/n'` with independent vectors, atomic allocation proven across 4 processes and a crash, IndexedDB + SQLite adapters, encrypted backup/restore, recovery scan; 50 offline tests |
| G6 Burner engine | done (merged, PR #7; `fund` action local) | `packages/burner`: resumable jobs for burner actions and private-move payouts, scheduled starts, planner hand-off (`schedulePlan`), memory/SQLite/IndexedDB stores, Base client with L1 fee; CLI `vault` (incl. `recover`) and `burner` (`preview`, `new`, `payout`, `run`, ...). Live read-only run up to the first approval; 33 offline tests incl. crash matrices for both job kinds (mutation-checked). Not yet: mainnet run. See `docs/backend/BURNER.md` |
| G7 NEAR AI explainer + Verified panel | **done** | live run 2026-11-06T07:07Z by the human: `pnpm --filter @shelter/cli explain --sample exposed` - real Intel TDX DCAP quotes verified, TCB UpToDate, nonce / RTMR3 / app_compose / response-signature checks all passed; code merged in PR #2 (`f8c1959`) |
| G8 Web screens | in progress | Verified panel on `/`; other screens not started |
| G9 `pnpm demo --dry-run` | done (merged, PR #8), waiting for the recording | Recorder (`demo record`, deposits saved by `near deposit`) and offline replay that re-verifies quote, NEP-413 and transaction signatures; tested on a real partial run and a tampered copy. Waiting for the recorded mainnet run |
| G10 README / LICENSE / threat model | in progress | README corrected (98.5, hashed fixture keys); threat model AI section and Intents client section added; other sections pending |
| G11 Hosted demo | not started | - |
| Shelter Connect | done, live funded run on mainnet 2026-11-12 (local, unreviewed) | `packages/connect`: per-dapp accounts, linkage check, WalletConnect bridge (Reown WalletKit), just-in-time funding through burner `fund` jobs, sweep and retire; 53 offline tests incl. a close crash matrix (mutation-checked). Live: paired with a real dapp, signatures and a linkage block verified. Live: funded Uniswap session, block and close on mainnet. See `docs/backend/CONNECT.md` |

Timeline: G4 to G6 plus one approved mainnet run were due 2026-11-11, G9 by 2026-11-13.
G4, G5, G6 and G9 are implemented; the mainnet run is waiting on the human.

## Build / typecheck / test

Run 2026-11-12 on Node 26.12.1:

- `pnpm install --frozen-lockfile` - clean
- `pnpm -r typecheck` - 8 projects pass
- `pnpm build` - passes (Next production build)
- `pnpm -r test` - 334 tests pass (core 31, intents 146, keys 50, burner 41, connect 53, attest 13), no network calls
- `connect link add/list/remove` and `connect list` run end to end against a scratch `SHELTER_HOME`; WalletKit initializes in Node in about 0.3 s

## Open PRs

None open. PRs #4 to #9 are merged. Connect is on the local branch `feat/connect`, not pushed.

## Blockers / what I need from a human

1. **Approve the tiny mainnet run**, step by step: a deposit of at least 0.15 USDC into the confidential balance, a payout, and one burner payment (about 0.26 USDC each, all fees included).
2. **Decide the demo identity:** the recording names the NEAR account, the payout and burner addresses, and the payee. Set `SHELTER_NEAR_ACCOUNT` and `SHELTER_DEMO_PAYEE` to ones you are happy to make public before the run.
4. `@shelter/core`'s `planRemediation` is still a stub (not ours); its owner should emit the `MoveStep`s defined in `packages/burner/src/plan.ts`.

## Next 3 tasks

1. Decide whether to publish a recording (today's run, or a fresh one under a demo identity), then commit it to `scripts/demo/`.
2. The burner payout mainnet run (human signs; about 0.3 USDC).
3. Web UI for Connect and the submission (see the PR description).

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

- `createBurnerEngine`, `BurnerJob` (format v1), actions `erc20_transfer`,
  `hold` and `fund` (top up an address the user keeps), `schedulePlan` + `MoveStep`, `createBaseChain`, job stores
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

`packages/connect` (new): `createConnectEngine`, `ConnectAccount` (format v1),
`inspect` (linkage check), `parseRequest`, stores (memory,
`@shelter/connect/sqlite`), and `@shelter/connect/walletconnect`
(`createConnectBridge`, `createWalletKit`).

Repo-wide: `engines.node` is `>=24`; CI runs Node 24 and 26.
