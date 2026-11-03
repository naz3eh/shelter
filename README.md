# Shelter

Shelter is a privacy remediation app. Your device scans your public wallets (EVM chains such as Base), computes a 0-100 exposure score, and plans a private move into NEAR Confidential Intents through the 1Click API, using a one-time burner wallet for each public action. A NEAR AI Cloud TEE model is used only to explain results, and its attestation is verified on device.

## Layout

```
apps/web          Next.js app (App Router, TypeScript, Tailwind)
apps/cli          CLI and judge demo (TypeScript, run with tsx)
packages/core     exposure engine, planner, address book
packages/keys     seed vault, hardened derivation
packages/intents  1Click client, confidential balance, status tracking
packages/burner   one-time address lifecycle
packages/attest   NEAR AI attestation check
scripts/demo      recorded mainnet run for dry-run replay
docs              threat model and design notes
```

## Run

Requires Node 20+ and pnpm 10.

```sh
pnpm install
cp .env.example .env      # fill in ONECLICK_JWT and NEAR_AI_API_KEY
pnpm dev                  # web app on http://localhost:3000
pnpm typecheck
pnpm build
pnpm demo -- --dry-run
pnpm verify-attestation
```

## License

MIT
