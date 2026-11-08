"use client";

/**
 * Client-side flow store for the G8 sample-data demo.
 *
 * Holds the selected fictional profile, the computed scan report, the
 * UI-only plan draft + approval, and the simulated move/burner/re-scan
 * state. Everything lives in memory: no URLs, cookies, storage, analytics
 * or server actions carry addresses or results. Live simulation engines
 * (timers) live in refs so they survive route changes inside the SPA.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from "react";
import {
  FixtureReader,
  scanWallets,
  type WalletRef,
} from "@shelter/core";
import {
  buildApprovedPlan,
  demoAddress,
  DEFAULT_PLAN_DRAFT,
  ethBudgetFromProfile,
  validatePlanDraft,
  type PlanContext,
} from "./plan";
import { SAMPLE_PROFILES, sampleWallets } from "./profiles";
import { MoveSimulation } from "./sim/move";
import { BurnerSimulation } from "./sim/burner";
import { buildAfterProfile } from "./sim/after-fixture";
import {
  baseToDecimalString,
  decimalToBase,
  USDC_DECIMALS,
} from "./money";
import type {
  ApprovedPlan,
  BurnerDraft,
  BurnerPlan,
  BurnerSettings,
  BurnerSimSnapshot,
  FlowState,
  MoveSettings,
  MoveSimSnapshot,
  PlanDraft,
  RescanSlice,
  SampleId,
} from "./types";

const INITIAL_RESCAN: RescanSlice = {
  status: "idle",
  key: null,
  afterReport: null,
  afterProfile: null,
  notes: [],
  fundedChunks: 0,
  totalChunks: 0,
  burnerIncluded: false,
  computedAt: null,
  error: null,
};

const initialState = (): FlowState => ({
  profileId: null,
  scan: {
    status: "idle",
    profileId: null,
    report: null,
    profile: null,
    scannedAt: null,
    error: null,
  },
  planDraft: null,
  planApproval: null,
  moveSettings: { scenario: "happy", pace: "relaxed" },
  moveSim: null,
  burnerDraft: null,
  burnerApproval: null,
  burnerSettings: { scenario: "happy", pace: "relaxed" },
  burnerSim: null,
  rescan: INITIAL_RESCAN,
});

type Action =
  | { type: "profile:select"; profileId: SampleId | null }
  | { type: "scan:start"; profileId: SampleId }
  | {
      type: "scan:done";
      profileId: SampleId;
      report: NonNullable<FlowState["scan"]["report"]>;
      profile: NonNullable<FlowState["scan"]["profile"]>;
      scannedAt: string;
    }
  | { type: "scan:error"; profileId: SampleId; error: string }
  | { type: "plan:draft"; draft: PlanDraft }
  | { type: "plan:approve"; plan: ApprovedPlan; approvedAt: string }
  | { type: "move:settings"; settings: MoveSettings }
  | { type: "move:snapshot"; snapshot: MoveSimSnapshot }
  | { type: "move:clear" }
  | { type: "burner:draft"; draft: BurnerDraft }
  | { type: "burner:approve"; plan: BurnerPlan; approvedAt: string }
  | { type: "burner:settings"; settings: BurnerSettings }
  | { type: "burner:snapshot"; snapshot: BurnerSimSnapshot }
  | { type: "burner:clear" }
  | { type: "rescan:start"; key: string }
  | {
      type: "rescan:done";
      key: string;
      afterReport: NonNullable<RescanSlice["afterReport"]>;
      afterProfile: NonNullable<RescanSlice["afterProfile"]>;
      notes: string[];
      fundedChunks: number;
      totalChunks: number;
      burnerIncluded: boolean;
      computedAt: string;
    }
  | { type: "rescan:error"; key: string; error: string }
  | { type: "flow:reset" };

/** Everything downstream of the scan dies when the profile changes. */
function downstreamReset(state: FlowState): FlowState {
  return {
    ...state,
    planDraft: null,
    planApproval: null,
    moveSim: null,
    burnerDraft: null,
    burnerApproval: null,
    burnerSim: null,
    rescan: INITIAL_RESCAN,
  };
}

function reducer(state: FlowState, action: Action): FlowState {
  switch (action.type) {
    case "profile:select": {
      if (action.profileId === state.profileId) return state;
      const next = downstreamReset(state);
      return {
        ...next,
        profileId: action.profileId,
        scan: {
          status: "idle",
          profileId: action.profileId,
          report: null,
          profile: null,
          scannedAt: null,
          error: null,
        },
      };
    }
    case "scan:start":
      return {
        ...state,
        scan: {
          status: "loading",
          profileId: action.profileId,
          report: null,
          profile: null,
          scannedAt: null,
          error: null,
        },
      };
    case "scan:done": {
      // A stale async result must never overwrite a newer scan.
      if (
        state.scan.status !== "loading" ||
        state.scan.profileId !== action.profileId
      )
        return state;
      return {
        ...downstreamReset(state),
        scan: {
          status: "done",
          profileId: action.profileId,
          report: action.report,
          profile: action.profile,
          scannedAt: action.scannedAt,
          error: null,
        },
      };
    }
    case "scan:error": {
      if (
        state.scan.status !== "loading" ||
        state.scan.profileId !== action.profileId
      )
        return state;
      return {
        ...state,
        scan: { ...state.scan, status: "error", error: action.error },
      };
    }
    case "plan:draft":
      // Any edit invalidates the approval and everything downstream of it.
      return {
        ...downstreamReset(state),
        planDraft: action.draft,
        planApproval: null,
      };
    case "plan:approve":
      return {
        ...state,
        planApproval: { plan: action.plan, approvedAt: action.approvedAt },
      };
    case "move:settings":
      return { ...state, moveSettings: action.settings };
    case "move:snapshot": {
      // Snapshots only count while they belong to the currently approved plan.
      if (state.planApproval?.plan.hash !== action.snapshot.planHash)
        return state;
      return { ...state, moveSim: action.snapshot };
    }
    case "move:clear":
      return { ...state, moveSim: null };
    case "burner:draft":
      return {
        ...state,
        burnerDraft: action.draft,
        burnerApproval: null,
        burnerSim: null,
      };
    case "burner:approve":
      return {
        ...state,
        burnerApproval: { plan: action.plan, approvedAt: action.approvedAt },
      };
    case "burner:settings":
      return { ...state, burnerSettings: action.settings };
    case "burner:snapshot": {
      if (state.burnerApproval?.plan.hash !== action.snapshot.planHash)
        return state;
      return { ...state, burnerSim: action.snapshot };
    }
    case "burner:clear":
      return { ...state, burnerSim: null };
    case "rescan:start":
      return {
        ...state,
        rescan: { ...INITIAL_RESCAN, status: "running", key: action.key },
      };
    case "rescan:done": {
      if (state.rescan.key !== action.key) return state;
      return {
        ...state,
        rescan: {
          status: "done",
          key: action.key,
          afterReport: action.afterReport,
          afterProfile: action.afterProfile,
          notes: action.notes,
          fundedChunks: action.fundedChunks,
          totalChunks: action.totalChunks,
          burnerIncluded: action.burnerIncluded,
          computedAt: action.computedAt,
          error: null,
        },
      };
    }
    case "rescan:error": {
      if (state.rescan.key !== action.key) return state;
      return {
        ...state,
        rescan: { ...state.rescan, status: "error", error: action.error },
      };
    }
    case "flow:reset":
      return initialState();
    default:
      return state;
  }
}

/** Deterministic signature for the post-move dataset inputs. */
export function rescanKey(input: {
  planHash: string;
  moveFinishedAt: string | null;
  burnerHash: string | null;
  burnerStatus: string | null;
}): string {
  return [
    input.planHash,
    input.moveFinishedAt ?? "-",
    input.burnerHash ?? "-",
    input.burnerStatus ?? "-",
  ].join("|");
}

export interface FlowApi {
  state: FlowState;
  selectProfile: (id: SampleId | null) => void;
  /** Pick a sample and compute its report in the browser. */
  startSampleScan: (id: SampleId) => void;
  retryScan: () => void;
  ensurePlanDraft: () => void;
  setPlanDraft: (draft: PlanDraft) => void;
  approvePlan: () => Promise<{ ok: boolean; errors?: string[] }>;
  setMoveSettings: (settings: MoveSettings) => void;
  startMove: () => void;
  cancelMove: () => void;
  retryMove: () => void;
  restartMove: () => void;
  ensureBurnerDraft: () => void;
  setBurnerDraft: (draft: BurnerDraft) => void;
  approveBurner: () => Promise<{ ok: boolean; errors?: string[] }>;
  setBurnerSettings: (settings: BurnerSettings) => void;
  startBurner: () => void;
  cancelBurner: () => void;
  retryBurner: () => void;
  restartBurner: () => void;
  computeRescan: () => Promise<void>;
  resetFlow: () => void;
}

const FlowContext = createContext<FlowApi | null>(null);

export function useFlow(): FlowApi {
  const ctx = useContext(FlowContext);
  if (!ctx) throw new Error("useFlow must be used inside <FlowProvider>");
  return ctx;
}

/** Simulated gas money delivered to a burner, wei (0.0003 ETH). */
const BURNER_FUNDING_ETH_WEI = 300_000_000_000_000n;
/** Simulated gas the single payment needs, wei (0.00021 ETH). */
const BURNER_REQUIRED_GAS_WEI = 210_000n * 1_000_000_000n;
/** USDC buffer added on top of the payment amount, base units (1 USDC). */
const BURNER_USDC_BUFFER = 1_000_000n;

export function FlowProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const scanGen = useRef(0);
  const rescanGen = useRef(0);
  const moveEngine = useRef<MoveSimulation | null>(null);
  const burnerEngine = useRef<BurnerSimulation | null>(null);

  const disposeEngines = useCallback(() => {
    moveEngine.current?.dispose();
    moveEngine.current = null;
    burnerEngine.current?.dispose();
    burnerEngine.current = null;
  }, []);

  // ---- scan ------------------------------------------------------------

  const runScan = useCallback(async (profileId: SampleId) => {
    const gen = ++scanGen.current;
    dispatch({ type: "scan:start", profileId });
    const sample = SAMPLE_PROFILES[profileId];
    try {
      const report = await scanWallets(
        sampleWallets(sample.profile) as WalletRef[],
        new FixtureReader(sample.profile),
      );
      if (gen !== scanGen.current) return; // stale — a newer scan owns the slot
      dispatch({
        type: "scan:done",
        profileId,
        report,
        profile: sample.profile,
        scannedAt: new Date().toISOString(),
      });
    } catch (err) {
      if (gen !== scanGen.current) return;
      dispatch({
        type: "scan:error",
        profileId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  const selectProfile = useCallback(
    (id: SampleId | null) => {
      scanGen.current += 1; // invalidate any in-flight scan
      rescanGen.current += 1;
      disposeEngines();
      dispatch({ type: "profile:select", profileId: id });
    },
    [disposeEngines],
  );

  const startSampleScan = useCallback(
    (id: SampleId) => {
      selectProfile(id);
      void runScan(id);
    },
    [runScan, selectProfile],
  );

  const retryScan = useCallback(() => {
    const id = stateRef.current.scan.profileId ?? stateRef.current.profileId;
    if (id) void runScan(id);
  }, [runScan]);

  // ---- plan ------------------------------------------------------------

  const planContext = useCallback((): PlanContext | null => {
    const s = stateRef.current;
    if (!s.profileId || !s.scan.profile) return null;
    return {
      profileId: s.profileId,
      ethBudgetWei: ethBudgetFromProfile(s.scan.profile),
    };
  }, []);

  const ensurePlanDraft = useCallback(() => {
    const s = stateRef.current;
    if (s.planDraft || !s.scan.profile) return;
    dispatch({ type: "plan:draft", draft: { ...DEFAULT_PLAN_DRAFT } });
  }, []);

  const setPlanDraft = useCallback((draft: PlanDraft) => {
    dispatch({ type: "plan:draft", draft });
  }, []);

  const approvePlan = useCallback(async () => {
    const s = stateRef.current;
    const ctx = planContext();
    if (!s.planDraft || !ctx)
      return { ok: false, errors: ["No plan draft to approve."] };
    const validation = validatePlanDraft(s.planDraft, ctx);
    if (!validation.ok) return { ok: false, errors: validation.errors };
    const built = await buildApprovedPlan(s.planDraft, ctx);
    if ("errors" in built) return { ok: false, errors: built.errors };
    dispatch({
      type: "plan:approve",
      plan: built.plan,
      approvedAt: new Date().toISOString(),
    });
    return { ok: true };
  }, [planContext]);

  // ---- move simulation ---------------------------------------------------

  const startMoveEngine = useCallback(() => {
    const s = stateRef.current;
    const plan = s.planApproval?.plan;
    if (!plan) return;
    moveEngine.current?.dispose();
    const engine = new MoveSimulation({
      plan,
      scenario: s.moveSettings.scenario,
      pace: s.moveSettings.pace,
      onSnapshot: (snapshot) =>
        dispatch({ type: "move:snapshot", snapshot }),
    });
    moveEngine.current = engine;
    engine.start();
  }, []);

  const setMoveSettings = useCallback((settings: MoveSettings) => {
    dispatch({ type: "move:settings", settings });
  }, []);

  const startMove = useCallback(() => {
    startMoveEngine();
  }, [startMoveEngine]);

  const cancelMove = useCallback(() => {
    moveEngine.current?.cancel();
  }, []);

  const retryMove = useCallback(() => {
    moveEngine.current?.retry();
  }, []);

  const restartMove = useCallback(() => {
    moveEngine.current?.dispose();
    moveEngine.current = null;
    dispatch({ type: "move:clear" });
    startMoveEngine();
  }, [startMoveEngine]);

  // ---- burner simulation -------------------------------------------------

  const burnerAmounts = useCallback(() => {
    const s = stateRef.current;
    if (!s.burnerDraft) return null;
    const amountBase = decimalToBase(s.burnerDraft.amountUsdc, USDC_DECIMALS);
    if (amountBase === null || amountBase <= 0n) return null;
    return {
      amountBase,
      fundingUsdcBase: amountBase + BURNER_USDC_BUFFER,
      fundingEthWei: BURNER_FUNDING_ETH_WEI,
      requiredGasWei: BURNER_REQUIRED_GAS_WEI,
    };
  }, []);

  const ensureBurnerDraft = useCallback(async () => {
    const s = stateRef.current;
    if (s.burnerDraft || !s.profileId) return;
    const seed = s.planApproval?.plan.hash ?? s.profileId;
    dispatch({
      type: "burner:draft",
      draft: {
        recipient: await demoAddress("payee", seed, 0),
        amountUsdc: "10",
      },
    });
  }, []);

  const setBurnerDraft = useCallback((draft: BurnerDraft) => {
    dispatch({ type: "burner:draft", draft });
  }, []);

  const approveBurner = useCallback(async () => {
    const s = stateRef.current;
    const amounts = burnerAmounts();
    if (!s.burnerDraft || !amounts || !s.planApproval || !s.profileId) {
      return { ok: false, errors: ["No burner draft to approve."] };
    }
    const { recipient, amountUsdc } = s.burnerDraft;
    const errors: string[] = [];
    if (!/^0x[0-9a-fA-F]{40}$/.test(recipient.trim())) {
      errors.push("Recipient must be a 0x-prefixed 40-hex-character address.");
    }
    if (amounts.amountBase > amounts.fundingUsdcBase) {
      errors.push("Payment exceeds the simulated burner funding.");
    }
    if (errors.length) return { ok: false, errors };

    const seed = `${s.profileId}:${s.planApproval.plan.hash}`;
    const canonical = JSON.stringify({
      r: recipient.trim().toLowerCase(),
      a: amountUsdc.trim(),
      f: amounts.fundingUsdcBase.toString(),
      g: amounts.fundingEthWei.toString(),
    });
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`shelter:burner:${seed}:${canonical}`),
    );
    const hash = [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 16);
    const burnerAddress = await demoAddress("burner", hash, 0);

    const plan: BurnerPlan = {
      hash,
      profileId: s.profileId,
      movePlanHash: s.planApproval.plan.hash,
      approvedAt: new Date().toISOString(),
      burnerAddress,
      fundingUsdc: baseToDecimalString(
        amounts.fundingUsdcBase.toString(),
        USDC_DECIMALS,
      ),
      fundingUsdcBase: amounts.fundingUsdcBase.toString(),
      fundingEth: baseToDecimalString(
        amounts.fundingEthWei.toString(),
        18,
      ),
      fundingEthWei: amounts.fundingEthWei.toString(),
      requiredGasEth: baseToDecimalString(
        amounts.requiredGasWei.toString(),
        18,
      ),
      payment: {
        recipient: recipient.trim(),
        amountUsdc: amountUsdc.trim(),
        amountUsdcBase: amounts.amountBase.toString(),
      },
    };
    dispatch({
      type: "burner:approve",
      plan,
      approvedAt: new Date().toISOString(),
    });
    return { ok: true };
  }, [burnerAmounts]);

  const setBurnerSettings = useCallback((settings: BurnerSettings) => {
    dispatch({ type: "burner:settings", settings });
  }, []);

  const startBurnerEngine = useCallback(() => {
    const s = stateRef.current;
    const plan = s.burnerApproval?.plan;
    if (!plan) return;
    burnerEngine.current?.dispose();
    const engine = new BurnerSimulation({
      plan,
      scenario: s.burnerSettings.scenario,
      pace: s.burnerSettings.pace,
      onSnapshot: (snapshot) =>
        dispatch({ type: "burner:snapshot", snapshot }),
    });
    burnerEngine.current = engine;
    engine.start();
  }, []);

  const startBurner = useCallback(() => {
    startBurnerEngine();
  }, [startBurnerEngine]);

  const cancelBurner = useCallback(() => {
    burnerEngine.current?.cancel();
  }, []);

  const retryBurner = useCallback(() => {
    burnerEngine.current?.retry();
  }, []);

  const restartBurner = useCallback(() => {
    burnerEngine.current?.dispose();
    burnerEngine.current = null;
    dispatch({ type: "burner:clear" });
    startBurnerEngine();
  }, [startBurnerEngine]);

  // ---- re-scan -----------------------------------------------------------

  const computeRescan = useCallback(async () => {
    const s = stateRef.current;
    const moveSim = s.moveSim;
    const plan = s.planApproval?.plan;
    if (!moveSim || !plan || moveSim.status !== "done") return;
    const key = rescanKey({
      planHash: plan.hash,
      moveFinishedAt: moveSim.finishedAt,
      burnerHash: s.burnerApproval?.plan.hash ?? null,
      burnerStatus: s.burnerSim?.status ?? null,
    });
    if (s.rescan.key === key && s.rescan.status === "done") return;
    const gen = ++rescanGen.current;
    dispatch({ type: "rescan:start", key });
    try {
      const built = await buildAfterProfile({
        profileId: s.profileId ?? plan.profileId,
        planHash: plan.hash,
        moveSim,
        burnerSim: s.burnerSim,
        burnerPlan: s.burnerApproval?.plan ?? null,
      });
      const report = await scanWallets(
        built.profile.wallets as WalletRef[],
        new FixtureReader(built.profile),
      );
      if (gen !== rescanGen.current) return;
      dispatch({
        type: "rescan:done",
        key,
        afterReport: report,
        afterProfile: built.profile,
        notes: built.notes,
        fundedChunks: built.fundedChunks,
        totalChunks: built.totalChunks,
        burnerIncluded: built.burnerIncluded,
        computedAt: new Date().toISOString(),
      });
    } catch (err) {
      if (gen !== rescanGen.current) return;
      dispatch({
        type: "rescan:error",
        key,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  // ---- reset -------------------------------------------------------------

  const resetFlow = useCallback(() => {
    scanGen.current += 1;
    rescanGen.current += 1;
    disposeEngines();
    dispatch({ type: "flow:reset" });
  }, [disposeEngines]);

  // Invalidate running sims when their approvals disappear.
  useEffect(() => {
    if (!state.planApproval && moveEngine.current) {
      moveEngine.current.cancel();
      moveEngine.current.dispose();
      moveEngine.current = null;
      dispatch({ type: "move:clear" });
    }
  }, [state.planApproval]);

  useEffect(() => {
    if (!state.burnerApproval && burnerEngine.current) {
      burnerEngine.current.cancel();
      burnerEngine.current.dispose();
      burnerEngine.current = null;
      dispatch({ type: "burner:clear" });
    }
  }, [state.burnerApproval]);

  const api = useMemo<FlowApi>(
    () => ({
      state,
      selectProfile,
      startSampleScan,
      retryScan,
      ensurePlanDraft,
      setPlanDraft,
      approvePlan,
      setMoveSettings,
      startMove,
      cancelMove,
      retryMove,
      restartMove,
      ensureBurnerDraft,
      setBurnerDraft,
      approveBurner,
      setBurnerSettings,
      startBurner,
      cancelBurner,
      retryBurner,
      restartBurner,
      computeRescan,
      resetFlow,
    }),
    [
      state,
      selectProfile,
      startSampleScan,
      retryScan,
      ensurePlanDraft,
      setPlanDraft,
      approvePlan,
      setMoveSettings,
      startMove,
      cancelMove,
      retryMove,
      restartMove,
      ensureBurnerDraft,
      setBurnerDraft,
      approveBurner,
      setBurnerSettings,
      startBurner,
      cancelBurner,
      retryBurner,
      restartBurner,
      computeRescan,
      resetFlow,
    ],
  );

  return <FlowContext.Provider value={api}>{children}</FlowContext.Provider>;
}
