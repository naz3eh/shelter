/**
 * One-off screenshot capture for the G8 sample flow — NOT part of the test
 * suite. Walks the real app in Chromium at desktop and mobile sizes and
 * saves PNGs under test-results/screenshots/.
 *
 * Usage: node e2e-shots.mjs   (dev server must be running on :3100)
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const BASE = "http://localhost:3100";
const OUT =
  process.env.SHOTS_OUT ??
  new URL("./test-results/screenshots/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  ["desktop", { width: 1440, height: 900 }],
  ["mobile", { width: 390, height: 844 }],
];

async function shot(page, name) {
  await page.screenshot({ path: `${OUT}${name}.png`, fullPage: true });
  console.log("saved", name);
}

async function blockExternal(page) {
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

for (const [label, viewport] of VIEWPORTS) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport });
  await blockExternal(page);

  // 1. / setup
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.getByRole("radio", { name: /exposed/i }).first().click();
  await page.waitForTimeout(500);
  await shot(page, `${label}-01-setup`);

  // 2. /scan — real engine over the exposed fixture
  await page.getByRole("button", { name: /scan .*sample/i }).click();
  await page.waitForURL("**/scan");
  await page.getByText("/ 100").waitFor({ timeout: 20000 });
  await page.waitForTimeout(800);
  await shot(page, `${label}-02-scan`);

  // 3. /plan — editable draft
  await page.getByRole("link", { name: /review remediation plan/i }).click();
  await page.waitForURL("**/plan");
  await page.waitForTimeout(600);
  await shot(page, `${label}-03-plan`);

  // approve -> /move
  await page.getByRole("button", { name: /approve simulation/i }).click();
  await page.getByText(/simulation approved/i).waitFor({ timeout: 10000 });
  await page.getByRole("link", { name: /open move tracker/i }).click();
  await page.waitForURL("**/move");
  await page.waitForTimeout(500);

  // 4. /move — brisk pace, capture mid-run then done
  await page.getByLabel(/brisk/i).check();
  await page.getByRole("button", { name: /start simulation/i }).click();
  await page.waitForTimeout(700);
  await shot(page, `${label}-04-move-running`);
  await page
    .getByRole("link", { name: /continue to burner/i })
    .waitFor({ timeout: 30000 });
  await page.waitForTimeout(400);
  await shot(page, `${label}-05-move-done`);

  // 5. /burner — approve + start, capture mid-run then retired
  await page.getByRole("link", { name: /continue to burner/i }).click();
  await page.waitForURL("**/burner");
  await page.getByLabel(/brisk/i).check();
  await page.waitForTimeout(400);
  await shot(page, `${label}-06-burner-plan`);
  await page.getByRole("button", { name: /approve simulation/i }).click();
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: /start burner lifecycle/i }).click();
  await page.waitForTimeout(700);
  await shot(page, `${label}-07-burner-running`);
  await page
    .getByRole("link", { name: /continue to re-scan/i })
    .waitFor({ timeout: 30000 });
  await page.waitForTimeout(400);
  await shot(page, `${label}-08-burner-done`);

  // 6. /rescan — after-report computed by the same engine
  await page.getByRole("link", { name: /continue to re-scan/i }).click();
  await page.waitForURL("**/rescan");
  await page
    .getByText(/After — new destination wallets/)
    .waitFor({ timeout: 20000 });
  await page.waitForTimeout(800);
  await shot(page, `${label}-09-rescan`);

  await browser.close();
}
console.log("done ->", OUT);
