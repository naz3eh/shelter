# Status

**2026-11-08 17:25 UTC**

G8 sample-data browser flow shipped on `feat/web-flow`: six connected
routes (setup → scan → plan → simulated move → simulated burner →
before/after re-scan) over the three bundled fictional profiles. Scans and
re-scans run the real `@shelter/core` engine in the browser; move and
burner are deterministic local simulations with scenario/retry/cancel
semantics — no wallet, keys, funds, signing or network calls anywhere in
the demo. G7 stays fail-closed: an answer renders only after attestation
and response-signature binding both pass. Correction to the previous
entry: PR #3 (`fix/scan-ci-samples`) **was merged** — the push-blocked
text below was stale; git log shows merge commit `67b6867`.

## Goals

| Goal | Status | Proof |
| --- | --- | --- |
| G1 Scan (chain reader) | done | `packages/core` (PR #1, merged `635d046`) |
| G2 Exposure score A–I | done | `packages/core` engine + 31 vitest tests; G confidence 1, inherited A/B (PR #3, merged `67b6867`) |
| G3 Link graph + samples | done | `packages/core/fixtures/sample-wallets/{clean,medium,exposed}.json` regenerated keccak-derived keys |
| G4 Intents layer | not started | `packages/intents` stub only — Viraz's lane |
| G5 Seed vault | not started | `packages/keys` stub only — Viraz's lane |
| G6 Burner engine | not started | `packages/burner` stub only — Viraz's lane |
| G7 NEAR AI explainer + Verified panel | done | live run 2026-11-06 verified Intel TDX DCAP quotes, nonce/RTMR3/app_compose/signature checks; merged PR #2 (`f8c1959`). Reused fail-closed on `/scan` via `lib/explain-client.ts` |
| G8 Web screens | **sample flow done** | `feat/web-flow`: all six routes functional on fictional data; real scanner for every score; 44 unit + 34 Playwright/axe tests green; see `docs/FRONTEND_HANDOFF.md` |
| G9 `pnpm demo --dry-run` | not started | `scripts/demo` stub only — Viraz's lane |
| G10 README / LICENSE / threat model | in progress | README now documents the sample flow, test commands and new deps; other sections pending |
| G11 Hosted demo | not started | — |

Timeline: G1–G3/G7 + G8 sample flow targeted Nov 8 — **met Nov 8** (this
branch). G4–G6 + approved mainnet run Nov 11, G9–G11 Nov 13, deadline
Nov 14 2026 23:59 UTC (Nov 15 05:29 IST). G4–G6/G9 are unstarted in
Viraz's lane — not labelled on track.

## Build / typecheck / test (this branch, 2026-11-08)

- `pnpm install --frozen-lockfile` — clean, lockfile up to date
- `pnpm -r typecheck` — 7 projects pass
- `pnpm build` — passes; Next production build emits all 8 routes
  (`/`, `/scan`, `/plan`, `/move`, `/burner`, `/rescan`, 2 API routes)
- `pnpm -r test` — **88 tests pass**: core 31, attest 13, web 44
  (money, plan validation/approval, real sample scans, move + burner
  sims, after-fixture, explain client)
- `pnpm --filter web test:e2e` — **34 Playwright tests pass** (17 specs ×
  desktop 1440×900 + mobile 390×844): full six-route flow, medium/clean
  profiles, invalid input, direct-route recovery, profile-change
  invalidation, plan approval revocation, invalid totals, partial
  funding + refund, cancel/retry, second burner action blocked,
  export provenance, explain unavailable/fail-closed, keyboard,
  reduced motion, axe (no serious/critical violations). Non-localhost
  requests are aborted — fully offline.
- Browser walkthrough: 18 screenshots (9 states × desktop/mobile) under
  `apps/web/test-results/screenshots/` — local artifact, not committed.

## Open PRs

- `feat/web-flow` — G8 sample flow (this session). PR to be opened for
  Nazeeh's review; **do not merge**.

## Blockers / what I need from a human

1. Review + merge decision on `feat/web-flow` (no auto-merge).
2. `ONECLICK_JWT` — still needed before G4's 1Click client can call the
   real API. Register at https://partners.near-intents.org.
3. `docs/BACKEND_HANDOFF.md` does not exist — Viraz's backend contract is
   undocumented; `docs/FRONTEND_HANDOFF.md` lists the methods the UI
   expects (plan, intents progress stream, burner lifecycle, post-move
   records) as open integration questions.

## Next 3 tasks

1. G4 intents client behind the UI adapter boundary (`PlanDraft` →
   planner, `MoveSimSnapshot`-shaped progress) once `ONECLICK_JWT` lands.
2. G5 seed vault + hardened derivation (`packages/keys`) — burner page is
   already labelled keyless.
3. G9 recorded-mainnet replay (`scripts/demo`) feeding `/rescan`'s
   after-fixture path with real recorded data.

## Interface changes

- `packages/core`: **import specifiers only** — NodeNext-style `.js`
  suffixes changed to extensionless relative paths (the package ships raw
  `src/*.ts` with `moduleResolution: "Bundler"` + `noEmit`; Turbopack
  could not resolve `.js`→`.ts`). No exported signatures or logic changed;
  all 31 core tests + evals unchanged.
- `apps/web/components/motion/button/base.tsx`: exports
  `BUTTON_VARIANT_CLASS`/`BUTTON_SIZE_CLASS`; `tabIndex={0}` added to
  Button/ButtonLink to fix an SSR/hydration mismatch (motion injects it
  client-side only).
- New `apps/web/components/link-button.tsx`: `next/link`-based button
  styling. Internal flow navigation must use it — plain `<a href>` reloads
  the document and wipes the in-memory flow store.
- New web deps: `@xyflow/react` 12.12.0 (MIT), `@playwright/test` 1.64.0
  (Apache-2.0), `@axe-core/playwright` 4.14.0 (MPL-2.0), `vitest` 3.2.7
  (MIT) — lockfile committed.
- New routes: `/scan`, `/plan`, `/move`, `/burner`, `/rescan`.
- No changes to `packages/intents`, `packages/keys`, `packages/burner`,
  `scripts/demo`, or eval fixtures.
