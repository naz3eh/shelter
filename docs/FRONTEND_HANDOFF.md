# Frontend handoff — G8 sample-data flow

Scope: the browser demo in `apps/web` that walks a fictional wallet through
scan → plan → simulated private move → simulated burner → before/after
re-scan. **This is not a live private move.** Completing the G8 demo does
not complete G4–G6 or G9, moves no funds, signs nothing, and connects no
wallet. All figures come from the real `@shelter/core` scanner run in the
browser over bundled fictional fixtures; all money movement is a
deterministic local simulation.

## File map

| Area | Path |
| --- | --- |
| Flow state types | `apps/web/lib/flow/types.ts` |
| Store / provider / orchestration | `apps/web/lib/flow/store.tsx` |
| Sample profile loading | `apps/web/lib/flow/profiles.ts` |
| Integer base-unit math | `apps/web/lib/flow/money.ts` |
| UI-only plan draft/validation/approval | `apps/web/lib/flow/plan.ts` |
| Move simulation engine | `apps/web/lib/flow/sim/move.ts` |
| Burner simulation engine | `apps/web/lib/flow/sim/burner.ts` |
| Fictional post-move fixture builder | `apps/web/lib/flow/sim/after-fixture.ts` |
| G7 explain client (fail-closed) | `apps/web/lib/explain-client.ts` |
| Routes | `apps/web/app/{,scan,plan,move,burner,rescan}/page.tsx` |
| Shared UI | `apps/web/components/{flow-header,step-tracker,findings,link-graph,explain-card,recovery,band-badge,link-button}.tsx` |
| Unit tests | `apps/web/tests/*.test.ts` (Vitest) |
| Browser tests | `apps/web/e2e/{flow,a11y,helpers}.ts` (Playwright + axe) |

## UI state shapes

`FlowState` (`lib/flow/types.ts`) is held in a React context
(`FlowProvider`/`useFlow`, `lib/flow/store.tsx`). It is **in-memory only** —
no URL params, cookies, `localStorage`, analytics, or server actions carry
addresses or results. Reloading or direct-navigating to a downstream route
yields a recovery state, never a fabricated run.

Key slices:

- `scan: ScanSlice` — `status`, `profileId`, `report: ScanReport | null`,
  `profile: FixtureProfile | null`, `scannedAt`, `error`. The report is
  produced by `scanWallets(sampleWallets(profile), new FixtureReader(profile))`
  inside the browser.
- `planDraft: PlanDraft | null` — editable strings: `chunkCount`,
  `usdcPerChunk`, `ethPerChunk`, `startDelayMin`, `spreadMin`.
- `planApproval: PlanApproval | null` — immutable `ApprovedPlan` snapshot
  (`hash`, `chunks`, `timing`, `totals`, `simulatedFeeUsdc`). Any draft edit
  after approval clears it.
- `moveSettings` / `moveSim: MoveSimSnapshot | null` — scenario
  (`happy | partial-funding | deposit-refund`), pace (`relaxed | brisk`),
  `steps: SimStep[]`, `chunks: MoveChunkResult[]`, `events`,
  `outcome: running | completed | partial | cancelled`.
- `burnerDraft` / `burnerApproval` / `burnerSettings` / `burnerSim` — same
  pattern; `BurnerSimSnapshot` adds `burnerAddress` (a label only — no key
  material exists), `dustEth`, and scenario
  (`happy | insufficient-gas | funding-failed | payment-failed`).
- `rescan: RescanSlice` — `afterReport`, `afterProfile` (the generated
  fictional fixture), `notes`, `fundedChunks/totalChunks`,
  `burnerIncluded`, keyed by `rescanKey(...)` so a stale after-report can
  never attach to a newer run.

`FlowApi` actions: `selectProfile`, `startSampleScan`, `retryScan`,
`ensurePlanDraft`, `setPlanDraft`, `approvePlan`, `setMoveSettings`,
`startMove`, `cancelMove`, `retryMove`, `restartMove`, `ensureBurnerDraft`,
`setBurnerDraft`, `approveBurner`, `setBurnerSettings`, `startBurner`,
`cancelBurner`, `retryBurner`, `restartBurner`, `computeRescan`, `resetFlow`.
`approvePlan`/`approveBurner` return `{ ok, errors? }` — validation failures
are data, not exceptions.

## Simulation adapter contracts

Both engines are classes owned by the store; the store disposes them on
profile change, reset, or unmount.

```ts
new MoveSimulation({
  plan: ApprovedPlan,
  scenario: MoveScenario,
  pace: DemoPace,
  onSnapshot: (s: MoveSimSnapshot) => void,
  durations?: Partial<Record<SimStepKind, number>>, // test hook only
})
// methods: start(), cancel(), retry(), snapshot(), dispose()

new BurnerSimulation({
  plan: BurnerPlan,
  scenario: BurnerScenario,
  pace: DemoPace,
  onSnapshot: (s: BurnerSimSnapshot) => void,
  durations?: Partial<Record<SimStepKind, number>>,
})
// methods: start(), cancel(), retry(), snapshot(), dispose()
```

- Steps advance on `setTimeout` handles tracked in a `Set`; `cancel()` and
  `dispose()` clear every pending timer. Pace `relaxed` ≈ 0.8–1.1 s/step,
  `brisk` ≈ 40–60 ms/step — both are labelled "demo timing", and the UI notes
  that short real-world delays are linkable.
- `retry()` resumes from the first non-completed step; completed steps are
  never duplicated. `cancel()` preserves completed steps and marks the run
  `cancelled`; `restart*()` builds a fresh engine.
- Determinism: addresses are SHA-256-derived fictional strings
  (`lib/flow/plan.ts`, `after-fixture.ts`); there is no randomness, network,
  or clock dependence beyond step pacing.
- Scenarios are first-class (`MoveScenario`, `BurnerScenario`) so backend
  adapters can later map real failure modes onto the same step model.

## Backend methods still needed (G4–G6/G9 — Viraz's lane)

The UI is deliberately adapter-ready but calls **none** of these today:

1. `planRemediation` equivalent — replace `lib/flow/plan.ts` draft/approve
   with a real planner call. Boundary: UI sends `PlanDraft`-equivalent +
   `ScanReport`; backend returns chunks/timing/fee quote. Current fee
   (`simulatedFeeUsdc`, 0.2% of USDC total) is illustrative only.
2. Intent deposit/settle/withdraw stream — a progress/event API shaped like
   `MoveSimSnapshot` (`steps`, `events`, `outcome`) with resume semantics.
   The store already treats snapshots as the contract.
3. Burner vault/funding/action lifecycle — same snapshot contract; must
   enforce one-business-action-per-burner server-side (UI also blocks it).
4. Post-move attestation/receipt data for `/rescan` — today the after
   fixture is generated locally (`after-fixture.ts`); a live version would
   ingest real post-move records instead.
5. G7 explain already works via `/api/explain` + `/api/attestation`; no
   changes needed for the demo. `NEAR_AI_API_KEY` stays server-side; the
   sample flow never calls it unless the user explicitly requests an
   explanation.

## Progress / error / retry / resume semantics

- Scan: `idle → loading → done | error`; `retryScan` recomputes in-browser.
  A stale async scan cannot overwrite a newer one (generation guard in the
  store).
- Plan: draft edits invalidate `planApproval`; unapproved plans cannot start
  a move (`startMove` is gated on `planApproval`).
- Move/burner: `idle → running → done | failed | cancelled`; per-step
  `StepStatus` is `pending|active|completed|failed|refunded|skipped|cancelled`.
  `retry*` resumes; `cancel*` stops timers; `restart*` resets to idle.
- Rescan: `idle → running → done | error`, guarded by `rescanKey` so results
  only render for the run that produced them.
- G7: answers render only after attestation **and** response-signature
  binding pass inside `VerifiedPanel`; pending re-check or failure hides the
  prior answer immediately. Missing `NEAR_AI_API_KEY` → explicit "unavailable"
  state, scanning unaffected.

## Unresolved integration questions

- Real chunk sizing: how should the planner split USDC/ETH across intents —
  per-deposit minimums, sequencing constraints, fee schedule?
- Resume token: does the intents backend expose a run/session id the UI can
  poll, or must it push events? The store assumes pull-style snapshots.
- Burner custody: who holds burner keys in production (G5 vault)? The demo
  deliberately has no key material.
- Re-scan provenance: should the after-dataset be a recorded fixture like
  `packages/core/fixtures/`, or assembled from live chain reads?
- Privacy claims: copy must keep stating that old public history is not
  erased and that amounts/timing can still correlate.

## Notes for reviewers

- `packages/core` import specifiers were changed from NodeNext-style `.js`
  to extensionless relative paths (specifiers only, no logic) because the
  package ships raw `src/*.ts` (`main: ./src/index.ts`) and Turbopack could
  not resolve `.js` specifiers against `.ts` files during `next build`.
  `moduleResolution: "Bundler"` + `noEmit` make this the correct form; all
  package regressions were re-run.
- `apps/web/components/motion/button/base.tsx` exports
  `BUTTON_VARIANT_CLASS`/`BUTTON_SIZE_CLASS` so `components/link-button.tsx`
  can render `next/link` anchors with identical styling. Internal flow
  navigation must use `next/link` (client-side) — a plain `<a href>` reloads
  the document and wipes the in-memory store.
- `apps/web/AGENTS.md` is auto-generated by `next dev` (its own header asks
  that it be committed to keep the tree clean); included in this change.
