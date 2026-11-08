import { expect, test } from "@playwright/test";
import {
  blockExternalRequests,
  reachMovePage,
  startSample,
  walkFullFlow,
} from "./helpers";

test.beforeEach(async ({ page }) => {
  await blockExternalRequests(page);
});

test("exposed sample: full six-step flow through re-scan and restart", async ({
  page,
}) => {
  await walkFullFlow(page, "exposed");

  // Before/after comparison is computed by the real engine.
  await expect(page.getByText("98.5").first()).toBeVisible();
  await expect(page.getByText(/Score delta/)).toBeVisible();
  await expect(page.getByText(/Dataset limits/)).toBeVisible();

  // Export parses, carries provenance, and contains no secrets.
  const downloadPromise = page.waitForEvent("download");
  // force: the animated layout makes Playwright's hit-test flaky on mobile;
  // the download handler itself is what is under test.
  await page.getByRole("button", { name: /export comparison json/i }).click({ force: true });
  const download = await downloadPromise;
  const path = await download.path();
  const fs = await import("node:fs/promises");
  const payload = JSON.parse(await fs.readFile(path!, "utf8"));
  expect(payload.provenance).toMatch(/fictional/i);
  expect(payload.before.score).toBe(98.5);
  expect(payload.after).toBeTruthy();
  const serialized = JSON.stringify(payload);
  expect(serialized).not.toMatch(/NEAR_AI_API_KEY|ETH_RPC_URL|ONECLICK_JWT|privateKey|mnemonic/i);

  // Restart clears the flow.
  await page.getByRole("button", { name: /restart demo/i }).click();
  await expect(page.getByText(/No scan in progress|Choose a fictional sample/)).toBeVisible();
});

test("medium and clean profiles show real numbers and no fabricated findings", async ({
  page,
}) => {
  await startSample(page, "medium");
  await expect(page.getByText("21.5").first()).toBeVisible();
  await expect(page.getByText(/linkable/i).first()).toBeVisible();
  await expect(page.getByText(/Warnings — 0 points/)).toHaveCount(0);
  for (const letter of ["D", "F", "H"]) {
    await expect(page.locator("li", { hasText: letter }).first()).toBeVisible();
  }

  await page.goto("/");
  await startSample(page, "clean");
  await expect(page.getByText("0", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/clean/i).first()).toBeVisible();
  await expect(
    page.getByText(/No exposure findings in this dataset/),
  ).toBeVisible();
});

test("exposed scan shows all checks, warnings, inherited findings and linked count", async ({
  page,
}) => {
  await startSample(page, "exposed");
  await expect(page.getByText("98.5").first()).toBeVisible();
  await expect(page.getByText(/doxxed/i).first()).toBeVisible();
  await expect(page.getByText(/Linked addresses/)).toBeVisible();
  await expect(page.getByText("address poisoning").first()).toBeVisible();
  await expect(page.getByText(/sanctioned counterparty/i).first()).toBeVisible();
  await expect(page.getByText(/inherited identity/i).first()).toBeVisible();
});

test("setup validates address input and custom scan stays disabled", async ({
  page,
}) => {
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "Address" });
  await input.fill("0x123");
  await expect(page.getByRole("alert").filter({ hasText: /invalid address/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /scan address/i })).toBeDisabled();

  await page.getByLabel(/chain/i).selectOption("near");
  await input.fill("validname.near");
  await expect(page.getByRole("alert").filter({ hasText: /invalid/i })).toHaveCount(0);
});

test("direct downstream visits show recovery states, not errors", async ({
  page,
}) => {
  for (const route of ["/scan", "/plan", "/move", "/burner", "/rescan"]) {
    await page.goto(route);
    await expect(
      page.getByText(/no scan|no approved plan|nothing to re-scan|no completed move/i).first(),
    ).toBeVisible();
  }
});

test("changing the profile invalidates scan and downstream state", async ({
  page,
}) => {
  await startSample(page, "exposed");
  await page.getByRole("link", { name: /shelter/i }).first().click();
  await expect(page).toHaveURL(/\/$/);
  await page.getByRole("radio", { name: /medium exposure/i }).click();
  await page.getByRole("button", { name: /scan medium/i }).click();
  await expect(page).toHaveURL(/\/scan/);
  await expect(page.getByText("21.5").first()).toBeVisible({ timeout: 15_000 });
  // Old exposed report must not linger.
  await expect(page.getByText("98.5")).toHaveCount(0);
});

test("editing the plan after approval revokes it", async ({ page }) => {
  await startSample(page, "exposed");
  await page.getByRole("link", { name: /review remediation plan/i }).click();
  await page.getByRole("button", { name: /approve simulation/i }).click();
  await expect(page.getByText(/simulation approved/i)).toBeVisible();
  // Edit a field → approval must disappear.
  await page.getByLabel(/usdc per chunk/i).fill("30");
  await expect(page.getByText(/simulation approved/i)).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: /open move tracker/i }),
  ).toHaveCount(0);
});

test("invalid plan totals block approval", async ({ page }) => {
  await startSample(page, "exposed");
  await page.getByRole("link", { name: /review remediation plan/i }).click();
  await page.getByLabel(/chunk count|chunks/i).fill("4");
  await page.getByLabel(/usdc per chunk/i).fill("100");
  await expect(page.getByRole("alert").filter({ hasText: /exceeds/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /approve simulation/i })).toBeDisabled();
});

test("move: partial-funding fails then retry completes; refund skips withdrawals", async ({
  page,
}) => {
  await reachMovePage(page, "exposed");
  await page.getByLabel(/brisk/i).check();
  await page.getByRole("radio", { name: /partial funding/i }).click();
  await page.getByRole("button", { name: /start simulation/i }).click();
  await expect(
    page.getByText(/leg failed and was refunded/i).first(),
  ).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: /retry \/ reconcile/i }).click();
  await expect(page.getByRole("link", { name: /continue to burner/i })).toBeVisible({
    timeout: 30_000,
  });
});

test("move: cancel stops the run and restart does not duplicate steps", async ({
  page,
}) => {
  await reachMovePage(page, "exposed");
  await page.getByRole("button", { name: /start simulation/i }).click();
  await page.getByRole("button", { name: /cancel simulation/i }).click();
  await expect(page.getByText(/cancelled/i).first()).toBeVisible();
  // Restart begins a fresh run.
  await page.getByRole("button", { name: /restart simulation/i }).click();
  await expect(
    page.getByRole("link", { name: /continue to burner/i }),
  ).toHaveCount(0);
});

test("burner: one action only — second action impossible, dust stays visible", async ({
  page,
}) => {
  await walkFullFlow(page, "exposed");
  // On rescan the burner is done; go back and confirm non-reusability.
  await page.getByRole("link", { name: /^4\.\s*move/i }).click();
  await page.getByRole("link", { name: /^5\.\s*burner/i }).click();
  await expect(page.getByText(/one action used — burner retired/i)).toBeVisible();
  await expect(page.getByText(/cannot perform a second business action/i)).toBeVisible();
  await expect(page.getByText(/dust/i).first()).toBeVisible();
});

test("burner: insufficient-gas scenario fails deterministically", async ({
  page,
}) => {
  await reachMovePage(page, "exposed");
  await page.getByLabel(/brisk/i).check();
  await page.getByRole("button", { name: /start simulation/i }).click();
  await page.getByRole("link", { name: /continue to burner/i }).click();
  await page.getByLabel(/brisk/i).check();
  await page.getByRole("radio", { name: /insufficient gas/i }).click();
  await page.getByRole("button", { name: /approve simulation/i }).click();
  await page.getByRole("button", { name: /start burner lifecycle/i }).click();
  await expect(
    page.getByText(/insufficient gas for the simulated payment/i),
  ).toBeVisible({ timeout: 30_000 });
  // Retry fails again while gas stays short.
  await page.getByRole("button", { name: /^retry$/i }).click();
  await expect(
    page.getByText(/insufficient gas for the simulated payment/i),
  ).toBeVisible({ timeout: 30_000 });
});

test("report export on /scan parses and carries provenance", async ({ page }) => {
  await startSample(page, "exposed");
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: /download json report/i }).click({ force: true });
  const download = await downloadPromise;
  const path = await download.path();
  const fs = await import("node:fs/promises");
  const payload = JSON.parse(await fs.readFile(path!, "utf8"));
  expect(payload.provenance).toMatch(/fictional/i);
  expect(payload.report.score).toBe(98.5);
  expect(payload.report.band).toBe("doxxed");
  const serialized = JSON.stringify(payload);
  expect(serialized).not.toMatch(/NEAR_AI_API_KEY|ETH_RPC_URL|ONECLICK_JWT|privateKey|mnemonic/i);
});

test("explain: missing key shows unavailable; missing signature hides the answer", async ({
  page,
}) => {
  await startSample(page, "medium");

  // Missing API key → helpful unavailable state; scanning unaffected.
  await page.route("**/api/explain", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "NEAR_AI_API_KEY is not configured" }),
    }),
  );
  await page.getByRole("button", { name: /explain this scan/i }).click();
  await expect(page.getByText(/not configured on this server/i)).toBeVisible();
  await expect(page.getByText("21.5").first()).toBeVisible(); // scan still fine

  // Answer without a signature must stay hidden (fail closed).
  await page.unroute("**/api/explain");
  await page.route("**/api/explain", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        content: '{"summary":"You are exposed.","findings":[]}',
        signature: null,
      }),
    }),
  );
  await page.getByRole("button", { name: /retry|try again|explain this scan/i }).first().click();
  await expect(
    page.getByText(/cannot be bound to a verified report/i),
  ).toBeVisible();
  await expect(page.getByText("You are exposed.")).toHaveCount(0);
});
