// 모든 Tier 0–2 장면의 strict IPC, 구조·접근성·pixel 계약을 실제 App DOM에서
// 분리해 판정한다. 실패 evidence는 Playwright output에 JSON attachment로 남긴다.
import { expect, test, type TestInfo } from "@playwright/test";
import {
  measureAccessibility,
} from "../contracts/accessibilityContract";
import { measureDensity } from "../contracts/densityContract";
import {
  ALLOWED_CONTROL_HEIGHTS,
  MAX_VISUAL_DEPTH,
  measureShell,
} from "../contracts/shellContract";
import { scenarioIds } from "../scenarios";
import {
  openPreparedScene,
  readIpcLog,
} from "../support/openScene";

async function attachJson(
  testInfo: TestInfo,
  name: string,
  value: unknown,
) {
  await testInfo.attach(name, {
    body: `${JSON.stringify(value, null, 2)}\n`,
    contentType: "application/json",
  });
}

for (const scene of scenarioIds) {
  test(`${scene} — strict IPC 계약`, async ({ page }, testInfo) => {
    const opened = await openPreparedScene(page, scene);
    const log = await readIpcLog(page);
    await attachJson(testInfo, "ipc-calls.json", log);

    expect(log.unhandled, "등록되지 않은 Tauri command가 호출됐다").toEqual([]);
    expect(log.names).toEqual([...opened.scenario.expected.commands]);
    for (const [command, count] of Object.entries(
      opened.scenario.expected.commandCounts ?? {},
    )) {
      expect(log.counts[command], `${command} 호출 횟수`).toBe(count);
    }
    expect(opened.pageErrors).toEqual([]);
    expect(opened.consoleErrors).toEqual([]);
    expect(opened.externalRequests, "실제 network/database 접근").toEqual([]);
  });

  test(`${scene} — 구조·밀도 계약`, async ({ page }, testInfo) => {
    const { scenario } = await openPreparedScene(page, scene);
    const shell = await measureShell(page);
    const density = await measureDensity(page);
    await attachJson(testInfo, "measurements.json", { shell, density });

    expect(shell.documentOverflowX, "가로 overflow").toBe(0);
    expect(shell.documentOverflowY, "세로 overflow").toBe(0);

    const rail = shell.regions.find((region) => region.name === "rail");
    const explorer = shell.regions.find((region) => region.name === "explorer");
    const main = shell.regions.find((region) => region.name === "main");
    const terminal = shell.regions.find((region) => region.name === "terminal");
    expect(rail?.visible, "rail이 보인다").toBe(true);
    expect(explorer?.visible, "explorer가 보인다").toBe(true);
    expect(main?.visible, "main이 보인다").toBe(true);
    expect(main?.bounds.width ?? 0).toBeGreaterThanOrEqual(
      scenario.expected.layout.minimumMainWidth,
    );
    expect(terminal?.visible ?? false).toBe(
      scenario.expected.layout.terminalVisible,
    );

    expect(shell.railToExplorerGap, "rail과 explorer 경계가 붙어 있다").toBe(0);
    expect(shell.mainMinWidth, "main은 min-width: 0을 유지한다").toBe("0px");
    expect(
      shell.controlHeights.filter(
        (height) => !ALLOWED_CONTROL_HEIGHTS.includes(height),
      ),
      "허용되지 않은 control 높이",
    ).toEqual([]);
    expect(shell.unnamedIconControls, "접근 가능한 이름이 없는 버튼").toBe(0);
    expect(shell.maxVisualDepth).toBeLessThanOrEqual(MAX_VISUAL_DEPTH);
    expect(density.headerBodyOverlaps, "header와 body overlap").toBe(0);
    expect(density.resizeHandlesInsideViewport).toBe(true);
    if (density.gridDataHeight !== null) {
      expect(density.gridDataHeight, "grid data 최소 높이").toBeGreaterThan(48);
    }
    if (scene === "long-content") {
      expect(density.longContentControlIntrusions).toBe(0);
    }
    if (density.terminalBottomGap !== null) {
      expect(density.terminalBottomGap).toBeGreaterThanOrEqual(0);
      expect(density.terminalBottomGap).toBeLessThan(180);
    }
  });

  test(`${scene} — 접근성 계약`, async ({ page }, testInfo) => {
    const { scenario } = await openPreparedScene(page, scene);
    const accessibility = await measureAccessibility(page);
    await attachJson(testInfo, "accessibility.json", accessibility);

    expect(accessibility.landmarks).toContain("nav");
    expect(accessibility.landmarks).toContain("main");
    expect(accessibility.unnamedButtons).toBe(0);
    expect(accessibility.unlabeledFields).toBe(0);
    expect(accessibility.headingOrderSkips).toBe(0);
    expect(accessibility.focusableInsideInert).toBe(0);
    expect(accessibility.reducedMotion).toBe(true);

    for (const expected of scenario.expected.visibleRoles) {
      const locator = page.getByRole(expected.role, {
        name: expected.name,
        exact: expected.name !== undefined,
      });
      if (expected.count !== undefined) {
        await expect(locator).toHaveCount(expected.count);
      } else {
        await expect(locator.first()).toBeVisible();
      }
    }
  });

  test(`${scene} — 픽셀 회귀`, async ({ page }, testInfo) => {
    await openPreparedScene(page, scene);
    await attachJson(testInfo, "measurements.json", {
      shell: await measureShell(page),
      density: await measureDensity(page),
      accessibility: await measureAccessibility(page),
    });
    await attachJson(testInfo, "ipc-calls.json", await readIpcLog(page));
    await expect(page).toHaveScreenshot(`${scene}.png`);
  });
}
