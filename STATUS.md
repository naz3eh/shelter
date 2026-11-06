# Status

**2026-11-06 13:04 UTC**

Scoring fixes, sample-wallet regeneration and CI are committed on
`fix/scan-ci-samples` (b51c213): check G now scores at confidence 1
(all-nine-checks report = 98.5), wallets clustered by link findings
inherit each other's A/B identity findings with the floor of 50, sample
addresses are keccak-derived fixture keys instead of the well-known
integer keys 1/2, and a GitHub Actions workflow runs
install/typecheck/build/test. The branch could not be pushed: the stored
PAT lacks `workflow` scope — the push and the PR are with the human.

## Goals

| Goal | Status | Proof |
| --- | --- | --- |
| G1 Scan (chain reader) | done | `packages/core` (PR #1, merged `635d046`) |
| G2 Exposure score A–I | done | `packages/core` engine + 31 vitest tests; this session: G confidence 1, inherited A/B on clustered wallets |
| G3 Link graph + samples | done | `packages/core/fixtures/sample-wallets/{clean,medium,exposed}.json` regenerated from `shelter:sample:*` keccak keys |
| G4 Intents layer | not started | `packages/intents` stub only |
| G5 Seed vault | not started | `packages/keys` stub only |
| G6 Burner engine | not started | `packages/burner` stub only |
| G7 NEAR AI explainer + Verified panel | **done** | live run 2026-11-06T07:07Z by the human: `pnpm --filter @shelter/cli explain --sample exposed` — real Intel TDX DCAP quotes verified, TCB UpToDate, nonce / RTMR3 / app_compose / response-signature checks all passed; code merged in PR #2 (`f8c1959`) |
| G8 Web screens | in progress | Verified panel on `/`; other screens not started |
| G9 `pnpm demo --dry-run` | not started | `scripts/demo` stub only |
| G10 README / LICENSE / threat model | in progress | README corrected (98.5, hashed fixture keys); threat model AI section added; other sections pending |
| G11 Hosted demo | not started | — |

Timeline: plan said G1–G3, G7, G8-fake-data by Nov 8. G1–G3 and G7 are
done (G7 verified live Nov 6, inside the window); G8 has only the panel.
**On track — G8 screens are the next push.**

## Build / typecheck / test

- `pnpm install` — clean
- `pnpm -r typecheck` — 7 projects pass
- `pnpm build` — passes (Next production build; also verified with no
  `.env` present, so CI needs no secrets)
- `pnpm -r test` — 44 tests pass (core 31, attest 13), no network calls
- `pnpm --filter @shelter/cli scan --sample exposed` — score **98.5/100**,
  band `doxxed`, findings A–I, both warnings, `linkedAddressCount: 2`
  (wallet 2 now shows inherited A and B)
- `scan --sample medium` — 21.5, `linkable`, findings D, F, H
- `scan --sample clean` — 0, `clean`

## Open PRs

- `fix/scan-ci-samples` — committed locally (b51c213), **push blocked**:
  the stored GitHub PAT cannot create `.github/workflows/ci.yml` without
  `workflow` scope. Human action needed:
  `git push -u origin fix/scan-ci-samples` with a token that has
  `workflow` scope (or SSH), then open the PR — do not merge.
  Suggested PR body:

  > Four narrow fixes from the scoring/samples/CI session:
  >
  > 1. **G confidence** — check G now scores `weight x 1` when its rule
  >    fires (shared top UTC send hour, ≥2 outgoing txs each). A report
  >    firing all nine checks scores 98.5, not 97.5. H stays at 0.5.
  > 2. **Inherited identity** — connected components built from findings
  >    with `linkedWallets` (C, D, E, G, I); every member of a cluster
  >    inherits the A/B findings held by any other member (same check,
  >    weight, confidence, points; detail marks it inherited). Per-wallet
  >    floor of 50 now reaches linked wallets; the set score is unchanged
  >    (each check still counts once). New tests cover the clustered case
  >    and the alone-wallet negative case.
  > 3. **Sample wallets** — all fixture addresses (scanned + unlabelled
  >    counterparties) derive from `keccak256("shelter:sample:<profile>:<name>")`
  >    instead of integer keys 1–20 that resolve to real mainnet accounts
  >    with history. Regenerated JSON keeps the same behaviour: exposed
  >    fires A–I + both warnings (doxxed, 98.5), medium is linkable
  >    (D, F, H), clean scores 0.
  > 4. **CI** — `.github/workflows/ci.yml`: ubuntu-latest, Node 20,
  >    pnpm 10, `pnpm install --frozen-lockfile`, `pnpm -r typecheck`,
  >    `pnpm build`, `pnpm -r test`. No secrets; tests are fully offline.
  >
  > Verified locally: install / typecheck / build / test all green;
  > `scan --sample exposed` prints 98.5 doxxed.

## Blockers / what I need from a human

1. **Push `fix/scan-ci-samples` and open the PR** — the stored PAT lacks
   `workflow` scope, which GitHub requires to push files under
   `.github/workflows/`. Either grant the token that scope, push from a
   credential that has it, or use SSH.
2. **`ONECLICK_JWT`** — still needed before G4's 1Click client can call
   the real API. Register at https://partners.near-intents.org.
3. No other blockers: `NEAR_AI_API_KEY` is in `.env` and the live path
   is green.

## Next 3 tasks

1. G8 web screens: setup → scan results → plan → move tracker → burner →
   re-scan before/after, wired to `packages/core` on sample data, with
   the VerifiedPanel beside each AI answer.
2. G4 1Click intents client (quotes `dry: true`, deposit/withdraw/status,
   `X-API-Key` from `ONECLICK_JWT`) once the JWT lands.
3. G5 seed vault + hardened derivation (`packages/keys`).

## Interface changes

None in `packages/intents` (untouched). Behaviour changes inside
`packages/core` only: `CHECK_CONFIDENCE.G` is now `1`, and
`ScanReport.findings` / `ExposureReport.findings` can contain A/B
findings marked `inherited:` for wallets clustered to an identified
wallet. No exported signatures changed.
