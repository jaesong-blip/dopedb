export type GridFilterValue = string | null;

const GRID_VALUE_FILTER_PREFIX = "\u001edopedb-grid-values:";

export function gridFilterValue(value: unknown): GridFilterValue {
  if (value === null || value === undefined) return null;
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

export function encodeGridValueFilter(values: GridFilterValue[]) {
  if (values.length === 0) return "";
  return `${GRID_VALUE_FILTER_PREFIX}${JSON.stringify(values)}`;
}

export function decodeGridValueFilter(
  filter: string,
): GridFilterValue[] | null {
  if (!filter.startsWith(GRID_VALUE_FILTER_PREFIX)) return null;
  try {
    const parsed = JSON.parse(
      filter.slice(GRID_VALUE_FILTER_PREFIX.length),
    );
    if (
      !Array.isArray(parsed) ||
      parsed.some((value) => value !== null && typeof value !== "string")
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function gridFilterValueKey(value: GridFilterValue) {
  return value === null ? "null:" : `string:${value}`;
}
