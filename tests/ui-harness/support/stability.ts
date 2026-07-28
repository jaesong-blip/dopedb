// 고정 sleep 대신 router pending, busy marker와 연속 layout signature를 사용해
// lazy editor, chart, ERD와 resize가 모두 정착한 뒤 screenshot을 허용한다.
import type { Page } from "@playwright/test";

export async function waitForVisualStability(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const maxFrames = 360;
    const stableTarget = 6;
    let stableFrames = 0;
    let previous = "";

    const nextFrame = () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const signature = () => {
      const selectors = [
        ".app",
        ".sidebar",
        ".main",
        ".terminal-dock",
        ".grid-scroll",
        "[data-erd-canvas]",
        ".react-flow__viewport",
        ".react-flow__node",
        "[data-dashboard-grid]",
        "[role='dialog']",
      ];
      return selectors
        .flatMap((selector) =>
          [...document.querySelectorAll<HTMLElement>(selector)].map((node) => {
            const rect = node.getBoundingClientRect();
            const style = getComputedStyle(node);
            return [
              selector,
              rect.x,
              rect.y,
              rect.width,
              rect.height,
              node.scrollWidth,
              node.scrollHeight,
              style.transform,
              style.opacity,
            ].join(":");
          }),
        )
        .join("|");
    };

    for (let frame = 0; frame < maxFrames; frame += 1) {
      await nextFrame();
      const pending = window.__uiHarness?.pending() ?? 0;
      const busy =
        document.querySelector(
          ".skeleton, .terminal-surface-status, [aria-busy='true'], .react-flow__node.dragging",
        ) !== null;
      const current = signature();
      stableFrames =
        pending === 0 && !busy && current === previous
          ? stableFrames + 1
          : 0;
      previous = current;
      if (stableFrames >= stableTarget) return;
    }
    throw new Error("[ui-harness] scene did not reach visual stability");
  });
}
