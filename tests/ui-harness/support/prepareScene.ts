// URL state만으로 만들 수 없는 장면을 실제 accessible action으로 준비한다.
// 시나리오 데이터에는 selector를 넣지 않고, 제품 interaction은 이 support 경계가 소유한다.
import { expect, type Page } from "@playwright/test";
import type { UiHarnessSceneId } from "../scenarios/types";
import { waitForVisualStability } from "./stability";

async function openTable(page: Page, name: string) {
  const target = page.getByRole("button", {
    name: new RegExp(`^(?:public\\.|audit\\.)?${name}(?:\\s|$)`),
  });
  if ((await target.count()) === 0) {
    await page
      .getByRole("button", {
        name: /^Analytics · postgres · db\.example\.invalid:5432 · analytics$/,
      })
      .click();
    await expect(target).toBeVisible();
  }
  await target.click();
  await waitForVisualStability(page);
}

export async function prepareScene(
  page: Page,
  scene: UiHarnessSceneId,
): Promise<void> {
  if (scene === "table-data") {
    await openTable(page, "orders");
    await expect(page.getByRole("table")).toBeVisible();
  } else if (scene === "empty-results") {
    await openTable(page, "orders");
    await expect(page.getByText("Table is empty.")).toBeVisible();
  } else if (scene === "long-content") {
    await openTable(page, "audit\\.audit_log_with_a_deliberately_long_table_name");
    await expect(page.getByRole("table")).toBeVisible();
  } else if (scene === "sql-terminal" || scene === "permission-review") {
    await page.getByRole("button", { name: "Run", exact: true }).click();
    await waitForVisualStability(page);
    if (scene === "permission-review") {
      await expect(page.getByRole("button", { name: "Reject" })).toBeVisible();
    } else {
      await expect(page.getByRole("table")).toHaveCount(2);
    }
  } else if (scene === "schema-erd") {
    await page.getByRole("button", { name: "Load schema details" }).click();
    await expect(page.locator("[data-erd-canvas]")).toBeVisible();
    await expect(page.locator(".react-flow__node")).toHaveCount(5);
    await expect(page.locator(".react-flow__edge")).toHaveCount(1);
    await waitForVisualStability(page);
  } else if (scene === "dashboard") {
    await page
      .locator("[data-dashboard-tile]")
      .first()
      .getByRole("button", {
        name: "Click a dashboard to run its query with current data.",
      })
      .click();
    await expect(
      page.locator("[data-dashboard-visualization]").first(),
    ).toBeVisible();
    await waitForVisualStability(page);
  } else if (scene === "settings") {
    await page
      .getByRole("navigation", { name: "Workbench navigation" })
      .getByRole("button", { name: "Settings" })
      .click();
    await expect(page.getByRole("heading", { name: "Agent tools" })).toBeVisible();
    await waitForVisualStability(page);
  } else if (scene === "provider-setup") {
    await page
      .getByRole("button", { name: /Fixture Analyst · analyst@example\.invalid/ })
      .click();
    await page.getByRole("menuitem", { name: "Provider credentials" }).click();
    const dialog = page.getByRole("dialog", { name: "Provider credentials" });
    await expect(dialog).toBeVisible();
    await dialog
      .getByRole("button", { name: /Cloud SQL fixture project/ })
      .click();
    await waitForVisualStability(page);
  }
}
