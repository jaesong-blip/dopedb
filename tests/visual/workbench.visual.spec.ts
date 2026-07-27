// 고정된 가상 데이터로 핵심 워크벤치 화면의 픽셀과 구조 계약을 함께 검증한다.
// 실제 계정, 연결 문자열, 자격 증명은 fixture에 주입하지 않는다.
import { expect, test, type Page } from "@playwright/test";

const desktopScenes = [
  "connections",
  "sql-terminal",
  "table-detail",
  "schema-erd",
  "dashboard",
  "settings-auth",
  "loading-error",
] as const;

async function openScene(page: Page, scene: (typeof desktopScenes)[number]) {
  await page.goto(`/tests/visual/fixture/?scene=${scene}`);
  await expect(page.locator(".visual-app")).toHaveAttribute("data-scene", scene);
  await page.evaluate(() => document.fonts.ready);
}

async function expectLayoutContract(page: Page) {
  const layout = await page.evaluate(() => {
    const app = document.querySelector<HTMLElement>(".visual-app");
    const rail = document.querySelector<HTMLElement>(".vf-rail");
    const sidebar = document.querySelector<HTMLElement>(".vf-sidebar");
    const topbar = document.querySelector<HTMLElement>(".vf-topbar");
    const depth = [...document.querySelectorAll<HTMLElement>("[data-depth]")]
      .map((node) => Number(node.dataset.depth));
    const safeAreas = [...document.querySelectorAll<HTMLElement>("[data-window-safe]")]
      .map((node) => node.getBoundingClientRect().height);
    const compactControls = [...document.querySelectorAll<HTMLElement>("[data-control]")]
      .filter((node) => !node.closest(".vf-tabs"))
      .map((node) => node.getBoundingClientRect().height);
    const tabControls = [...document.querySelectorAll<HTMLElement>(".vf-tabs [data-control]")]
      .map((node) => node.getBoundingClientRect().height);

    if (!app || !rail || !sidebar || !topbar) {
      throw new Error("visual fixture shell is incomplete");
    }

    const appRect = app.getBoundingClientRect();
    const railRect = rail.getBoundingClientRect();
    const sidebarRect = sidebar.getBoundingClientRect();
    const topbarRect = topbar.getBoundingClientRect();
    return {
      appFitsViewport:
        app.scrollWidth <= app.clientWidth &&
        app.scrollHeight <= app.clientHeight &&
        appRect.right <= window.innerWidth &&
        appRect.bottom <= window.innerHeight,
      compactControls,
      maxDepth: Math.max(...depth),
      railAndSidebarAligned:
        railRect.top === sidebarRect.top &&
        railRect.bottom === sidebarRect.bottom &&
        railRect.right === sidebarRect.left,
      safeAreas,
      tabControls,
      topbarHeight: topbarRect.height,
    };
  });

  expect(layout.appFitsViewport).toBe(true);
  expect(layout.maxDepth).toBeLessThanOrEqual(3);
  expect(layout.railAndSidebarAligned).toBe(true);
  expect(layout.safeAreas).toEqual([44, 44]);
  expect(layout.compactControls.every((height) => height === 28)).toBe(true);
  expect(layout.tabControls.every((height) => height === 35)).toBe(true);
  expect(layout.topbarHeight).toBe(44);
}

for (const scene of desktopScenes) {
  test(`${scene} desktop`, async ({ page }) => {
    await openScene(page, scene);
    await expectLayoutContract(page);
    await expect(page.locator(".visual-app")).toHaveScreenshot(`${scene}.png`);
  });
}

test("compact viewport keeps long names and panels bounded", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 680 });
  await openScene(page, "table-detail");
  await expectLayoutContract(page);

  const detailPanel = page.locator(".vf-detail-panel");
  await expect(detailPanel).toBeVisible();
  const detailBounds = await detailPanel.boundingBox();
  expect(detailBounds).not.toBeNull();
  expect(detailBounds!.x + detailBounds!.width).toBeLessThanOrEqual(900);

  await expect(page.locator(".visual-app")).toHaveScreenshot(
    "compact-long-names.png",
  );
});
