# Shelter

Shelter is a privacy remediation app. Your device scans your public wallets (EVM chains such as Base), computes a 0-100 exposure score, and plans a private move into NEAR Confidential Intents through the 1Click API, using a one-time burner wallet for each public action. A NEAR AI Cloud TEE model is used only to explain results, and its attestation is verified on device. Nothing is kept server-side: keys, the address book, scan data and the label lists all stay on the user's device.

## Try it (judges)

Every step below runs offline with no keys, funds or accounts unless it says otherwise.

1. run `pnpm install && pnpm -r test` - see every package's tests pass with no network calls (scan engine, 1Click client, seed vault, burner engine, Shelter Connect, TEE attestation).
2. run `pnpm --filter @shelter/cli scan --sample exposed` - see a 98.5/100 exposure score with the findings that link the sample wallets.
3. run `pnpm --filter @shelter/connect test` - see a dapp swap through a per-dapp address, every kind of linking request refused before anything is signed, and a close killed at each of its 72 outside calls that still returns every token exactly once.
4. run `pnpm demo -- --dry-run` - see the recorded 2026-11-12 mainnet run replayed offline: every 1Click quote signature, every NEP-413 withdrawal signature and every Base transaction's hash, sender and effect re-checked, the Uniswap session's blocked send blocked again, and Basescan links printed for each transaction (see [Recorded mainnet runs](#recorded-mainnet-runs)).
5. run `pnpm install --frozen-lockfile && pnpm --filter web dev` and open http://localhost:3000 - see the Shelter Connect demo replaying the recorded Uniswap session: the blocked send, the link graph, the funding timeline and the verified panel (see [Try the web app](#try-the-web-app)). Works from a clean clone with no keys; the TEE panel needs `NEAR_AI_API_KEY` in `.env` as below.
6. With a free WalletConnect project id in `.env`: run `pnpm --filter @shelter/cli connect start --sandbox`, then paste any dapp's WalletConnect link - see the dapp connect to a throwaway address, get real signatures, and get "Blocked by Shelter" for a request that names a wallet you linked with `connect link add`.

## Built at NEAR HACKATHON

Built from 2026-11-03 for NEAR HACKATHON; there is no pre-hackathon code.
What NEAR does here, concretely:

- **NEAR Intents confidential balance (1Click API, `confidentiality: advanced`)** is where the user's money rests between uses; every deposit, withdrawal, burner funding and dapp funding goes through it, so on Base the funder of every Shelter address is the Intents treasury, not the user.
- **NEP-413 signatures from the user's NEAR wallet (Meteor)** authorize each withdrawal from that balance; Shelter never holds the NEAR key.
- **NEAR AI Cloud** runs the model that explains a scan inside a TEE; the CLI and web app verify its Intel TDX attestation with a fresh nonce before showing anything.

## Layout

```
apps/web          Next.js app (App Router, TypeScript, Tailwind)
apps/cli          CLI and judge demo (TypeScript, run with tsx)
packages/core     exposure engine, chain reader, label lists, link graph, address book
packages/keys     seed vault, hardened derivation
packages/intents  1Click client, confidential balance, status tracking
packages/burner   one-time address lifecycle
packages/connect  the confidential balance in any dapp over WalletConnect, one unlinked address per dapp
packages/attest   NEAR AI attestation check
scripts           dataset builders and sample-wallet generator
scripts/demo      recorded mainnet run for dry-run replay
docs              threat model and design notes
```

## Run

Requires Node 24+ and pnpm 10 (the CLI address book uses the built-in `node:sqlite`).

```sh
pnpm install
cp .env.example .env      # optionally set ETH_RPC_URL / BASE_RPC_URL; NEAR_AI_API_KEY when needed; ONECLICK_JWT is optional
pnpm dev                  # web app on http://localhost:3000
pnpm typecheck
pnpm build
pnpm -r test              # every package, offline, no secrets
pnpm demo -- --dry-run
pnpm verify-attestation
```

## Try the scan

The scan runs on your device against recorded fictional wallets; no keys, funds or network access are needed for the samples. Sample addresses are deterministic keccak256 hashes (`shelter:sample:<profile>:<name>`) - not the well-known integer test keys 1 and 2 - and their recorded history is fictional.

- run `pnpm --filter @shelter/cli scan --sample exposed` - see score 98.5/100, band `doxxed`, findings A–I with points, two warnings (OFAC counterparty, address poisoning), `linkedAddressCount: 2`.
- run `pnpm --filter @shelter/cli scan --sample medium` - see band `linkable`, findings D, F and H.
- run `pnpm --filter @shelter/cli scan --sample clean` - see score 0/100, band `clean`.
- run `pnpm --filter @shelter/cli scan --address 0xYOURADDRESS --chain base` - see the score, band and findings for a real address, read live from Base (Blockscout + your `BASE_RPC_URL` or the default public RPC).

## Check the AI is private

Explanations run on `z-ai/glm-5.3-flash` inside NEAR AI Cloud TEEs. The client proves the serving hardware, the enclave image, and the response signature before it shows the answer - the API key never reaches the browser.

- copy `.env.example` to `.env` and set `NEAR_AI_API_KEY` - the key stays server-side / CLI-side; the browser calls a thin proxy that only adds the key and forwards your nonce unchanged.
- run `pnpm verify-attestation` - see every check pass with a fresh 32-byte nonce: Intel DCAP quote, nonce + signing-address binding in the quote's report data, RTMR3 replayed from the event log, `app_compose` hash vs MRCONFIGID, for the gateway and each model candidate. Exit code is non-zero if any check fails.
- run `pnpm --filter @shelter/cli explain --sample exposed` - see redacted findings (`Wallet 1`, `Counterparty 1`, no addresses or tx hashes) sent to the TEE model, a plain-language explanation, and the signature check table: the completion's signer must match exactly one verified report.
- open the web app (`pnpm dev`) - see the Verified panel next to the AI answer: "Verified" or "Not verified", shortened nonce, signing address, every check with pass/fail, and a Re-check button with a new nonce. When a check fails the AI text is hidden.
- no key? run `pnpm --filter @shelter/attest test` - the same checks run offline against recorded fixtures (pass, wrong nonce, tampered `app_compose`, missing `model_attestations`).

## Private move backend

The confidential balance is owned by a NEAR account, which signs in and spends through the user's own wallet (Meteor); Shelter never holds that key.
`packages/intents` talks to 1Click: verified quotes, sign-in, the confidential balance, deposits, and withdrawals from `intents.far` whose generated intent is checked before the wallet is asked.
`packages/burner` runs each spend as a saved, resumable job: a private-move payout to a fresh address with its gas, or one public action from a one-time burner that is then retired.
Gas is paid from the confidential balance in USDC and arrives as native ETH, so no new address is ever topped up from a known wallet.
Details: [ONECLICK.md](docs/backend/ONECLICK.md), [BURNER.md](docs/backend/BURNER.md).

- run `pnpm --filter @shelter/intents test` and `pnpm --filter @shelter/burner test` - see the withdrawal checks refuse 17 kinds of tampered intent, and the burner engine killed at every one of about 60 outside calls still pay exactly once.
- run `pnpm demo --dry-run` - see the committed recording of the 2026-11-12 mainnet run replayed with every quote, intent and transaction signature re-checked offline.
- `ONECLICK_JWT` (a 1Click partner key) is required for confidential quotes and withdrawals.
  It is read by the CLI only and never sent to the browser.

```sh
pnpm --filter @shelter/cli near login   --account you.near          # Meteor signs in; shows the confidential balance
pnpm --filter @shelter/cli near balance --account you.near          # the same, balances only
pnpm --filter @shelter/cli near deposit --account you.near --asset usdc --amount 0.5
pnpm --filter @shelter/cli vault create
pnpm --filter @shelter/cli burner payout --account you.near --amount 0.2 --in 3h
pnpm --filter @shelter/cli burner new    --account you.near --to 0xPayee --amount 0.1
pnpm --filter @shelter/cli burner run    bj_... --account you.near   # approve each spend; Ctrl-C is safe
```

## Use the confidential balance in any dapp

`packages/connect` makes Shelter a WalletConnect wallet.
Each dapp gets its own address from the local seed, funded from the confidential balance with the budget you choose and topped up just in time, so on chain its funder is the public Intents treasury.
Every request passes a linkage check before you approve it: anything that names your own wallets, your NEAR account or another Shelter address is refused, from a token transfer to a swap recipient buried in calldata to a sign-in message.
Closing a dapp sweeps what is left back into the confidential balance and retires the address.
Details: [CONNECT.md](docs/backend/CONNECT.md).

- run `pnpm --filter @shelter/connect test` - see a swap through a fake dapp router, each kind of linking request refused before anything is signed, just-in-time gas and ETH top-ups, and a close killed at each of its 72 outside calls that still returns everything exactly once.
- `WALLETCONNECT_PROJECT_ID` (a free Reown Cloud project) is needed to pair with real dapps.
- run `connect start --sandbox` and paste any dapp's WalletConnect link (Connect, then WalletConnect, then copy the link) - see it connect to a throwaway address, get real signatures, and get refused when a request names a wallet you linked; no vault, partner key or funds needed.
- the running wallet takes more links at its `wc link>` prompt, one per dapp, each with its own address.

```sh
pnpm --filter @shelter/cli connect link add 0xYourMainWallet --label "main wallet"
pnpm --filter @shelter/cli connect start --account you.near --budget 5   # then paste the dapp's wc: link
pnpm --filter @shelter/cli connect list
pnpm --filter @shelter/cli connect close ca_... --account you.near        # sweep back, retire the address
```

Verified on Base mainnet on 2026-11-12: Uniswap funded from the confidential balance, a 0.5 USDC swap, a send to the linked main wallet blocked, and a close that returned the USDC and ETH and retired the address (transactions in [CONNECT.md](docs/backend/CONNECT.md#verified-on-mainnet-2026-11-12-funded)).

## Try the web app

The web UI replays the recorded Uniswap Connect session: no sign-in, no funds, no keys and no network calls.
The fixture is the real recording (`scripts/demo/recording.json`) with one swap: the linked main wallet is a demo address, safe because the blocked request was never signed. The NEAR owner stays `viraz.near` — the NEP-413 withdrawals and 1Click sweep quotes are signed over that account, so it cannot be renamed without breaking the signatures the panel verifies; it is already public in the committed recording.

- run `pnpm install --frozen-lockfile && pnpm --filter web dev` - see the app on http://localhost:3000. Dev and build use webpack because the workspace packages use NodeNext `.js` import specifiers that Turbopack cannot resolve yet.
- open http://localhost:3000 and click **Try it** - see the recorded session open on the block moment: Uniswap asking to send 0.1 USDC to your main wallet, refused by the linkage check before anything is signed.
- scroll down - see the before/after link graph, the dapp card with "Close and sweep back", the funding timeline (deposit, dapp funding, swap, sweep back), and the verified panel where every signature and transaction is re-checked offline against the recording.
- paste your own addresses and a transaction or typed-data JSON into **Try the linkage check** - see blocked or allowed with the reason, computed live in your browser.
- `NEXT_PUBLIC_SHELTER_LIVE=1` selects the live wallet source once `packages/connect` ships a browser entry; today it shows a typed stub that says so.

## Recorded mainnet runs

`demo record` assembles a recording from the local databases: deposits, burner jobs and Connect sessions (`--connect ca_...` adds the session and its funding jobs).
`pnpm demo -- --dry-run [--recording PATH]` replays it with no network: 1Click quote signatures (and that the fields used are the signed ones), NEP-413 withdrawal signatures, every Base transaction's hash, sender and effect, every dapp message or typed-data signature, and every blocked request blocked again by the linkage check.
A recording holds no secret, but it ties the NEAR account to every address in it; only the linked wallets a block named are included.
`scripts/demo/recording.json` is the committed recording of the 2026-11-12 funded run: the confidential-balance funding of a Uniswap session, the approval, permit and swap, the blocked send to the linked main wallet, and the sweep of USDC and ETH back.
It names `viraz.near` and that wallet, both already public in the run's write-up.

## Seed vault and address book

`packages/keys` holds the local seed and the record of every derived address.
One BIP-39 seed, encrypted at rest with Argon2id and AES-256-GCM; fresh EVM addresses come from fully hardened derivation (`m/44'/60'/0'/0'/n'`), and each index is handed out at most once, even across tabs, processes and crashes.
Persistence: IndexedDB in the browser (`@shelter/keys/idb`), the built-in `node:sqlite` in the CLI (`@shelter/keys/sqlite`).
Formats, parameters, recovery and limits: [docs/backend/KEYS.md](docs/backend/KEYS.md).

- run `pnpm --filter @shelter/keys test` - see derivation vectors, tamper and wrong-passphrase rejection, lock enforcement, backup round trip, recovery, and 4 processes allocating from one SQLite file without a repeated index.
- these addresses are not the ones MetaMask shows for the same phrase: every level is hardened, so a leaked burner key exposes nothing else.

## Libraries

- viem 2.57.x (MIT) - EVM RPC reads (balance, nonce, ENS reverse), keccak-derived fixture addresses, EIP-191 signature recovery for response signatures
- @phala/dcap-qvl 0.7.0 (Apache-2.0) - pure-JS DCAP quote verification (Intel TDX), runs in browser and Node
- openai 7.45.1 (Apache-2.0) - OpenAI-compatible client, server-side only, pointed at `https://cloud-api.near.ai/v1`
- vitest 3.x (MIT) - unit tests in every package
- @scure/bip39 2.x, @scure/bip32 2.x (MIT) - seed phrase and hardened derivation in packages/keys; @noble/hashes also provides Argon2id and HKDF there
- fake-indexeddb 6.x (Apache-2.0, tests only) - IndexedDB adapter tests in Node
- zod 4.x (MIT) - 1Click response validation in packages/intents, through the tree-shakable `zod/mini` entry
- @noble/curves 2.x, @noble/hashes 2.x, @scure/base 2.x (MIT) - ed25519 verification of 1Click quote signatures (SHA-256, base58)
- json-stable-stringify 1.3.0 (MIT, tests only) - reference serializer the official 1Click SDK uses; tests check packages/intents produces identical bytes
- @meteorwallet/sdk 1.0.24 (no license declared in the published package) - the CLI's local signing page asks Meteor for NEP-413 signatures; near-api-js 6.5.1 (MIT AND Apache-2.0) is its peer dependency
- esbuild 0.28.2 (MIT) - bundles that signing page at run time; buffer 6.0.3 (MIT) - Node's Buffer in that page
- @reown/walletkit 1.6.0, @walletconnect/core, utils and types 2.25.0 (WalletConnect Community License) - Shelter Connect's WalletConnect wallet; Portions © 2025 Reown, Inc. All Rights Reserved. The license requires using Reown's relay network, which Connect does
- tsx 4.x (MIT) - runs the TypeScript CLI and scripts
- typescript 5.9 (Apache-2.0)
- next 16 / react 19 (MIT) - web app
- tailwindcss 4 / @tailwindcss/postcss 4 (MIT)
- beUI components (MIT, vendored in `apps/web/components/`) - animated-badge, stateful button, card, collapsible for the Verified panel
- motion 14.x (MIT), clsx 2.x (MIT), tailwind-merge 3.x (MIT), lucide-react 1.x (ISC) - beUI/shadcn component dependencies

## Datasets

Static label data is bundled in `packages/core/data/` and queried locally only - the user's address set is never sent to a label API.

- `data/exchange-labels.json` - exchange addresses on Ethereum and Base, built by `scripts/build-labels.ts` from [dawsbot/eth-labels](https://github.com/dawsbot/eth-labels) (MIT), commit `d9b21ae`.
- `data/ofac-sanctioned.json` - OFAC-sanctioned ETH addresses, built by the same script from [0xB10C/ofac-sanctioned-digital-currency-addresses](https://github.com/0xB10C/ofac-sanctioned-digital-currency-addresses), `lists` branch (MIT), commit `abad1e7`.

To rebuild both datasets: `pnpm --filter @shelter/cli exec tsx ../../scripts/build-labels.ts`. To regenerate the fictional sample wallets: `pnpm --filter @shelter/cli exec tsx ../../scripts/gen-sample-wallets.ts`.

## License

MIT
