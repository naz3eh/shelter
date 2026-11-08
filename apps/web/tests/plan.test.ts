import { describe, expect, it } from "vitest";
import {
  approvalPreview,
  buildApprovedPlan,
  DEFAULT_PLAN_DRAFT,
  ethBudgetFromProfile,
  validatePlanDraft,
  type PlanContext,
} from "@/lib/flow/plan";
import { SAMPLE_PROFILES } from "@/lib/flow/profiles";
import { decimalToBase, ETH_DECIMALS, USDC_DECIMALS } from "@/lib/flow/money";

const ctx: PlanContext = {
  profileId: "exposed",
  ethBudgetWei: 10n ** 18n, // 1 ETH budget for tests
};

describe("validatePlanDraft", () => {
  it("accepts the default draft", () => {
    const v = validatePlanDraft(DEFAULT_PLAN_DRAFT, ctx);
    expect(v.ok).toBe(true);
    expect(v.errors).toHaveLength(0);
    expect(v.warnings.length).toBeGreaterThan(0);
  });

  it("rejects bad chunk counts", () => {
    for (const chunkCount of ["0", "5", "1.5", "abc", "-1"]) {
      const v = validatePlanDraft({ ...DEFAULT_PLAN_DRAFT, chunkCount }, ctx);
      expect(v.ok, `chunkCount=${chunkCount}`).toBe(false);
    }
  });

  it("rejects negative and over-precise amounts", () => {
    expect(
      validatePlanDraft({ ...DEFAULT_PLAN_DRAFT, usdcPerChunk: "-5" }, ctx).ok,
    ).toBe(false);
    expect(
      validatePlanDraft({ ...DEFAULT_PLAN_DRAFT, usdcPerChunk: "1.0000001" }, ctx).ok,
    ).toBe(false);
    expect(
      validatePlanDraft({ ...DEFAULT_PLAN_DRAFT, ethPerChunk: "abc" }, ctx).ok,
    ).toBe(false);
  });

  it("rejects totals over the simulated budgets", () => {
    // 4 chunks × 100 USDC = 400 > 250 simulated budget
    const v = validatePlanDraft(
      { ...DEFAULT_PLAN_DRAFT, chunkCount: "4", usdcPerChunk: "100" },
      ctx,
    );
    expect(v.ok).toBe(false);
    expect(v.errors.join(" ")).toMatch(/exceeds the simulated balance/);
  });

  it("rejects ETH totals over the recorded fixture budget", () => {
    const v = validatePlanDraft(
      { ...DEFAULT_PLAN_DRAFT, ethPerChunk: "1" }, // 2 chunks × 1 ETH > 1 ETH budget
      ctx,
    );
    expect(v.ok).toBe(false);
    expect(v.errors.join(" ")).toMatch(/exceeds the recorded fixture balance/);
  });

  it("rejects a plan that moves nothing", () => {
    const v = validatePlanDraft(
      { ...DEFAULT_PLAN_DRAFT, usdcPerChunk: "0", ethPerChunk: "0" },
      ctx,
    );
    expect(v.ok).toBe(false);
    expect(v.errors.join(" ")).toMatch(/moves nothing/);
  });
});

describe("buildApprovedPlan", () => {
  it("builds an immutable snapshot with derived fictional addresses", async () => {
    const r = await buildApprovedPlan(DEFAULT_PLAN_DRAFT, ctx);
    expect("plan" in r).toBe(true);
    if (!("plan" in r)) return;
    const p = r.plan;
    expect(p.chunks).toHaveLength(2);
    expect(p.totals.usdc).toBe("50");
    expect(p.hash).toMatch(/^[0-9a-f]{16}$/);
    for (const c of p.chunks) {
      expect(c.destination).toMatch(/^0x[0-9a-f]{40}$/);
      expect(c.depositAddress).toMatch(/^0x[0-9a-f]{40}$/);
      expect(decimalToBase(c.usdc, USDC_DECIMALS)).toBe(25_000_000n);
    }
  });

  it("a changed draft produces a different plan hash and destinations", async () => {
    const a = await buildApprovedPlan(DEFAULT_PLAN_DRAFT, ctx);
    const b = await buildApprovedPlan(
      { ...DEFAULT_PLAN_DRAFT, usdcPerChunk: "30" },
      ctx,
    );
    expect("plan" in a && "plan" in b).toBe(true);
    if (!("plan" in a && "plan" in b)) return;
    expect(a.plan.hash).not.toBe(b.plan.hash);
    expect(a.plan.chunks[0]!.destination).not.toBe(b.plan.chunks[0]!.destination);
  });

  it("refuses to build an invalid plan", async () => {
    const r = await buildApprovedPlan(
      { ...DEFAULT_PLAN_DRAFT, chunkCount: "9" },
      ctx,
    );
    expect("errors" in r).toBe(true);
  });
});

describe("approvalPreview", () => {
  it("lists open approvals recorded in the fixture", () => {
    const rows = approvalPreview(SAMPLE_PROFILES.exposed.profile);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.owner).toMatch(/^0x/);
      expect(r.spender).toMatch(/^0x/);
      expect(r.txHash.length).toBeGreaterThan(0);
    }
  });
});

describe("ethBudgetFromProfile", () => {
  it("sums recorded native balances only", () => {
    const budget = ethBudgetFromProfile(SAMPLE_PROFILES.exposed.profile);
    expect(budget).toBeGreaterThan(0n);
    const clean = ethBudgetFromProfile(SAMPLE_PROFILES.clean.profile);
    expect(clean).toBeGreaterThanOrEqual(0n);
  });
});
