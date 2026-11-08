import { defineConfig, devices } from "@playwright/test";

/**
 * E2E for the G8 sample-data flow. Runs fully offline: the app is started
 * locally and every non-localhost request is aborted, so the demo can never
 * regress into a network-dependent flow.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3100",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "mobile", use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
  webServer: {
    command: "pnpm dev -p 3100",
    url: "http://localhost:3100",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      // Deliberately no NEAR_AI_API_KEY etc. — sample flow must work without .env.
      NEXT_TELEMETRY_DISABLED: "1",
    },
  },
});
