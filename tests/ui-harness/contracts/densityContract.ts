// Pixel diff가 놓치는 overflow, header/body overlap, grid minimum space와 Terminal
// input bounds를 계산된 DOM geometry로 판정한다.
import type { Page } from "@playwright/test";

export interface DensityMeasurement {
  clippedInteractiveControls: number;
  headerBodyOverlaps: number;
  gridDataHeight: number | null;
  terminalBottomGap: number | null;
  resizeHandlesInsideViewport: boolean;
  longContentControlIntrusions: number;
}

export async function measureDensity(page: Page): Promise<DensityMeasurement> {
  return page.evaluate(() => {
    const visible = (node: HTMLElement) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const controls = [
      ...document.querySelectorAll<HTMLElement>(
        "button, input, select, textarea, [role='button'], [role='tab']",
      ),
    ].filter(visible);
    const clippedInteractiveControls = controls.filter(
      (node) =>
        node.scrollWidth > node.clientWidth + 1 &&
        getComputedStyle(node).textOverflow !== "ellipsis",
    ).length;

    const pairs = [
      [".main-head", ".workbench-document-strip"],
      [".workbench-document-strip", "[data-workbench-pane]"],
      ["[data-workbench-context]", "[data-workbench-toolbar]"],
      [".terminal-tabs-row", "[data-terminal-context-bar]"],
    ];
    const headerBodyOverlaps = pairs.filter(([headerSelector, bodySelector]) => {
      const header = document.querySelector<HTMLElement>(headerSelector);
      const body = document.querySelector<HTMLElement>(bodySelector);
      if (!header || !body || !visible(header) || !visible(body)) return false;
      const head = header.getBoundingClientRect();
      const next = body.getBoundingClientRect();
      return head.bottom > next.top + 1;
    }).length;

    const grid = document.querySelector<HTMLElement>(".grid-scroll");
    const terminal = document.querySelector<HTMLElement>(".terminal-dock");
    const terminalInput =
      terminal?.querySelector<HTMLElement>(".terminal-surface:not([hidden])") ??
      terminal?.querySelector<HTMLElement>(
        "[data-terminal-focus-target='launcher']",
      );
    const terminalBottomGap =
      terminal && terminalInput && visible(terminalInput)
        ? Math.round(
            terminal.getBoundingClientRect().bottom -
              terminalInput.getBoundingClientRect().bottom,
          )
        : null;

    const handles = [
      ...document.querySelectorAll<HTMLElement>(
        ".sidebar-resizer, .terminal-resizer",
      ),
    ].filter(visible);
    const resizeHandlesInsideViewport = handles.every((handle) => {
      const rect = handle.getBoundingClientRect();
      return (
        rect.left >= 0 &&
        rect.right <= window.innerWidth &&
        rect.top >= 0 &&
        rect.bottom <= window.innerHeight
      );
    });

    const longRows = [
      ...document.querySelectorAll<HTMLElement>(
        ".db-conn, .db-table, .workbench-document-tab",
      ),
    ].filter(visible);
    const longContentControlIntrusions = longRows.filter((row) => {
      const action = row.querySelector<HTMLElement>(
        "button:last-of-type, .db-menu",
      );
      const name = row.querySelector<HTMLElement>(
        ".db-conn-name, .tbl-name, .workbench-document-select span",
      );
      if (!action || !name || !visible(action) || !visible(name)) return false;
      const overlaps =
        name.getBoundingClientRect().right >
        action.getBoundingClientRect().left;
      if (!overlaps) return false;
      // Explorer의 DDL affordance는 의도적으로 row 위에 overlay된다. 이름이
      // ellipsis/clip 경계를 가지면 glyph는 control 아래로 그려지지 않는다.
      const style = getComputedStyle(name);
      const safelyClipped =
        ["hidden", "clip"].includes(style.overflowX) &&
        style.textOverflow === "ellipsis";
      return !safelyClipped;
    }).length;

    return {
      clippedInteractiveControls,
      headerBodyOverlaps,
      gridDataHeight: grid ? Math.round(grid.getBoundingClientRect().height) : null,
      terminalBottomGap,
      resizeHandlesInsideViewport,
      longContentControlIntrusions,
    };
  });
}
