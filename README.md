# Shelter

Shelter is a privacy remediation app. Your device scans your public wallets (EVM chains such as Base), computes a 0-100 exposure score, and plans a private move into NEAR Confidential Intents through the 1Click API, using a one-time burner wallet for each public action. A NEAR AI Cloud TEE model is used only to explain results, and its attestation is verified on device. Nothing is kept server-side: keys, the address book, scan data and the label lists all stay on the user's device.

## Layout

```
apps/web          Next.js app (App Router, TypeScript, Tailwind)
apps/cli          CLI and judge demo (TypeScript, run with tsx)
packages/core     exposure engine, chain reader, label lists, link graph, address book
packages/keys     seed vault, hardened derivation
packages/intents  1Click client, confidential balance, status tracking
packages/burner   one-time address lifecycle
packages/attest   NEAR AI attestation check
scripts           dataset builders and sample-wallet generator
scripts/demo      recorded mainnet run for dry-run replay
docs              threat model and design notes
```

## Run

Requires Node 20+ and pnpm 10.

```sh
pnpm install
cp .env.example .env      # optionally set ETH_RPC_URL / BASE_RPC_URL; fill ONECLICK_JWT and NEAR_AI_API_KEY when needed
pnpm dev                  # web app on http://localhost:3000
pnpm typecheck
pnpm build
pnpm --filter @shelter/core test
pnpm demo -- --dry-run
pnpm verify-attestation
```

## Try the scan

The scan runs on your device against recorded fictional wallets; no keys, funds or network access are needed for the samples.

- run `pnpm --filter @shelter/cli scan --sample exposed` — see score 100/100, band `doxxed`, findings A–I with points, two warnings (OFAC counterparty, address poisoning), `linkedAddressCount: 2`.
- run `pnpm --filter @shelter/cli scan --sample medium` — see band `linkable`, findings D, F and H.
- run `pnpm --filter @shelter/cli scan --sample clean` — see score 0/100, band `clean`.
- run `pnpm --filter @shelter/cli scan --address 0xYOURADDRESS --chain base` — see the score, band and findings for a real address, read live from Base (Blockscout + your `BASE_RPC_URL` or the default public RPC).

## Check the AI is private

Explanations run on `z-ai/glm-5.3-flash` inside NEAR AI Cloud TEEs. The client proves the serving hardware, the enclave image, and the response signature before it shows the answer — the API key never reaches the browser.

- copy `.env.example` to `.env` and set `NEAR_AI_API_KEY` — the key stays server-side / CLI-side; the browser calls a thin proxy that only adds the key and forwards your nonce unchanged.
- run `pnpm verify-attestation` — see every check pass with a fresh 32-byte nonce: Intel DCAP quote, nonce + signing-address binding in the quote's report data, RTMR3 replayed from the event log, `app_compose` hash vs MRCONFIGID, for the gateway and each model candidate. Exit code is non-zero if any check fails.
- run `pnpm --filter @shelter/cli explain --sample exposed` — see redacted findings (`Wallet 1`, `Counterparty 1`, no addresses or tx hashes) sent to the TEE model, a plain-language explanation, and the signature check table: the completion's signer must match exactly one verified report.
- open the web app (`pnpm dev`) — see the Verified panel next to the AI answer: "Verified" or "Not verified", shortened nonce, signing address, every check with pass/fail, and a Re-check button with a new nonce. When a check fails the AI text is hidden.
- no key? run `pnpm --filter @shelter/attest test` — the same checks run offline against recorded fixtures (pass, wrong nonce, tampered `app_compose`, missing `model_attestations`).

## Libraries

- viem 2.57.x (MIT) — EVM RPC reads (balance, nonce, ENS reverse), test-key address derivation for fixtures, EIP-191 signature recovery for response signatures
- @phala/dcap-qvl 0.7.0 (Apache-2.0) — pure-JS DCAP quote verification (Intel TDX), runs in browser and Node
- openai 7.45.1 (Apache-2.0) — OpenAI-compatible client, server-side only, pointed at `https://cloud-api.near.ai/v1`
- vitest 3.x (MIT) — unit tests in packages/core and packages/attest
- tsx 4.x (MIT) — runs the TypeScript CLI and scripts
- typescript 5.9 (Apache-2.0)
- next 16 / react 19 (MIT) — web app
- tailwindcss 4 / @tailwindcss/postcss 4 (MIT)
- beUI components (MIT, vendored in `apps/web/components/`) — animated-badge, stateful button, card, collapsible for the Verified panel
- motion 14.x (MIT), clsx 2.x (MIT), tailwind-merge 3.x (MIT), lucide-react 1.x (ISC) — beUI/shadcn component dependencies

## Datasets

Static label data is bundled in `packages/core/data/` and queried locally only — the user's address set is never sent to a label API.

- `data/exchange-labels.json` — exchange addresses on Ethereum and Base, built by `scripts/build-labels.ts` from [dawsbot/eth-labels](https://github.com/dawsbot/eth-labels) (MIT), commit `d9b21ae`.
- `data/ofac-sanctioned.json` — OFAC-sanctioned ETH addresses, built by the same script from [0xB10C/ofac-sanctioned-digital-currency-addresses](https://github.com/0xB10C/ofac-sanctioned-digital-currency-addresses), `lists` branch (MIT), commit `abad1e7`.

To rebuild both datasets: `pnpm --filter @shelter/cli exec tsx ../../scripts/build-labels.ts`. To regenerate the fictional sample wallets: `pnpm --filter @shelter/cli exec tsx ../../scripts/gen-sample-wallets.ts`.

## License

MIT
