// 실제 App을 렌더하는 UI 검수 하네스 설정. 일상 CI에는 포함하지 않고
// UI를 집중 검수하거나 baseline을 승인할 때 명시적으로 실행한다.
//
// spec 파일은 `*.harness.ts`로 둔다. `*.spec.ts`/`*.test.ts`는
// scripts/check-critical-test-budget.mjs가 critical 단위 테스트로 집계하므로
// 하네스가 그 예산을 잠식하지 않게 이름을 분리한다.
import { defineConfig, devices } from "@playwright/test";

const PORT = 4179;

export default defineConfig({
  testDir: "./tests/ui-harness",
  testMatch: "specs/*.harness.ts",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  outputDir: "output/playwright/test-results",
  reporter: [
    ["line"],
    ["html", { outputFolder: "output/playwright/report", open: "never" }],
  ],
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
    baseURL: `http://127.0.0.1:${PORT}`,
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
      use: { browserName: "chromium", viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: {
    command: `pnpm vite --host 127.0.0.1 --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}/tests/ui-harness/app/`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
