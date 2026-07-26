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
  const [selection, setSelection] = useState<{
    row: number;
    col: number;
  } | null>(null);
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

  const select = (row: number, col: number) => {
    setSelection({ row, col });
  };
  const activate = (row: number, col: number) => {
    setSelection({ row, col });
    props.onSelectRow?.(row);
    props.onCellClick?.(rowAt(row)?.[col], row, props.result.columns[col]);
  };
  useEffect(() => {
    if (!selection) return;
    const cell = scrollRef.current?.querySelector<HTMLElement>(
      `[data-grid-cell="${selection.row}:${selection.col}"]`,
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
        copy(rowAt(selection.row)?.[selection.col]),
      );
      return;
    }
    if (event.key === "Enter" && selection) {
      event.preventDefault();
      activate(selection.row, selection.col);
      return;
    }
    if (!/^Arrow(Up|Down|Left|Right)$/.test(event.key) || !rowCount) return;
    event.preventDefault();
    const current = selection ?? { row: 0, col: 0 };
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
    select(row, col);
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
      className="grid-scroll virtual-grid"
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
        className="virtual-grid-canvas"
        style={{
          width: totalWidth,
          height: HEADER_HEIGHT + rowCount * ROW_HEIGHT,
        }}
      >
        <div className="virtual-grid-header" role="row" aria-rowindex={1}>
          <div
            className="virtual-grid-rownum virtual-grid-header-cell"
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
                className="virtual-grid-header-cell"
                role="columnheader"
                aria-colindex={index + 2}
                style={{ left: offsets[index], width: columnWidths[index] }}
                {...sortableHeaderProps}
              >
                <span
                  className="grid-column-title"
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
                  <span className="sort-arrow">
                    <Icon
                      name={props.sort.dir === "asc" ? "caretUp" : "caretDown"}
                    />
                  </span>
                )}
                <span
                  className="col-resizer"
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
            className={`virtual-grid-row${props.selectedRow === rowIndex ? " selected" : ""}`}
            role="row"
            aria-rowindex={rowIndex + 2}
            style={{
              transform: `translateY(${HEADER_HEIGHT + rowIndex * ROW_HEIGHT}px)`,
            }}
          >
            <div
              className="virtual-grid-rownum"
              role="rowheader"
              aria-colindex={1}
              onClick={() => props.onSelectRow?.(rowIndex)}
            >
              {props.startIndex + rowIndex + 1}
            </div>
            {visibleColumns.map((columnIndex) => {
              const value = rowAt(rowIndex)?.[columnIndex];
              const text = display(value);
              const selected =
                selection?.row === rowIndex && selection.col === columnIndex;
              return (
                <div
                  key={columnIndex}
                  data-grid-cell={`${rowIndex}:${columnIndex}`}
                  className={`virtual-grid-cell${value === null ? " nullcell" : ""}${interactive ? " clickable" : ""}${selected ? " cell-sel" : ""}`}
                  role="gridcell"
                  aria-colindex={columnIndex + 2}
                  aria-selected={selected}
                  tabIndex={selected ? 0 : -1}
                  title={
                    text.length > 40 || text.includes("\n") ? text : undefined
                  }
                  style={{
                    left: offsets[columnIndex],
                    width: columnWidths[columnIndex],
                  }}
                  onClick={() => activate(rowIndex, columnIndex)}
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
