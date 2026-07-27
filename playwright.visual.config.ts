import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/visual",
  testMatch: "*.visual.spec.ts",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI
    ? [["line"], ["html", { outputFolder: "playwright-report", open: "never" }]]
    : "line",
  snapshotPathTemplate:
    "{testDir}/__screenshots__/{projectName}/{testFileName}/{arg}{ext}",
  expect: {
    toHaveScreenshot: {
      animations: "disabled",
      caret: "hide",
      maxDiffPixelRatio: 0.004,
      threshold: 0.2,
    },
  },
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:4178",
    colorScheme: "dark",
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    reducedMotion: "reduce",
    serviceWorkers: "block",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium-macos",
      use: {
        browserName: "chromium",
        viewport: { width: 1440, height: 900 },
      },
    },
  ],
  webServer: {
    command: "pnpm vite --host 127.0.0.1 --port 4178",
    url: "http://127.0.0.1:4178/tests/visual/fixture/",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
