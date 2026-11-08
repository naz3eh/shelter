import { expect, type Page } from "@playwright/test";

/** Abort every request that isn't the local app — the demo must stay offline. */
export async function blockExternalRequests(page: Page) {
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (
      url.startsWith("http://localhost") ||
      url.startsWith("http://127.0.0.1") ||
      url.startsWith("data:") ||
      url.startsWith("blob:")
    ) {
      return route.continue();
    }
    return route.abort();
  });
}

/** Setup → scan for a sample. Leaves the page on /scan with the report done. */
export async function startSample(page: Page, sample = "exposed") {
  await page.goto("/");
  // The start button label follows the selected sample — pick the radio first.
  await page
    .getByRole("radio", { name: new RegExp(sample, "i") })
    .first()
    .click();
  await page.getByRole("button", { name: new RegExp(`Scan .*sample`, "i") }).click();
  await expect(page).toHaveURL(/\/scan/);
  await expect(page.getByText("/ 100")).toBeVisible({ timeout: 15_000 });
}

/** Scan → plan → approve → land on /move ready to start the simulation. */
export async function reachMovePage(page: Page, sample = "exposed") {
  await startSample(page, sample);
  await page.getByRole("link", { name: /review remediation plan/i }).click();
  await expect(page).toHaveURL(/\/plan/);
  await page.getByRole("button", { name: /approve simulation/i }).click();
  await expect(page.getByText(/simulation approved/i)).toBeVisible();
  await page.getByRole("link", { name: /open move tracker/i }).click();
  await expect(page).toHaveURL(/\/move/);
}

/** Full walk: move (brisk, happy) → burner (brisk, happy) → /rescan done. */
export async function walkFullFlow(page: Page, sample = "exposed") {
  await reachMovePage(page, sample);
  await page.getByLabel(/brisk/i).check();
  await page.getByRole("button", { name: /start simulation/i }).click();
  await expect(page.getByRole("link", { name: /continue to burner/i })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole("link", { name: /continue to burner/i }).click();
  await expect(page).toHaveURL(/\/burner/);
  await page.getByLabel(/brisk/i).check();
  await page.getByRole("button", { name: /approve simulation/i }).click();
  await page.getByRole("button", { name: /start burner lifecycle/i }).click();
  await expect(page.getByRole("link", { name: /continue to re-scan/i })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole("link", { name: /continue to re-scan/i }).click();
  await expect(page).toHaveURL(/\/rescan/);
  // After-scan computes quickly; wait for the second score tile.
  await expect(page.getByText(/After — new destination wallets/)).toBeVisible({
    timeout: 20_000,
  });
}
