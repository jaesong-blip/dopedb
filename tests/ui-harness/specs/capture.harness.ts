import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { measureAccessibility } from "../contracts/accessibilityContract";
import { measureDensity } from "../contracts/densityContract";
import { measureShell } from "../contracts/shellContract";
import { HARNESS_VIEWPORTS, type UiHarnessSceneId } from "../scenarios/types";
import { openPreparedScene, readIpcLog } from "../support/openScene";
import { waitForVisualStability } from "../support/stability";

const requestedScene = process.env.UI_HARNESS_CAPTURE_SCENE as
  | UiHarnessSceneId
  | undefined;

test.skip(!requestedScene, "capture는 ui:harness:capture에서만 실행한다");

test("명시한 actual과 clean-room clone을 캡처한다", async ({
  page,
  context,
}) => {
  const destination = process.env.UI_HARNESS_CAPTURE_DIR;
  const run = process.env.UI_HARNESS_CAPTURE_RUN;
  if (!requestedScene || !destination || !run) {
    throw new Error("capture environment is incomplete");
  }
  mkdirSync(destination, { recursive: true });

  const { scenario } = await openPreparedScene(page, requestedScene);
  await page.screenshot({
    path: path.join(destination, "actual.png"),
    animations: "disabled",
    caret: "hide",
  });
  const measurements = {
    shell: await measureShell(page),
    density: await measureDensity(page),
    accessibility: await measureAccessibility(page),
  };
  writeFileSync(
    path.join(destination, "measurements.json"),
    `${JSON.stringify(measurements, null, 2)}\n`,
  );
  writeFileSync(
    path.join(destination, "ipc-calls.json"),
    `${JSON.stringify(await readIpcLog(page), null, 2)}\n`,
  );

  const clonePage = await context.newPage();
  await clonePage.setViewportSize(HARNESS_VIEWPORTS[scenario.viewport]);
  await clonePage.goto(
    `/tests/ui-benchmark/clone/?scene=${scenario.benchmark.referenceCloneScene}`,
  );
  await expect(clonePage.locator("html")).toHaveAttribute(
    "data-reference-clone-ready",
    "true",
  );
  await waitForVisualStability(clonePage);
  await clonePage.screenshot({
    path: path.join(destination, "reference-clone.png"),
    animations: "disabled",
    caret: "hide",
  });
  await clonePage.close();

  writeFileSync(
    path.join(destination, "capture-metadata.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        run,
        scene: requestedScene,
        viewport: scenario.viewport,
        viewportSize: HARNESS_VIEWPORTS[scenario.viewport],
        referenceId: scenario.benchmark.referenceId,
        referenceCloneScene: scenario.benchmark.referenceCloneScene,
      },
      null,
      2,
    )}\n`,
  );
});
