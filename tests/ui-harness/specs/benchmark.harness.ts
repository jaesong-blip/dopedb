// 장면과 DopeDB reference의 연결 계약.
// Vite가 TS와 JSON을 함께 해석하므로 취약한 TS 파싱 없이 정확히 대조한다.
// scripts/ui-harness/validate.mjs는 JSON 자산만 보므로 이 연결은 여기서 판정한다.
import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { referenceMetrics } from "../../ui-benchmark/clone/metrics";
import {
  referenceCloneSceneIds,
  type ReferenceCloneSceneId,
} from "../../ui-benchmark/clone/scenes";
import { scenarioIds, scenarios } from "../scenarios";

const manifest = JSON.parse(
  readFileSync(
    new URL("../../ui-benchmark/manifest.json", import.meta.url),
    "utf8",
  ),
) as {
  references: Array<{
    id: string;
    distribution: "private-reference" | "repository-audit";
    file?: string;
  }>;
};
const referenceIds = new Set(manifest.references.map((reference) => reference.id));

test("등록된 모든 장면은 reference와 rubric을 가진다", () => {
  expect(scenarioIds.length).toBeGreaterThan(0);

  for (const scenario of scenarios.values()) {
    expect(
      referenceIds.has(scenario.benchmark.referenceId),
      `장면 "${scenario.id}"의 referenceId가 manifest에 없다: ${scenario.benchmark.referenceId}`,
    ).toBe(true);

    expect(
      scenario.benchmark.rubric.length,
      `장면 "${scenario.id}"에 rubric 항목이 없다`,
    ).toBeGreaterThan(0);

    expect(
      scenario.expected.commands.length,
      `장면 "${scenario.id}"에 기대 command allowlist가 없다`,
    ).toBeGreaterThan(0);
  }
});

test("장면 수가 줄어들면 명시적으로 기록해야 한다", () => {
  // 축소는 사고로 일어나기 쉬우므로 이 숫자를 낮출 때 이유를 커밋 메시지에 남긴다.
  const registeredSceneFloor = 15;
  expect(scenarioIds.length).toBeGreaterThanOrEqual(registeredSceneFloor);
});

for (const cloneScene of referenceCloneSceneIds) {
  test(`clean-room clone — ${cloneScene}`, async ({ page }) => {
    const externalRequests: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.origin !== "http://127.0.0.1:4179") {
        externalRequests.push(request.url());
      }
    });

    await page.goto(`/tests/ui-benchmark/clone/?scene=${cloneScene}`);
    await expect(page.locator("html")).toHaveAttribute(
      "data-reference-clone-ready",
      "true",
    );
    await expect(page.locator("[data-region='rail']")).toBeVisible();
    await expect(page.locator("[data-region='explorer']")).toBeVisible();
    await expect(page.locator("[data-region='workbench']")).toBeVisible();
    await expect(page.locator("[data-region='status']")).toBeVisible();
    if (cloneScene === "assistant-open") {
      await expect(page.locator("[data-region='assistant']")).toBeVisible();
    }

    const visibleText = await page.locator("body").innerText();
    expect(visibleText).not.toMatch(/\b(?:DopeDB|DopeDB|DopeDB)\b/i);
    expect(externalRequests).toEqual([]);

    const metrics = referenceMetrics[cloneScene as ReferenceCloneSceneId];
    expect(Object.keys(metrics).length).toBeGreaterThan(0);
    for (const metric of Object.values(metrics)) {
      expect(Number.isFinite(metric.value)).toBe(true);
      expect(metric.source).toMatch(/^observations\/.+\.md#/);
      expect(metric.meaning.length).toBeGreaterThan(12);
    }
  });
}

test("private reference 원본 없이 actual/clone 계약은 계속 실행된다", () => {
  const privateReferences = manifest.references.filter(
    (reference) => reference.distribution === "private-reference",
  );
  expect(privateReferences.length).toBeGreaterThan(0);
  for (const reference of privateReferences) {
    expect(reference.file).toBeUndefined();
    expect(referenceIds.has(reference.id)).toBe(true);
  }
});
