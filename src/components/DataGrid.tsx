// Shared results table. Renders whatever rows it's handed (callers window/cap first).
// Sticky header + row numbers + null styling. All interactivity is opt-in via callbacks
// so the plain read-only callers (SQL, document, and dashboard results) render unchanged:
//   - onSort     → clickable headers that cycle asc/desc/none (arrow on the sorted col)
//   - onFilter   → DopeDB-style value/count popup from a header filter action
//   - onSelectRow/onCellClick → row highlight + click-to-open a cell in the side viewer
//   - startIndex → row numbers continue across pages (rows 101-200, not 1-100 again)
// Columns are drag-resizable: first drag snapshots every column's rendered width and
// flips the table to fixed layout so only the dragged column moves. Double-click a
// handle to reset all widths (back to auto layout). Widths reset per column set.
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import type { QueryResult } from "../ipc/types";
import type { GridSort } from "../lib/sqlBuild";
import type { SqlStreamRowSource } from "../features/queries/domain";
import { Icon } from "./Icon";
import DataGridColumnFilterMenu from "./DataGridColumnFilterMenu";
import DataGridVirtual from "./DataGridVirtual";
import { useI18n } from "../lib/i18n";
import {
  extendGridSelection,
  gridSelectionClipboardText,
  gridSelectionIncludes,
  singleGridCell,
  type GridCellSelection,
} from "./dataGridSelection";

function cell(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

// Clipboard text for a selected cell — same rules as CellViewer's Copy:
// null/undefined → "NULL", objects → pretty JSON, JSON-string → pretty JSON, else String.
function copyText(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "object") return JSON.stringify(v, null, 2);
  const s = String(v);
  if (typeof v === "string") {
    try {
      const p = JSON.parse(s);
      if (p && typeof p === "object") return JSON.stringify(p, null, 2);
    } catch {
      /* not JSON — plain text */
    }
  }
  return s;
}

type DataGridProps = {
  result: QueryResult;
  startIndex?: number;
  sort?: GridSort | null;
  onSort?: (col: string) => void;
  filters?: Record<string, string>;
  onFilter?: (col: string, value: string) => void;
  selectedRow?: number | null;
  onSelectRow?: (i: number) => void;
  onCellClick?: (value: unknown, rowIndex: number, col: string) => void;
  columnMeta?: Record<string, { dataType: string; pk: boolean }>;
  /** A chunked streaming source; rows are never flattened for the grid. */
  rowSource?: SqlStreamRowSource;
  /** Flush workbench grids fill their pane without a card border or radius. */
  surface?: "panel" | "workbench";
};

export default function DataGrid(props: DataGridProps) {
  // This wrapper must stay O(columns). In particular, do not add table-only
  // scans here: virtual results may carry 50k × 50 rows.
  const shouldVirtualize =
    !!props.rowSource ||
    props.result.rows.length > 200 ||
    props.result.columns.length > 18;
  if (shouldVirtualize && !props.onFilter) {
    return (
      <DataGridVirtual
        result={props.result}
        startIndex={props.startIndex ?? 0}
        sort={props.sort}
        onSort={props.onSort}
        selectedRow={props.selectedRow}
        onSelectRow={props.onSelectRow}
        onCellClick={props.onCellClick}
        columnMeta={props.columnMeta}
        rowSource={props.rowSource}
        surface={props.surface}
      />
    );
  }
  return <DataGridTable {...props} />;
}

function DataGridTable({
  result,
  startIndex = 0,
  sort,
  onSort,
  filters,
  onFilter,
  selectedRow,
  onSelectRow,
  onCellClick,
  columnMeta,
  rowSource: _rowSource,
  surface,
}: DataGridProps) {
  const { t } = useI18n();
  const interactive = !!onSelectRow || !!onCellClick;
  // Column widths keyed by header-cell index (0 = rownum). Empty map = auto layout.
  const [widths, setWidths] = useState<Record<number, number>>({});
  // Selected cell (click to select, ⌘C to copy, Esc to clear). Independent of onCellClick.
  const [sel, setSel] = useState<GridCellSelection | null>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const sig = result.columns.join(" ");
  useEffect(() => {
    setWidths({}); // new column set → stale widths dropped
  }, [sig]);
  useEffect(() => {
    // Sort/filter/pagination swap the rows without changing columns — a selection is
    // coordinates into rows, so any new result object invalidates it.
    setSel(null);
  }, [result]);
  const fixed = Object.keys(widths).length > 0;
  const totalW = fixed
    ? Object.values(widths).reduce((a, b) => a + b, 0)
    : undefined;

  // Right-align numeric columns. NUMERIC/MONEY arrive as plain decimal strings (the
  // Rust side serializes them lossless), so detect by value shape — and per column,
  // not per cell, so a text column with the odd digit-only value can't render ragged.
  const numericCols = useMemo(() => {
    const numRe = /^-?\d+(\.\d+)?$/;
    return result.columns.map(
      (_, j) =>
        result.rows.some((r) => r[j] != null) &&
        result.rows.every((r) => {
          const v = r[j];
          return (
            v == null ||
            typeof v === "number" ||
            (typeof v === "string" && numRe.test(v))
          );
        }),
    );
  }, [result]);

  function startResize(
    e: { preventDefault(): void; stopPropagation(): void; clientX: number },
    colIdx: number,
  ) {
    e.preventDefault();
    e.stopPropagation(); // don't trigger the sort click on the header
    const table = tableRef.current;
    if (!table) return;
    const ths = Array.from(
      table.querySelectorAll<HTMLTableCellElement>("thead tr:first-child th"),
    );
    const snap: Record<number, number> = { ...widths };
    ths.forEach((th, i) => {
      if (snap[i] == null) snap[i] = th.offsetWidth;
    });
    const startX = e.clientX;
    const startW = snap[colIdx];
    // Coalesce mousemoves to one setWidths per frame — reconciling the whole tbody
    // on every pointer event churns badly on large result sets.
    let raf = 0;
    let pendingW = startW;
    const flush = () => {
      raf = 0;
      setWidths({ ...snap, [colIdx]: pendingW });
    };
    const move = (ev: MouseEvent) => {
      pendingW = Math.min(1200, Math.max(50, startW + ev.clientX - startX));
      if (!raf) raf = requestAnimationFrame(flush);
    };
    const up = () => {
      if (raf) cancelAnimationFrame(raf);
      flush(); // commit the final position (a queued frame may not have run)
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  }

  // Click and Enter (see below) both land here so keyboard nav opens the same viewer a click does.
  function selectCell(i: number, j: number, extend: boolean) {
    if (extend && sel) {
      setSel(extendGridSelection(sel, i, j));
      return;
    }
    setSel(singleGridCell(i, j));
    onSelectRow?.(i);
    onCellClick?.(result.rows[i]?.[j], i, result.columns[j]);
  }

  // ⌘C/Ctrl+C copies the selected cell — but yield to a real text selection so users
  // can still copy dragged-over text normally. Esc clears the cell selection. Arrow keys
  // roving-select a cell (mirrors App.tsx's tab-bar pattern: move sel, then focus the td —
  // valid even at tabIndex=-1, only Tab-order membership depends on that). Enter opens it.
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape" && sel) {
      setSel(null);
      return;
    }
    if ((e.metaKey || e.ctrlKey) && (e.key === "c" || e.key === "C") && sel) {
      if ((window.getSelection()?.toString() ?? "") !== "") return; // real selection wins
      e.preventDefault();
      void navigator.clipboard.writeText(
        gridSelectionClipboardText(
          sel,
          (row) => result.rows[row],
          cell,
          copyText,
        ),
      );
      return;
    }
    if (
      (e.key === "ArrowUp" ||
        e.key === "ArrowDown" ||
        e.key === "ArrowLeft" ||
        e.key === "ArrowRight") &&
      result.rows.length > 0
    ) {
      e.preventDefault();
      const cur = sel?.focus ?? { row: 0, col: 0 };
      const row =
        !sel
          ? 0
          : e.key === "ArrowUp"
          ? Math.max(0, cur.row - 1)
          : e.key === "ArrowDown"
            ? Math.min(result.rows.length - 1, cur.row + 1)
            : cur.row;
      const col =
        e.key === "ArrowLeft"
          ? Math.max(0, cur.col - 1)
          : e.key === "ArrowRight"
            ? Math.min(result.columns.length - 1, cur.col + 1)
            : cur.col;
      setSel(
        e.shiftKey && sel
          ? extendGridSelection(sel, row, col)
          : singleGridCell(row, col),
      );
      tableRef.current
        ?.querySelector<HTMLTableCellElement>(
          `tbody tr:nth-child(${row + 1}) td:nth-child(${col + 2})`,
        )
        ?.focus();
      return;
    }
    if (e.key === "Enter" && sel) {
      selectCell(sel.focus.row, sel.focus.col, false);
    }
  }

  return (
    <div
      data-data-grid-scroll
      className="tw:max-h-[60vh] tw:overflow-auto tw:rounded-lg tw:border tw:border-border-subtle tw:bg-background tw:shadow-panel tw:[&::-webkit-scrollbar]:size-[11px] tw:[&::-webkit-scrollbar-corner]:bg-transparent tw:[&::-webkit-scrollbar-thumb]:rounded-full tw:[&::-webkit-scrollbar-thumb]:border-[var(--ds-border-width-bold)] tw:[&::-webkit-scrollbar-thumb]:border-transparent tw:[&::-webkit-scrollbar-thumb]:bg-muted-foreground tw:[&::-webkit-scrollbar-thumb]:bg-clip-padding tw:[&::-webkit-scrollbar-thumb:hover]:bg-foreground tw:[&::-webkit-scrollbar-track]:bg-transparent tw:data-[surface=workbench]:min-h-0 tw:data-[surface=workbench]:flex-1 tw:data-[surface=workbench]:rounded-none tw:data-[surface=workbench]:border-0 tw:data-[surface=workbench]:shadow-none"
      data-surface={surface ?? "panel"}
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      <table
        ref={tableRef}
        className={`tw:w-full tw:border-separate tw:border-spacing-0 tw:bg-background tw:text-ui tw:[&_td]:box-border tw:[&_td]:border-r tw:[&_td]:border-b tw:[&_td]:border-border-subtle tw:[&_td]:px-2 tw:[&_td]:py-1 tw:[&_td]:leading-ui tw:[&_td]:text-left tw:[&_td]:whitespace-nowrap tw:[&_th]:box-border tw:[&_th]:border-r tw:[&_th]:border-b tw:[&_th]:border-border-subtle tw:[&_th]:px-2 tw:[&_th]:py-1 tw:[&_th]:leading-ui tw:[&_th]:text-left tw:[&_th]:whitespace-nowrap tw:[&_thead_th]:sticky tw:[&_thead_th]:top-0 tw:[&_thead_th]:z-[var(--ds-z-raised)] tw:[&_thead_th]:h-control-md tw:[&_thead_th]:bg-card${fixed ? " tw:table-fixed tw:[&_td]:max-w-none tw:[&_td]:overflow-hidden tw:[&_td]:text-ellipsis tw:[&_th]:max-w-none tw:[&_th]:overflow-hidden tw:[&_th]:text-ellipsis" : ""}`}
        style={fixed ? { tableLayout: "fixed", width: totalW } : undefined}
      >
        {fixed && (
          <colgroup>
            <col style={{ width: widths[0] }} />
            {result.columns.map((_, j) => (
              <col key={j} style={{ width: widths[j + 1] }} />
            ))}
          </colgroup>
        )}
        <thead>
          <tr>
            <th className="tw:left-0 tw:z-[calc(var(--ds-z-raised)+1)] tw:text-right tw:text-muted-foreground">
              #
            </th>
            {result.columns.map((c, j) => (
              <th
                key={c}
                aria-sort={
                  onSort
                    ? sort?.col === c
                      ? sort.dir === "asc"
                        ? "ascending"
                        : "descending"
                      : "none"
                    : undefined
                }
              >
                <span className="tw:flex tw:min-w-0 tw:items-center tw:gap-1">
                  {onSort ? (
                    <button
                      type="button"
                      className="tw:inline-flex tw:h-control-md tw:min-w-0 tw:flex-1 tw:cursor-pointer tw:items-center tw:gap-1 tw:overflow-hidden tw:border-0 tw:bg-transparent tw:p-0 tw:font-sans tw:text-left tw:text-ui tw:font-semibold tw:text-inherit tw:hover:text-primary tw:focus-visible:outline-none tw:focus-visible:ring-2 tw:focus-visible:ring-ring"
                      title={columnMeta?.[c]?.dataType}
                      onClick={() => onSort(c)}
                    >
                      {columnMeta?.[c] ? (
                        <Icon
                          name={columnMeta[c].pk ? "key" : "columns"}
                          className="tw:shrink-0 tw:text-xs tw:text-muted-foreground"
                        />
                      ) : null}
                      <span className="tw:overflow-hidden tw:text-ellipsis">
                        {c}
                      </span>
                      {sort?.col === c ? (
                        <Icon
                          name={
                            sort.dir === "asc" ? "caretUp" : "caretDown"
                          }
                          className="tw:shrink-0 tw:text-2xs tw:text-primary"
                        />
                      ) : null}
                    </button>
                  ) : (
                    <span
                      className="tw:inline-flex tw:min-w-0 tw:flex-1 tw:items-center tw:gap-1 tw:overflow-hidden"
                      title={columnMeta?.[c]?.dataType}
                    >
                      {columnMeta?.[c] ? (
                        <Icon
                          name={columnMeta[c].pk ? "key" : "columns"}
                          className="tw:shrink-0 tw:text-xs tw:text-muted-foreground"
                        />
                      ) : null}
                      <span className="tw:overflow-hidden tw:text-ellipsis">
                        {c}
                      </span>
                    </span>
                  )}
                  {onFilter ? (
                    <DataGridColumnFilterMenu
                      column={c}
                      values={result.rows.map((row) => row[j])}
                      filter={filters?.[c] ?? ""}
                      onFilter={(value) => onFilter(c, value)}
                    />
                  ) : null}
                </span>
                <span
                  className="tw:absolute tw:top-0 tw:right-0 tw:z-[var(--ds-z-sticky)] tw:h-full tw:w-2 tw:cursor-col-resize tw:hover:bg-primary/55 tw:active:bg-primary/55"
                  title={t("grid.resizeHint")}
                  onMouseDown={(e) => startResize(e, j + 1)}
                  onClick={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    setWidths({});
                  }}
                />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, i) => (
            <tr
              key={i}
              data-selected={selectedRow === i}
              className="tw:group tw:[contain-intrinsic-size:0_var(--ds-control-md)] tw:[content-visibility:auto] tw:even:[&>td]:bg-card tw:hover:[&>td]:bg-muted tw:data-[selected=true]:[&>td]:bg-selection"
            >
              <td
                className={`tw:sticky tw:left-0 tw:z-[var(--ds-z-base)] tw:bg-card tw:text-right tw:text-muted-foreground${onSelectRow ? " tw:cursor-pointer" : ""}`}
                role={onSelectRow ? "button" : undefined}
                tabIndex={onSelectRow ? 0 : undefined}
                onClick={onSelectRow ? () => onSelectRow(i) : undefined}
                onKeyDown={
                  onSelectRow
                    ? (e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onSelectRow(i);
                        }
                      }
                    : undefined
                }
              >
                {startIndex + i + 1}
              </td>
              {row.map((v, j) => {
                const text = cell(v);
                const isSel = gridSelectionIncludes(sel, i, j);
                const isFocus =
                  sel?.focus.row === i && sel.focus.col === j;
                return (
                  <td
                    key={j}
                    className={`tw:max-w-[480px] tw:overflow-hidden tw:bg-background tw:text-ellipsis${v === null ? " tw:text-muted-foreground tw:italic" : ""}${numericCols[j] ? " tw:text-right tw:tabular-nums" : ""}${interactive ? " tw:cursor-pointer" : ""}${isSel ? " tw:!bg-selection" : ""}${isFocus ? " tw:shadow-[inset_0_0_0_var(--ds-border-width-strong)_var(--ds-ring)]" : ""}`}
                    // fixed layout clips by width not length, so any value can be truncated → always title it
                    title={
                      fixed || text.length > 40 || text.includes("\n")
                        ? text
                        : undefined
                    }
                    // Roving tabindex: only the selected cell is a tab stop; arrows move it (onKeyDown above).
                    tabIndex={isFocus ? 0 : -1}
                    aria-selected={isSel}
                    data-grid-value
                    onClick={(event: ReactMouseEvent) =>
                      selectCell(i, j, event.shiftKey)
                    }
                  >
                    {text}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
