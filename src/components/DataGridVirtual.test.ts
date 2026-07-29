import { describe, expect, it } from "vitest";
import {
  gridExpressionIssue,
} from "../lib/sqlBuild";
import { virtualGridWindow } from "./DataGridVirtual";
import {
  extendGridSelection,
  gridSelectionClipboardText,
  gridSelectionIncludes,
  singleGridCell,
} from "./dataGridSelection";
import {
  DATA_GRID_DEFAULT_COLUMN_WIDTH,
  DATA_GRID_ROW_HEIGHT,
  DATA_GRID_ROW_NUMBER_WIDTH,
} from "../design-system/dataGridGeometry";

const offsets = Array.from(
  { length: 51 },
  (_, index) =>
    DATA_GRID_ROW_NUMBER_WIDTH + index * DATA_GRID_DEFAULT_COLUMN_WIDTH,
);

describe("DataGridVirtual window", () => {
  it("keeps a 50k by 50 grid bounded at a 360px viewport", () => {
    const window = virtualGridWindow(50_000, 50, offsets, {
      top: 20_000 * DATA_GRID_ROW_HEIGHT,
      left: 2_000,
      width: 360,
      height: 240,
    });
    const cellCount =
      (window.endRow - window.startRow) * window.visibleColumns.length;
    expect(window.startRow).toBeGreaterThan(0);
    expect(window.endRow).toBeLessThan(50_000);
    expect(window.visibleColumns.length).toBeLessThan(15);
    expect(cellCount).toBeLessThan(400);
  });

  it("keeps boundary coordinates and rectangular selection deterministic", () => {
    expect(
      virtualGridWindow(1_000, 50, offsets, {
        top: 0,
        left: 0,
        width: 360,
        height: 240,
      }).startRow,
    ).toBe(0);
    const final = virtualGridWindow(1_000, 50, offsets, {
      top: 999 * DATA_GRID_ROW_HEIGHT,
      left: 8_000,
      width: 360,
      height: 240,
    });
    expect(final.endRow).toBe(1_000);
    expect(final.visibleColumns[final.visibleColumns.length - 1]).toBe(49);

    const selection = extendGridSelection(singleGridCell(0, 1), 1, 2);
    expect(gridSelectionIncludes(selection, 0, 1)).toBe(true);
    expect(gridSelectionIncludes(selection, 1, 2)).toBe(true);
    expect(gridSelectionIncludes(selection, 0, 0)).toBe(false);
    expect(
      gridSelectionClipboardText(
        selection,
        (row) => [
          ["a", "b", "c"],
          ["d", "e", "f"],
        ][row],
        String,
      ),
    ).toBe("b\tc\ne\tf");

    expect(gridExpressionIssue("where", "city = 'Berlin'")).toBeNull();
    expect(gridExpressionIssue("orderBy", "city DESC, id ASC")).toBeNull();
    expect(gridExpressionIssue("where", "1 = 1; DELETE FROM users")).toBe(
      "statementBoundary",
    );
    expect(gridExpressionIssue("where", "1 = 1 -- swallow LIMIT")).toBe(
      "statementBoundary",
    );
    expect(gridExpressionIssue("orderBy", "city DESC LIMIT 5000")).toBe(
      "clauseBoundary",
    );
  });
});
