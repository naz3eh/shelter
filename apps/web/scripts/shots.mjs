// One-off verification + screenshot pass for the web redesign.
// Run: cd apps/web && node scripts/shots.mjs  (dev server must be on :3000)
import { chromium } from "playwright";
import { AxeBuilder } from "@axe-core/playwright";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const OUT = new URL("../screenshots/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const SECTION_BY_HEADING = [
  ["03-dapps", "Dapps"],
  ["04-requests", "Requests"],
  ["05-graph", "Before and after"],
  ["06-funding", "Funding timeline"],
  ["07-verified", "Verified session"],
  ["08-linkage", "Try the linkage check"],
];

async function scrollToHeading(page, text) {
  await page.evaluate((t) => {
    const els = [...document.querySelectorAll("h2,h3")];
    const el = els.find((e) => e.textContent?.includes(t));
    el?.scrollIntoView({ block: "start" });
  }, text);
  await page.waitForTimeout(700);
}

async function run(prefix, width, height) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 2,
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await ctx.newPage();
  const apiCalls = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/attestation")) apiCalls.push(r.url());
  });
  await page.goto(BASE, { waitUntil: "networkidle" });
  // Wait for the verify panel to finish computing.
  await page.waitForFunction(
    () => document.body.innerText.includes("checks passed") || document.body.innerText.includes("Verification error"),
    { timeout: 30000 },
  );
  await page.waitForTimeout(1200);

  const results = { prefix, checks: {}, axe: {} };

  // --- axe, sheet closed ---
  const axeClosed = await new AxeBuilder({ page }).analyze();
  results.axe.closed = axeClosed.violations.filter((v) => ["serious", "critical"].includes(v.impact ?? ""));

  // --- Try it opens the blocked sheet ---
  await page.getByRole("button", { name: "Try it" }).first().click();
  await page.waitForSelector("text=Blocked by Shelter", { timeout: 5000 });
  results.checks.sheetOpens = true;
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${OUT}${prefix}-02-block-moment.png` });

  // --- axe, sheet open ---
  const axeOpen = await new AxeBuilder({ page }).analyze();
  results.axe.open = axeOpen.violations.filter((v) => ["serious", "critical"].includes(v.impact ?? ""));

  // --- copy button inside sheet works ---
  const copyBtn = page.getByRole("dialog").locator("button[aria-label^='Copy ']").first();
  if (await copyBtn.count()) {
    await copyBtn.click();
    await page.waitForTimeout(300);
    const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => ""));
    results.checks.copyWorks = clip.length > 0;
  }

  // close sheet via Escape
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);

  // --- section screenshots ---
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}${prefix}-01-landing.png` });
  for (const [file, heading] of SECTION_BY_HEADING) {
    await scrollToHeading(page, heading);
    await page.screenshot({ path: `${OUT}${prefix}-${file}.png` });
  }
  await page.screenshot({ path: `${OUT}${prefix}-full.png`, fullPage: true });

  // --- linkage examples ---
  await scrollToHeading(page, "Try the linkage check");
  await page.getByRole("button", { name: "Example: blocked Send" }).click();
  await page.getByRole("button", { name: "Run the check" }).click();
  await page.waitForSelector("text=calldata_linked", { timeout: 5000 });
  results.checks.blockedExample = await page.locator("text=Blocked by Shelter").count() > 0;

  await page.getByRole("button", { name: "Example: unlimited approval" }).click();
  await page.getByRole("button", { name: "Run the check" }).click();
  await page.waitForTimeout(800);
  results.checks.approvalExampleAllowed = await page.locator("text=Allowed").count() > 0;
  results.checks.approvalWarn = await page.locator("text=unlimited_approval").count() > 0;

  // --- TEE re-check hits the API ---
  apiCalls.length = 0;
  await scrollToHeading(page, "TEE attestation");
  await page.getByRole("button", { name: "Re-check" }).click();
  await page.waitForTimeout(2500);
  results.checks.teeApiCalled = apiCalls.length > 0;

  await browser.close();
  return results;
}

const desktop = await run("desktop", 1440, 900);
const mobile = await run("mobile", 390, 844);

console.log(JSON.stringify({ desktop, mobile }, null, 2));
