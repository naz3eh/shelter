# Status

**2026-11-03 15:20 UTC**

Session summary: Implemented the off-chain scan (G1–G3) in `packages/core` — ChainReader over viem + configurable Blockscout v2 + NEAR RPC, `scanWallets` exposure engine with checks A–I, bundled exchange/OFAC label sets, plain-JSON link graph, and three fictional sample profiles wired to `shelter scan`. Scoring follows the spec: each check contributes weight × confidence once for the wallet set (max confidence per check), capped at 100, floor 50 when A or B fires; per-wallet scores kept as secondary detail.

## Goals

| Goal | Status | Proof |
|---|---|---|
| G1 Scan: chain reader lists EVM history | done | `packages/core/src/reader/` (viem + Blockscout v2 + NEAR view_account; `FixtureReader` offline) |
| G2 Exposure score 0–100, checks A–I, bands, warnings | done | `packages/core/src/exposure/engine.ts`; 29 tests in `packages/core/test/` |
| G3 Link graph + fictional sample wallets | done | `packages/core/src/graph/`; `fixtures/sample-wallets/{exposed,medium,clean}.json` |
| G4 Intents layer (1Click quotes/deposit/withdraw/status) | not started | stub in `packages/intents` (teammate-owned) |
| G5 Seed vault + hardened derivation | not started | stub in `packages/keys` (teammate-owned) |
| G6 Burner engine | not started | stub in `packages/burner` (teammate-owned) |
| G7 NEAR AI explainer + Verified panel + verify-attestation | not started | stub in `packages/attest` |
| G8 Web screens | not started | `apps/web` placeholder page only |
| G9 `pnpm demo --dry-run` replay | not started | `apps/cli/src/demo.ts` prints "not implemented" |
| G10 README + LICENSE + THREAT_MODEL | in progress | README updated (libraries, datasets, "Try the scan"); `docs/THREAT_MODEL.md` chain-reader section added, rest still TODO |
| G11 Hosted demo live until ≥ Nov 18 | not started | — |

## Build / typecheck / test

- `pnpm install` — clean
- `pnpm -r typecheck` — pass (7/7 projects)
- `pnpm build` — pass (web builds; library packages have no build step)
- `pnpm -r test` — pass, 29/29 tests in `@shelter/core`

## Open PRs

- **PR: `feat/core-scan` → `main`** (branch pushed; PR to be opened by the human at https://github.com/naz3eh/shelter/pull/new/feat/core-scan — `gh` not installed and API PR creation was declined). Contains the whole G1–G3 scan implementation. Do not merge.

## Blockers

- Need `gh` installed (or the human opens the PR + posts comments) — I cannot create the PR or the required PR comment myself.
- `ONECLICK_JWT` and `NEAR_AI_API_KEY` needed later for G4/G7.
- Scoring interpretation was clarified this session (per-check dedupe across the set, not per wallet).

## Next 3 tasks

1. Merge `feat/core-scan` once the human approves; keep main green.
2. G7: NEAR AI explainer + `verify-attestation` script (due on fake data by Nov 8).
3. G8: web screens on fixture data (setup, scan results, plan, move tracker, burner, re-scan).

## Interface changes

- `@shelter/core`: `scoreExposure` stub replaced by `scanWallets(wallets, reader): Promise<ScanReport>`. `WalletRef` and `ExposureReport` kept; `ExposureFinding` now has `check/weight/confidence/points/evidence` fields. New exports: `CHECKS`, `CHECK_CONFIDENCE`, `bandForScore`, `createChainReader`, `FixtureReader`, `BlockscoutClient`, `createLabelStore`, `buildLinkGraph`, and reader/graph types.
- `packages/intents` public interface untouched.

## Plan check

On track. Deadline plan: G1–G3, G7, G8 on fake data by Nov 8 — G1–G3 done Nov 3.
