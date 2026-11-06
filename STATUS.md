# Status

**2026-11-06 07:52 UTC**

G7 is now proven end-to-end on the live NEAR AI Cloud: the human supplied
`NEAR_AI_API_KEY` and both live commands passed — `pnpm verify-attestation`
(16/16 checks, real Intel DCAP quote verified via @phala/dcap-qvl) and
`pnpm --filter @shelter/cli explain --sample exposed` (attestation
preflight, redacted completion, 6/6 response-signature checks,
VERIFIED ANSWER, completion `c556243cbd2447c3aaf0b4db939baf6a`). Branch
`feat/attest-verified-panel` is pushed; PR opening/do-not-merge is with
the human (`gh` is not installed here).

## Goals

| Goal | Status | Proof |
| --- | --- | --- |
| G1 Scan (chain reader) | done | `packages/core` (PR #1, merged `635d046`) |
| G2 Exposure score A–I | done | `packages/core` engine + 29 vitest tests |
| G3 Link graph + samples | done | `packages/core/fixtures/sample-wallets/{clean,medium,exposed}.json` |
| G4 Intents layer | not started | `packages/intents` stub only |
| G5 Seed vault | not started | `packages/keys` stub only |
| G6 Burner engine | not started | `packages/burner` stub only |
| G7 NEAR AI explainer + Verified panel | **done** | live run 2026-11-06T07:07Z: nonce `4941e9e7…0d763f`, model signer `0x3b753b44…0424fa0c`, gateway signer `0xb98a789c…a957e779`, 16/16 attestation + 6/6 signature checks PASS, completion `c556243cbd2447c3aaf0b4db939baf6a`; code on `feat/attest-verified-panel` |
| G8 Web screens | in progress | Verified panel on `/`; other screens not started |
| G9 `pnpm demo --dry-run` | not started | `scripts/demo` stub only |
| G10 README / LICENSE / threat model | in progress | README updated for G7; threat model AI section added; other sections pending |
| G11 Hosted demo | not started | — |

Timeline: plan said G1–G3, G7, G8-fake-data by Nov 8. G1–G3 and G7 done
(G7 verified live on Nov 6, inside the window); G8 has only the panel.
**On track — G8 screens are the next push.**

## Build / typecheck / test

- `pnpm install` — clean
- `pnpm -r typecheck` — 7 projects pass
- `pnpm build` — passes (incl. Next production build; `@phala/dcap-qvl`
  bundles into the client with browser shims)
- `pnpm -r test` — 42 tests pass (core 29, attest 13), no network calls
- Live: `pnpm verify-attestation` → VERIFIED, 16/16 checks (2026-11-06)
- Live: `pnpm --filter @shelter/cli explain --sample exposed` → VERIFIED
  ANSWER, explanation printed (2026-11-06)

## Open PRs

- `feat/attest-verified-panel` — pushed 2026-11-04; open the PR at
  https://github.com/naz3eh/shelter/pull/new/feat/attest-verified-panel
  (`gh` not installed). Do not merge. PR body (check table + limits) was
  provided to the human; the "live run not yet executed" caveat is now
  obsolete — the live run passed and is logged above.

## Blockers / what I need from a human

1. **Open the PR** for `feat/attest-verified-panel` (link + body above);
   do not merge.
2. **`ONECLICK_JWT`** — needed before G4's 1Click client can call the real
   API. Register at https://partners.near-intents.org.
3. No other blockers: `NEAR_AI_API_KEY` is now in `.env` and the live
   path is green.

## Next 3 tasks

1. G8 web screens: setup → scan results → plan → move tracker → burner →
   re-scan before/after, wired to `packages/core` on sample data, with the
   VerifiedPanel beside each AI answer.
2. G4 1Click intents client (quotes `dry: true`, deposit/withdraw/status,
   `X-API-Key` from `ONECLICK_JWT`) once the JWT lands.
3. G5 seed vault + hardened derivation (`packages/keys`).

## Interface changes

None in `packages/intents` (untouched). New public surface added in
`packages/attest`: `verifyAttestation`, `fetchAttestationReport`,
`createDcapQuoteVerifier`, `generateNonce`, `checkNearReport`,
`replayRtmr3`, `redactScanReport`, `buildExplainMessages`,
`explainScanReport`, `unredactText`, `fetchResponseSignature`,
`verifyResponseSignature`, plus `DEFAULT_MODEL = "z-ai/glm-5.3-flash"`.
