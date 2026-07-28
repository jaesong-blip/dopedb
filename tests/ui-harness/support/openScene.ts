// 장면을 열고 준비 완료를 기다리는 유일한 경로. 고정 sleep을 쓰지 않고
// [data-ui-harness-ready="true"] marker만 기다린다.
import { expect, type Page } from "@playwright/test";
import { getScenario } from "../scenarios";
import {
  HARNESS_VIEWPORTS,
  type UiHarnessSceneId,
  type UiHarnessScenario,
} from "../scenarios/types";
import { prepareScene } from "./prepareScene";
import { waitForVisualStability } from "./stability";

export interface OpenedScene {
  scenario: UiHarnessScenario;
  /** 장면 실행 중 발생한 콘솔 오류와 미처리 예외. */
  pageErrors: string[];
  consoleErrors: string[];
  externalRequests: string[];
}

export async function openScene(
  page: Page,
  id: UiHarnessSceneId,
): Promise<OpenedScene> {
  const scenario = getScenario(id);
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const externalRequests: string[] = [];

  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.origin !== "http://127.0.0.1:4179"
    ) {
      externalRequests.push(request.url());
    }
  });

  // Project defaults are repeated here because a caller may reuse these helpers
  // from a focused config. The observable media contract must not depend on that.
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.setViewportSize(HARNESS_VIEWPORTS[scenario.viewport]);
  await page.goto(`/tests/ui-harness/app/?scene=${id}`);
  await expect(page.locator("html")).toHaveAttribute(
    "data-ui-harness-ready",
    "true",
    { timeout: 20_000 },
  );
  await waitForVisualStability(page);

  return { scenario, pageErrors, consoleErrors, externalRequests };
}

export async function openPreparedScene(
  page: Page,
  id: UiHarnessSceneId,
): Promise<OpenedScene> {
  const opened = await openScene(page, id);
  await prepareScene(page, id);
  await waitForVisualStability(page);
  return opened;
}

/** strict router가 거부한 command와 실제 호출된 command 집합을 읽는다. */
export async function readIpcLog(page: Page): Promise<{
  names: string[];
  counts: Record<string, number>;
  unhandled: string[];
  calls: { command: string; payload: unknown }[];
  events: { trigger: string; event: string; payload: unknown }[];
}> {
  return page.evaluate(() => {
    const bridge = window.__uiHarness;
    if (!bridge) throw new Error("[ui-harness] runtime bridge is missing");
    return {
      names: bridge.names(),
      counts: bridge.counts(),
      unhandled: bridge.unhandled(),
      calls: bridge.calls(),
      events: bridge.events(),
    };
  });
}
