import { describe, expect, it } from "vitest";
import {
  buildPageQuery,
  gridExpressionIssue,
} from "../lib/sqlBuild";
import type { CatalogTable } from "../ipc/types";
import { shouldVirtualizeDataGrid } from "./DataGrid";
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
import type { SqlStreamRowSource } from "../features/queries/domain";
import { createFrameCoalescer } from "../lib/frameCoalescer";
import {
  clearSqlResultPageCache,
  SQL_RESULT_CACHE_MAX_PAGES,
  retainSqlStreamBatch,
  sqlResultRowAt,
  subscribeSqlResultPages,
} from "../features/queries/resultPageCache";

const offsets = Array.from(
  { length: 51 },
  (_, index) =>
    DATA_GRID_ROW_NUMBER_WIDTH + index * DATA_GRID_DEFAULT_COLUMN_WIDTH,
);

describe("DataGridVirtual window", () => {
  it("keeps a 1m by 50 grid bounded at a 360px viewport", () => {
    const window = virtualGridWindow(1_000_000, 50, offsets, {
      top: 500_000 * DATA_GRID_ROW_HEIGHT,
      left: 2_000,
      width: 360,
      height: 240,
    });
    const cellCount =
      (window.endRow - window.startRow) * window.visibleColumns.length;
    expect(window.startRow).toBeGreaterThan(0);
    expect(window.endRow).toBeLessThan(1_000_000);
    expect(window.visibleColumns.length).toBeLessThan(15);
    expect(cellCount).toBeLessThan(400);

    const scheduled: { frame: FrameRequestCallback | null } = { frame: null };
    let frameRequests = 0;
    const commits: number[] = [];
    const coalescer = createFrameCoalescer<number>(
      (value) => commits.push(value),
      (callback) => {
        frameRequests += 1;
        scheduled.frame = callback;
        return frameRequests;
      },
      () => {
        scheduled.frame = null;
      },
    );
    coalescer.push(1);
    coalescer.push(2);
    coalescer.push(3);
    expect(frameRequests).toBe(1);
    expect(commits).toEqual([]);
    expect(scheduled.frame).not.toBeNull();
    scheduled.frame?.(16);
    expect(commits).toEqual([3]);
    coalescer.push(4);
    coalescer.flush();
    expect(commits).toEqual([3, 4]);
  });

  it("keeps boundary coordinates and rectangular selection deterministic", () => {
    expect(
      shouldVirtualizeDataGrid({
        columns: Array.from({ length: 19 }, (_, index) => `column_${index}`),
        rows: [[1]],
        rowCount: 1,
        truncated: false,
        durationMs: 1,
      }),
    ).toBe(true);
    const table = {
      database: null,
      schema: "public",
      name: "events",
      columns: [{ name: "unindexed_value", pk: false }],
    } as CatalogTable;
    expect(
      buildPageQuery("postgres", table, {
        filters: {},
        sort: null,
        limit: 101,
        offset: 0,
      }),
    ).toBe('SELECT * FROM "public"."events" LIMIT 101 OFFSET 0');
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

    const capability = "a".repeat(64);
    const source: SqlStreamRowSource = {
      operationId: "00000000-0000-0000-0000-000000000123",
      capability,
      pageRows: 256,
      rowCount: 1_000_000,
      complete: true,
    };
    for (let sequence = 0; sequence <= SQL_RESULT_CACHE_MAX_PAGES; sequence += 1) {
      retainSqlStreamBatch(source, {
        operationId: source.operationId!,
        resultCapability: capability,
        sequence,
        columns: ["id"],
        rows: Array.from({ length: 256 }, (_, row) => [sequence * 256 + row]),
      });
    }
    expect(sqlResultRowAt(source, 0)).toBeUndefined();
    expect(sqlResultRowAt(source, SQL_RESULT_CACHE_MAX_PAGES * 256)).toEqual([
      SQL_RESULT_CACHE_MAX_PAGES * 256,
    ]);

    clearSqlResultPageCache();
    retainSqlStreamBatch(source, {
      operationId: source.operationId!,
      resultCapability: capability,
      sequence: 0,
      columns: ["id"],
      rows: [[0]],
    });
    let evictionNotifications = 0;
    const unsubscribe = subscribeSqlResultPages(source, () => {
      evictionNotifications += 1;
    });
    for (let index = 0; index < 4; index += 1) {
      const other = {
        ...source,
        operationId: `00000000-0000-0000-0000-${String(index + 200).padStart(12, "0")}`,
        capability: String(index + 1).repeat(64),
      };
      retainSqlStreamBatch(other, {
        operationId: other.operationId,
        resultCapability: other.capability,
        sequence: 0,
        columns: ["id"],
        rows: [[index]],
      });
    }
    expect(sqlResultRowAt(source, 0)).toBeUndefined();
    expect(evictionNotifications).toBe(1);
    unsubscribe();
    clearSqlResultPageCache();
  });
});
