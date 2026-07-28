// 계획의 일곱 핵심 journey와 keyboard/event/focus restore를 실제 제품 컴포넌트로
// 실행한다. 모든 backend 결과는 장면 strict router의 고정 fixture다.
import { expect, test } from "@playwright/test";
import { tabUntil } from "../contracts/keyboardContract";
import { openPreparedScene, openScene, readIpcLog } from "../support/openScene";
import { waitForVisualStability } from "../support/stability";

test("Explorer에서 table을 열고 실제 DataGrid로 이동한다", async ({ page }) => {
  await openScene(page, "table-data");
  await page
    .getByRole("button", {
      name: /^Analytics · postgres · db\.example\.invalid:5432 · analytics$/,
    })
    .click();
  await page.getByRole("button", { name: /^orders(?:\s|$)/ }).dblclick();
  await expect(page.getByRole("tab", { name: "orders" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("table")).toBeVisible();
  const log = await readIpcLog(page);
  expect(log.counts.propose_sql).toBe(2);
  expect(log.counts.run_sql).toBe(2);
});

test("SQL 문서를 실행해 bounded script 결과를 확인한다", async ({ page }) => {
  await openScene(page, "sql-terminal");
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.getByRole("table")).toHaveCount(2);
  await expect(page.getByText("8421942.55")).toBeVisible();
});

test("Terminal Dock focus, close, workbench focus restore", async ({ page }) => {
  await openPreparedScene(page, "terminal-open");
  await page.locator("[data-main-terminal-toggle]").click();
  await expect(page.locator(".terminal-dock")).toContainText("Analytics shell");
  await expect
    .poll(() =>
      page.evaluate(() =>
        Boolean(document.activeElement?.closest(".terminal-dock")),
      ),
    )
    .toBe(true);
  await page.getByRole("button", { name: "Close Terminal panel" }).click();
  await expect(page.locator(".terminal-dock")).toHaveCount(0);
  await expect(page.locator("[data-main-terminal-toggle]")).toBeFocused();
});

test("provider setup은 실패를 일반화하고 같은 action으로 재시도한다", async ({
  page,
}) => {
  await openPreparedScene(page, "provider-setup");
  const dialog = page.getByRole("dialog", { name: "Provider credentials" });
  const verify = dialog.getByRole("button", { name: "Verify local access" });
  await verify.click();
  await expect(
    dialog.getByText("The provider action could not be completed. Try again."),
  ).toBeVisible();
  await verify.click();
  await expect(
    dialog.getByText("This provider is ready on this device."),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: /Fixture Analyst · analyst@example\.invalid/,
    }),
  ).toBeFocused();
});

test("exact permission card는 scope를 보이고 durable operation을 거절한다", async ({
  page,
}) => {
  await openPreparedScene(page, "permission-review");
  const approval = page.locator("[data-approval-review]");
  await expect(
    approval.getByText("public.orders", { exact: true }),
  ).toBeVisible();
  await expect(
    approval.getByText(
      "fixture-payload-hash-fixture-operation-write-review",
    ),
  ).toBeVisible();
  await approval.getByRole("button", { name: "Reject" }).click();
  await expect(page.locator("[data-approval-review]")).toHaveCount(0);
  const log = await readIpcLog(page);
  const rejected = log.calls.find((call) => call.command === "reject_operation");
  expect(rejected?.payload).toEqual({
    operationId: "fixture-operation-write-review",
    payloadHash: "fixture-payload-hash-fixture-operation-write-review",
    reason: null,
  });
});

test("dashboard tile run, refresh, delete confirmation cancel", async ({ page }) => {
  await openPreparedScene(page, "dashboard");
  const first = page.locator("[data-dashboard-tile]").first();
  await first.getByRole("button", { name: "Refresh data" }).click();
  await expect
    .poll(async () => (await readIpcLog(page)).counts.run_dashboard)
    .toBe(2);
  await first.getByRole("button", { name: "Delete" }).click();
  await first.getByRole("button", { name: "No" }).click();
  expect((await readIpcLog(page)).names).not.toContain("delete_dashboard");
});

test("560px drawer는 main을 재배치하지 않고 선택 뒤 닫힌다", async ({ page }) => {
  await openScene(page, "table-data");
  await page.setViewportSize({ width: 540, height: 760 });
  await waitForVisualStability(page);
  const before = await page.locator("main.main").evaluate((node) => ({
    width: node.getBoundingClientRect().width,
    scrollTop: node.scrollTop,
  }));
  await page
    .getByRole("button", { name: "Workspace", exact: true })
    .click();
  await expect(page.locator(".app")).toHaveAttribute(
    "data-mobile-explorer-open",
    "true",
  );
  const whileOpen = await page.locator("main.main").evaluate((node) => ({
    width: node.getBoundingClientRect().width,
    scrollTop: node.scrollTop,
  }));
  expect(whileOpen).toEqual(before);
  await page
    .getByRole("button", {
      name: /^Analytics · postgres · db\.example\.invalid:5432 · analytics$/,
    })
    .click();
  await page.getByRole("button", { name: /^orders(?:\s|$)/ }).click();
  await expect(page.locator(".app")).toHaveAttribute(
    "data-mobile-explorer-open",
    "false",
  );
  await expect(page.getByRole("table")).toBeVisible();
  const after = await page.locator("main.main").evaluate((node) => ({
    width: node.getBoundingClientRect().width,
    scrollTop: node.scrollTop,
  }));
  expect(after.width).toBe(before.width);
});

test("drawer Esc와 Settings Esc는 trigger focus를 복원한다", async ({ page }) => {
  await openScene(page, "compact-shell");
  await page.setViewportSize({ width: 540, height: 760 });
  await page
    .getByRole("button", { name: "Workspace", exact: true })
    .click();
  await page.keyboard.press("Escape");
  await expect(page.locator(".app")).toHaveAttribute(
    "data-mobile-explorer-open",
    "false",
  );
  await expect(
    page.getByRole("button", { name: "Workspace", exact: true }),
  ).toBeFocused();

  await page.setViewportSize({ width: 900, height: 680 });
  await page
    .getByRole("navigation", { name: "Workbench navigation" })
    .getByRole("button", { name: "Settings" })
    .click();
  await expect(page.locator("[data-settings]")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-settings]")).toHaveCount(0);
});

test("Explorer와 Terminal divider는 drag 후 double-click으로 기본 폭을 복원한다", async ({
  page,
}) => {
  await openPreparedScene(page, "terminal-open");

  const explorer = page.locator("#workbench-sidebar");
  const sidebarResizer = page.locator(".sidebar-resizer");
  const explorerBefore = await explorer.evaluate(
    (node) => node.getBoundingClientRect().width,
  );
  const sidebarHandle = await sidebarResizer.boundingBox();
  if (!sidebarHandle) throw new Error("sidebar resize handle is not visible");
  await page.mouse.move(
    sidebarHandle.x + sidebarHandle.width / 2,
    sidebarHandle.y + 20,
  );
  await page.mouse.down();
  await page.mouse.move(sidebarHandle.x + 82, sidebarHandle.y + 20);
  await page.mouse.up();
  await expect
    .poll(() =>
      explorer.evaluate((node) => node.getBoundingClientRect().width),
    )
    .toBeGreaterThan(explorerBefore + 60);
  expect(
    Number(await page.evaluate(() => localStorage.getItem("sidebarW"))),
  ).toBeGreaterThan(300);
  await sidebarResizer.dblclick();
  await expect
    .poll(() =>
      explorer.evaluate((node) => node.getBoundingClientRect().width),
    )
    .toBe(304);

  const terminal = page.locator(".terminal-dock");
  const terminalResizer = page.locator(".terminal-dock-resizer");
  const terminalBefore = await terminal.evaluate(
    (node) => node.getBoundingClientRect().width,
  );
  const terminalHandle = await terminalResizer.boundingBox();
  if (!terminalHandle) throw new Error("terminal resize handle is not visible");
  await page.mouse.move(
    terminalHandle.x + terminalHandle.width / 2,
    terminalHandle.y + 120,
  );
  await page.mouse.down();
  await page.mouse.move(terminalHandle.x - 72, terminalHandle.y + 120);
  await page.mouse.up();
  await expect
    .poll(() =>
      terminal.evaluate((node) => node.getBoundingClientRect().width),
    )
    .toBeGreaterThan(terminalBefore + 50);
  await terminalResizer.dblclick();
  await expect
    .poll(() =>
      terminal.evaluate((node) => node.getBoundingClientRect().width),
    )
    .toBe(480);
});

test("좁은 table toolbar와 portal menu는 viewport 안에서 keyboard로 동작한다", async ({
  page,
}) => {
  await openPreparedScene(page, "table-data");
  await page.setViewportSize({ width: 900, height: 680 });
  await waitForVisualStability(page);

  const toolbar = page.getByRole("toolbar", { name: "Query and grid policy" });
  const scroll = toolbar.locator(".table-toolbar-scroll");
  await expect(toolbar).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    ),
  ).toBe(0);
  expect(await scroll.evaluate((node) => getComputedStyle(node).overflowX)).toBe(
    "auto",
  );

  const more = page.getByRole("button", { name: "More" });
  await more.focus();
  await page.keyboard.press("ArrowDown");
  const menu = page.getByRole("menu", { name: "More" });
  await expect(menu).toBeVisible();
  expect(await menu.evaluate((node) => node.parentElement === document.body)).toBe(
    true,
  );
  const menuBounds = await menu.boundingBox();
  if (!menuBounds) throw new Error("toolbar menu has no bounds");
  expect(menuBounds.x).toBeGreaterThanOrEqual(0);
  expect(menuBounds.y).toBeGreaterThanOrEqual(0);
  expect(menuBounds.x + menuBounds.width).toBeLessThanOrEqual(900);
  expect(menuBounds.y + menuBounds.height).toBeLessThanOrEqual(680);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(more).toBeFocused();
});

test("keyboard-only rail, activity event와 Terminal open 경로", async ({ page }) => {
  await openScene(page, "keyboard-only");
  await page.evaluate(async () => {
    await window.__uiHarness?.trigger("manual:operation-complete");
  });
  await expect(
    page.getByText("Agent operation completed - open Agent logs"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Activity" }).focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByText("No queries run against Analytics yet."),
  ).toBeVisible();

  await page.locator("body").focus();
  await tabUntil(page, /^Workspace$/);
  await expect(
    page.getByRole("button", { name: "Workspace", exact: true }),
  ).toBeFocused();
  expect(
    await page.getByRole("button", { name: "Workspace", exact: true }).evaluate(
      (node) => {
        const style = getComputedStyle(node);
        return style.outlineStyle !== "none" || style.boxShadow !== "none";
      },
    ),
  ).toBe(true);
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("button", { name: "Dashboards" })).toBeFocused();

  await page.locator("[data-main-terminal-toggle]").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".terminal-dock")).toBeVisible();
  const log = await readIpcLog(page);
  expect(log.events).toEqual([
    {
      trigger: "manual:operation-complete",
      event: "operation:changed",
      payload: expect.objectContaining({ command: "schema.list" }),
    },
  ]);
});
