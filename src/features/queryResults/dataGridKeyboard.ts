// Shared composite-grid keyboard model. The first composite column is the row
// header; data columns follow at indices 1..N so both renderers navigate the
// same coordinates without leaking their DOM or virtualization strategy.
export type DataGridFocus = {
  row: number;
  column: number;
};

export type DataGridKeyboardInput = {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  current: DataGridFocus;
  rowCount: number;
  dataColumnCount: number;
  pageRows: number;
};

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}
export function dataGridKeyboardTarget({
  key,
  ctrlKey = false,
  metaKey = false,
  current,
  rowCount,
  dataColumnCount,
  pageRows,
}: DataGridKeyboardInput): DataGridFocus | null {
  if (rowCount <= 0 || dataColumnCount < 0) return null;
  const lastRow = rowCount - 1;
  const lastColumn = dataColumnCount;
  const row = clamp(current.row, 0, lastRow);
  const column = clamp(current.column, 0, lastColumn);
  const wholeGrid = ctrlKey || metaKey;

  switch (key) {
    case "ArrowUp":
      return { row: Math.max(0, row - 1), column };
    case "ArrowDown":
      return { row: Math.min(lastRow, row + 1), column };
    case "ArrowLeft":
      return { row, column: Math.max(0, column - 1) };
    case "ArrowRight":
      return { row, column: Math.min(lastColumn, column + 1) };
    case "Home":
      return wholeGrid ? { row: 0, column: 0 } : { row, column: 0 };
    case "End":
      return wholeGrid
        ? { row: lastRow, column: lastColumn }
        : { row, column: lastColumn };
    case "PageUp":
      return { row: Math.max(0, row - Math.max(1, pageRows)), column };
    case "PageDown":
      return {
        row: Math.min(lastRow, row + Math.max(1, pageRows)),
        column,
      };
    default:
      return null;
  }
}
