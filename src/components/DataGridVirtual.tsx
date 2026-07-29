// Windowed row-and-column renderer for large query results. The scroll spacer owns
// geometry; only cells intersecting the viewport (+ a small overscan) enter the DOM.
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import type { QueryResult } from "../ipc/types";
import {
  sqlStreamRowAt,
  type SqlStreamRowSource,
} from "../features/queries/domain";
import type { GridSort } from "../lib/sqlBuild";
import { Icon } from "./Icon";
import { useI18n } from "../lib/i18n";
import {
  extendGridSelection,
  gridSelectionClipboardText,
  gridSelectionIncludes,
  singleGridCell,
  type GridCellSelection,
} from "./dataGridSelection";

const ROW_HEIGHT = 32;
const HEADER_HEIGHT = 32;
const ROW_NUMBER_WIDTH = 56;
const DEFAULT_COLUMN_WIDTH = 180;
const OVERSCAN = 4;

type Props = {
  result: QueryResult;
  rowSource?: SqlStreamRowSource;
  startIndex: number;
  sort?: GridSort | null;
  onSort?: (col: string) => void;
  selectedRow?: number | null;
  onSelectRow?: (i: number) => void;
  onCellClick?: (value: unknown, rowIndex: number, col: string) => void;
  columnMeta?: Record<string, { dataType: string; pk: boolean }>;
  surface?: "panel" | "workbench";
};

export function virtualGridWindow(
  rowCount: number,
  columnCount: number,
  offsets: number[],
  scroll: { top: number; left: number; width: number; height: number },
) {
  const startRow = Math.max(0, Math.floor(scroll.top / ROW_HEIGHT) - OVERSCAN);
  const endRow = Math.min(
    rowCount,
    Math.ceil((scroll.top + scroll.height) / ROW_HEIGHT) + OVERSCAN,
  );
  let firstColumn = 0;
  while (firstColumn < columnCount && offsets[firstColumn + 1] <= scroll.left)
    firstColumn += 1;
  const visibleColumns: number[] = [];
  for (
    let index = Math.max(0, firstColumn - OVERSCAN);
    index < columnCount;
    index += 1
  ) {
    if (
      offsets[index] >
      scroll.left + scroll.width + DEFAULT_COLUMN_WIDTH * OVERSCAN
    )
      break;
    visibleColumns.push(index);
  }
  return { startRow, endRow, visibleColumns };
}

function display(value: unknown) {
  if (value === null || value === undefined) return "NULL";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function copy(value: unknown) {
  if (value === null || value === undefined) return "NULL";
  return typeof value === "object"
    ? JSON.stringify(value, null, 2)
    : String(value);
}

export default function DataGridVirtual(props: Props) {
  const { t } = useI18n();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState({
    top: 0,
    left: 0,
    width: 720,
    height: 320,
  });
  const [selection, setSelection] = useState<GridCellSelection | null>(null);
  const [widths, setWidths] = useState<Record<number, number>>({});
  const interactive = !!props.onCellClick || !!props.onSelectRow;
  const rowCount = props.rowSource?.rowCount ?? props.result.rows.length;
  const rowAt = (index: number) =>
    props.rowSource
      ? sqlStreamRowAt(props.rowSource, index)
      : props.result.rows[index];
  const columnWidths = useMemo(
    () =>
      props.result.columns.map(
        (_, index) => widths[index] ?? DEFAULT_COLUMN_WIDTH,
      ),
    [props.result.columns, widths],
  );
  const offsets = useMemo(() => {
    const next = [ROW_NUMBER_WIDTH];
    for (const width of columnWidths) next.push(next[next.length - 1] + width);
    return next;
  }, [columnWidths]);
  const totalWidth = offsets[offsets.length - 1] ?? ROW_NUMBER_WIDTH;
  const { startRow, endRow, visibleColumns } = virtualGridWindow(
    rowCount,
    props.result.columns.length,
    offsets,
    scroll,
  );

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const update = () =>
      setScroll({
        top: element.scrollTop,
        left: element.scrollLeft,
        width: element.clientWidth,
        height: element.clientHeight,
      });
    update();
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, []);
  useEffect(() => setSelection(null), [props.result.columns.join("\u0000")]);

  const select = (row: number, col: number, extend = false) => {
    setSelection((current) =>
      extend && current
        ? extendGridSelection(current, row, col)
        : singleGridCell(row, col),
    );
  };
  const activate = (row: number, col: number, extend = false) => {
    if (extend && selection) {
      setSelection(extendGridSelection(selection, row, col));
      return;
    }
    setSelection(singleGridCell(row, col));
    props.onSelectRow?.(row);
    props.onCellClick?.(rowAt(row)?.[col], row, props.result.columns[col]);
  };
  useEffect(() => {
    if (!selection) return;
    const cell = scrollRef.current?.querySelector<HTMLElement>(
      `[data-grid-cell="${selection.focus.row}:${selection.focus.col}"]`,
    );
    cell?.focus();
  }, [selection, startRow, endRow, visibleColumns.join(",")]);
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") return setSelection(null);
    if (
      (event.metaKey || event.ctrlKey) &&
      event.key.toLowerCase() === "c" &&
      selection
    ) {
      if (window.getSelection()?.toString()) return;
      event.preventDefault();
      void navigator.clipboard.writeText(
        gridSelectionClipboardText(selection, rowAt, display, copy),
      );
      return;
    }
    if (event.key === "Enter" && selection) {
      event.preventDefault();
      activate(selection.focus.row, selection.focus.col);
      return;
    }
    if (!/^Arrow(Up|Down|Left|Right)$/.test(event.key) || !rowCount) return;
    event.preventDefault();
    const current = selection?.focus ?? { row: 0, col: 0 };
    const row =
      !selection
        ? 0
        : event.key === "ArrowUp"
        ? Math.max(0, current.row - 1)
        : event.key === "ArrowDown"
          ? Math.min(rowCount - 1, current.row + 1)
          : current.row;
    const col =
      event.key === "ArrowLeft"
        ? Math.max(0, current.col - 1)
        : event.key === "ArrowRight"
          ? Math.min(props.result.columns.length - 1, current.col + 1)
          : current.col;
    select(row, col, event.shiftKey);
    scrollRef.current?.scrollTo({
      top: Math.max(0, row * ROW_HEIGHT - ROW_HEIGHT),
      left: Math.max(0, offsets[col] - ROW_NUMBER_WIDTH),
    });
  };
  const resize = (event: ReactMouseEvent, index: number) => {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const initial = columnWidths[index];
    const onMove = (moveEvent: MouseEvent) =>
      setWidths((current) => ({
        ...current,
        [index]: Math.max(
          72,
          Math.min(1200, initial + moveEvent.clientX - startX),
        ),
      }));
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  return (
    <div
      ref={scrollRef}
      data-data-grid-scroll
      className="tw:relative tw:max-h-[60vh] tw:min-h-[180px] tw:overflow-auto tw:rounded-lg tw:border tw:border-border-subtle tw:bg-background tw:shadow-panel tw:[contain:strict] tw:[&::-webkit-scrollbar]:size-[11px] tw:[&::-webkit-scrollbar-corner]:bg-transparent tw:[&::-webkit-scrollbar-thumb]:rounded-full tw:[&::-webkit-scrollbar-thumb]:border-[var(--ds-border-width-bold)] tw:[&::-webkit-scrollbar-thumb]:border-transparent tw:[&::-webkit-scrollbar-thumb]:bg-muted-foreground tw:[&::-webkit-scrollbar-thumb]:bg-clip-padding tw:[&::-webkit-scrollbar-thumb:hover]:bg-foreground tw:[&::-webkit-scrollbar-track]:bg-transparent tw:data-[surface=workbench]:min-h-0 tw:data-[surface=workbench]:flex-1 tw:data-[surface=workbench]:rounded-none tw:data-[surface=workbench]:border-0 tw:data-[surface=workbench]:shadow-none"
      data-surface={props.surface ?? "panel"}
      role="grid"
      aria-rowcount={rowCount + 1}
      aria-colcount={props.result.columns.length + 1}
      tabIndex={0}
      onKeyDown={move}
      onScroll={(event) =>
        setScroll({
          top: event.currentTarget.scrollTop,
          left: event.currentTarget.scrollLeft,
          width: event.currentTarget.clientWidth,
          height: event.currentTarget.clientHeight,
        })
      }
    >
      <div
        className="tw:relative tw:min-w-full tw:[&_[data-grid-box]]:absolute tw:[&_[data-grid-box]]:box-border tw:[&_[data-grid-box]]:h-control-md tw:[&_[data-grid-box]]:overflow-hidden tw:[&_[data-grid-box]]:border-r tw:[&_[data-grid-box]]:border-b tw:[&_[data-grid-box]]:border-border-subtle tw:[&_[data-grid-box]]:bg-background tw:[&_[data-grid-box]]:px-2 tw:[&_[data-grid-box]]:py-1 tw:[&_[data-grid-box]]:leading-ui tw:[&_[data-grid-box]]:text-ellipsis tw:[&_[data-grid-box]]:whitespace-nowrap"
        style={{
          width: totalWidth,
          height: HEADER_HEIGHT + rowCount * ROW_HEIGHT,
        }}
      >
        <div
          className="tw:sticky tw:top-0 tw:left-0 tw:right-0 tw:z-[var(--ds-z-raised)] tw:h-control-md tw:overflow-visible tw:bg-card"
          role="row"
          aria-rowindex={1}
        >
          <div
            data-grid-box
            className="tw:top-0 tw:left-0 tw:z-[calc(var(--ds-z-raised)+1)] tw:w-14 tw:!bg-card tw:text-right tw:text-muted-foreground"
            role="columnheader"
            aria-colindex={1}
          >
            #
          </div>
          {visibleColumns.map((index) => {
            const name = props.result.columns[index];
            const sortableHeaderProps = props.onSort
              ? {
                  tabIndex: 0,
                  "aria-sort": (props.sort?.col === name
                    ? props.sort.dir === "asc"
                      ? "ascending"
                      : "descending"
                    : "none") as "ascending" | "descending" | "none",
                  onClick: () => props.onSort?.(name),
                  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      event.stopPropagation();
                      props.onSort?.(name);
                    }
                  },
                }
              : {};
            return (
              <div
                key={name}
                data-grid-box
                className={`tw:top-0 tw:!bg-card tw:font-semibold${props.onSort ? " tw:cursor-pointer tw:hover:text-primary" : ""}`}
                role="columnheader"
                aria-colindex={index + 2}
                style={{ left: offsets[index], width: columnWidths[index] }}
                {...sortableHeaderProps}
              >
                <span
                  className="tw:inline-flex tw:min-w-0 tw:items-center tw:gap-1 tw:align-middle tw:[&_.icon]:shrink-0 tw:[&_.icon]:text-xs tw:[&_.icon]:text-muted-foreground tw:[&>span]:overflow-hidden tw:[&>span]:text-ellipsis"
                  title={props.columnMeta?.[name]?.dataType}
                >
                  {props.columnMeta?.[name] ? (
                    <Icon
                      name={props.columnMeta[name].pk ? "key" : "columns"}
                    />
                  ) : null}
                  <span>{name}</span>
                </span>
                {props.sort?.col === name && (
                  <span className="tw:text-2xs tw:text-primary">
                    <Icon
                      name={props.sort.dir === "asc" ? "caretUp" : "caretDown"}
                    />
                  </span>
                )}
                <span
                  className="tw:absolute tw:top-0 tw:right-0 tw:z-[var(--ds-z-sticky)] tw:h-full tw:w-2 tw:cursor-col-resize tw:hover:bg-primary/55 tw:active:bg-primary/55"
                  title={t("grid.resizeHint")}
                  onMouseDown={(event) => resize(event, index)}
                  onClick={(event) => event.stopPropagation()}
                  onDoubleClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setWidths((current) => {
                      const next = { ...current };
                      delete next[index];
                      return next;
                    });
                  }}
                />
              </div>
            );
          })}
        </div>
        {Array.from(
          { length: Math.max(0, endRow - startRow) },
          (_, offset) => startRow + offset,
        ).map((rowIndex) => (
          <div
            key={rowIndex}
            data-selected={props.selectedRow === rowIndex}
            data-zebra={rowIndex % 2 === 1}
            className="tw:group tw:absolute tw:top-0 tw:left-0 tw:right-0 tw:h-control-md"
            role="row"
            aria-rowindex={rowIndex + 2}
            style={{
              transform: `translateY(${HEADER_HEIGHT + rowIndex * ROW_HEIGHT}px)`,
            }}
          >
            <div
              data-grid-box
              className={`tw:left-0 tw:z-[var(--ds-z-base)] tw:w-14 tw:!bg-card tw:text-right tw:text-muted-foreground tw:group-data-[selected=true]:!bg-selection${props.onSelectRow ? " tw:cursor-pointer" : ""}`}
              role="rowheader"
              aria-colindex={1}
              onClick={() => props.onSelectRow?.(rowIndex)}
            >
              {props.startIndex + rowIndex + 1}
            </div>
            {visibleColumns.map((columnIndex) => {
              const value = rowAt(rowIndex)?.[columnIndex];
              const text = display(value);
              const selected = gridSelectionIncludes(
                selection,
                rowIndex,
                columnIndex,
              );
              const focused =
                selection?.focus.row === rowIndex &&
                selection.focus.col === columnIndex;
              return (
                <div
                  key={columnIndex}
                  data-grid-cell={`${rowIndex}:${columnIndex}`}
                  data-grid-box
                  className={`tw:group-data-[zebra=true]:!bg-card tw:group-data-[selected=true]:!bg-selection${value === null ? " tw:text-muted-foreground tw:italic" : ""}${interactive ? " tw:cursor-pointer" : ""}${selected ? " tw:!bg-selection" : ""}${focused ? " tw:shadow-[inset_0_0_0_var(--ds-border-width-strong)_var(--ds-ring)]" : ""}`}
                  role="gridcell"
                  aria-colindex={columnIndex + 2}
                  aria-selected={selected}
                  tabIndex={focused ? 0 : -1}
                  title={
                    text.length > 40 || text.includes("\n") ? text : undefined
                  }
                  style={{
                    left: offsets[columnIndex],
                    width: columnWidths[columnIndex],
                  }}
                  onClick={(event) =>
                    activate(rowIndex, columnIndex, event.shiftKey)
                  }
                >
                  {text}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
