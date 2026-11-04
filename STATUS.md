# Status

**2026-11-04 14:14 UTC**

G7 is built and locally green: the NEAR AI explainer, the on-device TEE
attestation check (browser + CLI), the Verified panel, and the two CLI
commands all exist, with 13 offline fixture tests covering the failure
modes. The only thing that cannot run is the *live* check, which is
blocked on a real `NEAR_AI_API_KEY` from the human.

## Goals

| Goal | Status | Proof |
| --- | --- | --- |
| G1 Scan (chain reader) | done | `packages/core` (PR #1, merged `635d046`) |
| G2 Exposure score A–I | done | `packages/core` engine + 29 vitest tests |
| G3 Link graph + samples | done | `packages/core/fixtures/sample-wallets/{clean,medium,exposed}.json` |
| G4 Intents layer | not started | `packages/intents` stub only |
| G5 Seed vault | not started | `packages/keys` stub only |
| G6 Burner engine | not started | `packages/burner` stub only |
| G7 NEAR AI explainer + Verified panel | done modulo live key | this branch; see below |
| G8 Web screens | in progress | Verified panel on `/`; other screens not started |
| G9 `pnpm demo --dry-run` | not started | `scripts/demo` stub only |
| G10 README / LICENSE / threat model | in progress | README updated for G7; threat model AI section added; other sections pending |
| G11 Hosted demo | not started | — |

Timeline: plan said G1–G3, G7, G8-fake-data by Nov 8. G1–G3 done; G7 code
done, live run blocked on the key; G8 has only the panel so far.
**On track if the key arrives soon; the G8 screens are the next push.**

## Build / typecheck / test

- `pnpm install` — clean
- `pnpm -r typecheck` — 7 projects pass
- `pnpm build` — passes (incl. Next production build; `@phala/dcap-qvl`
  bundles into the client with browser shims)
- `pnpm -r test` — 42 tests pass (core 29, attest 13), no network calls

## Open PRs

- `feat/attest-verified-panel` → PR **not opened yet**: `gh` is not
  installed on this machine. The branch is committed locally; pushing it
  and opening the PR needs the human (HACKATHON.md: no push without
  explicit confirmation). Suggested PR body:

  > **G7: NEAR AI explainer + Verified panel.** Every check and where it
  > runs:
  >
  > | Check | Browser (panel) | CLI |
  > |---|---|---|
  > | Report fetch via `/api/attestation` proxy (nonce passes through unchanged) | yes | n/a (direct fetch) |
  > | Intel DCAP quote verify (@phala/dcap-qvl, collateral via Phala PCCS) | yes | yes |
  > | TDX debug flag off | yes | yes |
  > | `request_nonce` echoes fresh client nonce | yes | yes |
  > | `report_data` binds signer identity + nonce | yes | yes |
  > | RTMR3 replayed from `event_log` | yes | yes |
  > | `SHA-256(app_compose)` == MRCONFIGID | yes | yes |
  > | `model_attestations` present, every candidate checked | yes | yes |
  > | NVIDIA GPU evidence | shown "present, not verified" | shown "present, not verified" |
  > | Response signature: request/response hash binding, EIP-191 recover, exactly-one-signer match | yes | yes |
  >
  > API key stays server/CLI-side; the proxy only adds it. `/api/explain`
  > is stateless (no body logging, no storage, no analytics) and rejects
  > unredacted bodies. 13 fixture tests, no network. Do not merge.

## Blockers / what I need from a human

1. **`NEAR_AI_API_KEY`** — generate at https://cloud.near.ai (Q-000: $10
   free via NEAR Builders). Put it in `.env` (gitignored). Then:
   `pnpm verify-attestation` and
   `pnpm --filter @shelter/cli explain --sample exposed` should both pass.
2. **Push + PR** — `gh` missing; either install it or push
   `feat/attest-verified-panel` and open the PR yourself with the body
   above. Do not merge.
3. **DCAP live check unproven** — `@phala/dcap-qvl` verified offline via
   an injected seam; the real verifier has never run against a live quote
   (no key). If it fails on a real quote, that is a code fix on this
   branch, not a design change.

## Next 3 tasks

1. Human drops `NEAR_AI_API_KEY` in `.env` → run live
   `pnpm verify-attestation` + `explain --sample exposed`, fix whatever a
   real report/quote reveals, update this file.
2. G8 web screens: setup → scan results → plan → move tracker → burner →
   re-scan before/after, wired to `packages/core` on sample data.
3. G4 1Click intents client (quotes `dry: true`, deposit/withdraw/status,
   `X-API-Key` from `ONECLICK_JWT`) — needs the JWT from the human.

## Interface changes

None in `packages/intents` (untouched). New public surface added in
`packages/attest`: `verifyAttestation`, `fetchAttestationReport`,
`createDcapQuoteVerifier`, `generateNonce`, `checkNearReport`,
`replayRtmr3`, `redactScanReport`, `buildExplainMessages`,
`explainScanReport`, `unredactText`, `fetchResponseSignature`,
`verifyResponseSignature`, plus `DEFAULT_MODEL = "z-ai/glm-5.3-flash"`.
