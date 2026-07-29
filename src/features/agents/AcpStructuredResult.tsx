import DataGrid from "../../components/DataGrid";
import type { JsonValue, QueryResult } from "../../ipc/types";

const MAX_COLUMNS = 18;
const MAX_ROWS = 100;
const MAX_CHART_ROWS = 8;

export default function AcpStructuredResult({ value }: { value: unknown }) {
  const result = tabularResult(value);
  if (!result) return null;
  const chart = chartProjection(result);
  return (
    <div className="tw:grid tw:min-w-0 tw:gap-2">
      {chart ? <MiniBarChart {...chart} /> : null}
      <div className="tw:max-h-52 tw:min-h-0 tw:overflow-auto tw:rounded-sm tw:border tw:border-border-subtle">
        <DataGrid result={result} />
      </div>
    </div>
  );
}

function tabularResult(value: unknown): QueryResult | null {
  const candidate = unwrapResult(value);
  if (Array.isArray(candidate)) {
    const objects = candidate.filter(isRecord);
    if (objects.length !== candidate.length || objects.length === 0) return null;
    const allColumns = [
      ...new Set(objects.flatMap((row) => Object.keys(row))),
    ];
    const columns = allColumns.slice(0, MAX_COLUMNS);
    const rows = objects
      .slice(0, MAX_ROWS)
      .map((row) => columns.map((column) => toJsonValue(row[column] ?? null)));
    return {
      columns,
      rows,
      rowCount: rows.length,
      durationMs: 0,
      truncated:
        candidate.length > MAX_ROWS || allColumns.length > MAX_COLUMNS,
    };
  }
  if (!isRecord(candidate)) return null;
  if (
    Array.isArray(candidate.columns) &&
    candidate.columns.every((column) => typeof column === "string") &&
    Array.isArray(candidate.rows) &&
    candidate.rows.every(Array.isArray)
  ) {
    const columns = candidate.columns.slice(0, MAX_COLUMNS) as string[];
    const rows = (candidate.rows as unknown[][])
      .slice(0, MAX_ROWS)
      .map((row) =>
        row.slice(0, columns.length).map((cell) => toJsonValue(cell)),
      );
    return {
      columns,
      rows,
      rowCount: rows.length,
      durationMs:
        typeof candidate.durationMs === "number" ? candidate.durationMs : 0,
      truncated:
        candidate.rows.length > MAX_ROWS ||
        candidate.columns.length > MAX_COLUMNS ||
        candidate.truncated === true,
    };
  }
  return null;
}

function unwrapResult(value: unknown): unknown {
  let current = value;
  for (let depth = 0; depth < 3; depth += 1) {
    if (!isRecord(current)) break;
    const next =
      current.result ??
      current.data ??
      current.output ??
      current.rows;
    if (next === undefined || next === current) break;
    if (Array.isArray(current.columns) && Array.isArray(current.rows)) break;
    current = next;
  }
  if (typeof current === "string") {
    try {
      return JSON.parse(current);
    } catch {
      return current;
    }
  }
  return current;
}

function chartProjection(result: QueryResult): {
  labels: string[];
  values: number[];
  valueLabel: string;
} | null {
  if (result.rows.length < 2) return null;
  const numericColumn = result.columns.findIndex((_, index) =>
    result.rows.every((row) => finiteNumber(row[index]) !== null)
  );
  const labelColumn = result.columns.findIndex(
    (_, index) =>
      index !== numericColumn &&
      result.rows.every((row) =>
        ["string", "number", "boolean"].includes(typeof row[index])
      ),
  );
  if (numericColumn < 0 || labelColumn < 0) return null;
  const rows = result.rows.slice(0, MAX_CHART_ROWS);
  const values = rows.map((row) => finiteNumber(row[numericColumn]) ?? 0);
  if (values.every((value) => value === values[0])) return null;
  return {
    labels: rows.map((row) => String(row[labelColumn] ?? "NULL")),
    values,
    valueLabel: result.columns[numericColumn],
  };
}

function MiniBarChart({
  labels,
  values,
  valueLabel,
}: {
  labels: string[];
  values: number[];
  valueLabel: string;
}) {
  const maximum = Math.max(...values.map(Math.abs), 1);
  const width = 280;
  const height = 92;
  const gap = 5;
  const barWidth = (width - gap * (values.length - 1)) / values.length;
  return (
    <figure className="tw:m-0 tw:grid tw:gap-1 tw:rounded-sm tw:border tw:border-border-subtle tw:bg-background tw:p-2">
      <figcaption className="tw:text-xs tw:font-medium tw:text-muted-foreground">
        {valueLabel}
      </figcaption>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="tw:h-24 tw:w-full tw:overflow-visible tw:text-primary"
        role="img"
        aria-label={`${valueLabel}: ${labels
          .map((label, index) => `${label} ${values[index]}`)
          .join(", ")}`}
      >
        {values.map((value, index) => {
          const barHeight = Math.max(2, (Math.abs(value) / maximum) * 68);
          const x = index * (barWidth + gap);
          const y = 72 - barHeight;
          return (
            <g key={`${labels[index]}:${index}`}>
              <rect
                x={x}
                y={y}
                width={barWidth}
                height={barHeight}
                rx={2}
                fill="currentColor"
                opacity={0.8}
              />
              <text
                x={x + barWidth / 2}
                y={88}
                textAnchor="middle"
                fill="currentColor"
                className="tw:text-[8px] tw:text-muted-foreground"
              >
                {truncate(labels[index], 8)}
              </text>
            </g>
          );
        })}
      </svg>
    </figure>
  );
}

function finiteNumber(value: unknown): number | null {
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(number) ? number : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function toJsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }
  if (Array.isArray(value)) {
    return value.map(toJsonValue);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, toJsonValue(entry)]),
    );
  }
  return String(value);
}

function truncate(value: string, max: number) {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
