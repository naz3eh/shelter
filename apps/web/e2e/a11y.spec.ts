import { expect, test } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import {
  blockExternalRequests,
  reachMovePage,
  startSample,
} from "./helpers";

const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

/** Wait for in-flight animations (e.g. badge label swaps) to finish so axe
 *  measures settled colors, not mid-transition opacity. */
async function settleAnimations(page: import("@playwright/test").Page) {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
}

async function expectNoSeriousViolations(page: import("@playwright/test").Page, label: string) {
  await settleAnimations(page);
  const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  const blocking = results.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
  const minor = results.violations.filter(
    (v) => v.impact !== "serious" && v.impact !== "critical",
  );
  if (minor.length) {
    // eslint-disable-next-line no-console
    console.log(
      `[a11y:${label}] minor/moderate:`,
      minor.map((v) => `${v.id}(${v.impact})`).join(", "),
    );
  }
  expect(
    blocking,
    `${label}: ${blocking.map((v) => `${v.id}(${v.impact})`).join(", ")}`,
  ).toHaveLength(0);
}

test.beforeEach(async ({ page }) => {
  await blockExternalRequests(page);
});

test("axe: no serious/critical violations across all six routes", async ({
  page,
}) => {
  // 1. Setup
  await page.goto("/");
  await expectNoSeriousViolations(page, "/");

  // 2. Scan
  await startSample(page, "exposed");
  await expectNoSeriousViolations(page, "/scan");

  // 3. Plan
  await page.getByRole("link", { name: /review remediation plan/i }).click();
  await expect(page).toHaveURL(/\/plan/);
  await expectNoSeriousViolations(page, "/plan");

  // 4. Move — axe on the approved pre-start state, then run brisk to done.
  await page.getByRole("button", { name: /approve simulation/i }).click();
  await page.getByRole("link", { name: /open move tracker/i }).click();
  await page.getByLabel(/brisk/i).check();
  await expectNoSeriousViolations(page, "/move ready");
  await page.getByRole("button", { name: /start simulation/i }).click();
  await expect(
    page.getByRole("link", { name: /continue to burner/i }),
  ).toBeVisible({ timeout: 30_000 });
  await expectNoSeriousViolations(page, "/move done");

  // 5. Burner (pre-start)
  await page.getByRole("link", { name: /continue to burner/i }).click();
  await page.getByLabel(/brisk/i).check();
  await page.getByRole("button", { name: /approve simulation/i }).click();
  await expectNoSeriousViolations(page, "/burner approved");
  await page.getByRole("button", { name: /start burner lifecycle/i }).click();
  await expect(
    page.getByRole("link", { name: /continue to re-scan/i }),
  ).toBeVisible({ timeout: 30_000 });
  await expectNoSeriousViolations(page, "/burner done");

  // 6. Re-scan
  await page.getByRole("link", { name: /continue to re-scan/i }).click();
  await expect(
    page.getByText(/After — new destination wallets/),
  ).toBeVisible({ timeout: 20_000 });
  await expectNoSeriousViolations(page, "/rescan");
});

test("keyboard: setup is fully operable without a pointer", async ({ page }) => {
  await page.goto("/");
  // Tab to the sample radios and start button; activate with keyboard.
  await page.getByRole("radio", { name: /medium exposure/i }).focus();
  await page.keyboard.press("Enter");
  const start = page.getByRole("button", { name: /scan medium/i });
  await start.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/scan/);
  await expect(page.getByText("21.5").first()).toBeVisible({ timeout: 15_000 });
});

test("reduced motion: flow still completes and states stay readable", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await reachMovePage(page, "exposed");
  await page.getByLabel(/brisk/i).check();
  await page.getByRole("button", { name: /start simulation/i }).click();
  await expect(page.getByRole("link", { name: /continue to burner/i })).toBeVisible({
    timeout: 30_000,
  });
  // Status text must be present without relying on animation.
  await expect(page.getByText(/completed|finished/i).first()).toBeVisible();
});
