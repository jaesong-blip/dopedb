// Dependency-free dashboard renderer. It consumes a declarative chart spec,
// draws bounded SVG for visual scanning, and always exposes the raw data grid.
import type { ReactNode } from "react";
import type { DashboardVisualization } from "../features/dashboards/domain";
import type { QueryResult } from "../ipc/types";
import {
  dashboardMapping,
  numericValue,
  resolvedDashboardKind,
} from "../lib/dashboardSpec";
import { useI18n } from "../lib/i18n";
import DataGrid from "./DataGrid";

const VIEW_W = 800;
const VIEW_H = 280;
const PAD_L = 76;
const PAD_R = 20;
const PAD_T = 24;
const PAD_B = 48;
const PLOT_W = VIEW_W - PAD_L - PAD_R;
const PLOT_H = VIEW_H - PAD_T - PAD_B;

function compact(value: unknown): string {
  if (value == null) return "NULL";
  if (typeof value === "number") return value.toLocaleString();
  const text = String(value);
  return text.length > 14 ? `${text.slice(0, 13)}…` : text;
}

function metric(value: unknown): string {
  if (
    typeof value === "string" &&
    /^[-+]?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(value.trim())
  ) {
    return value.trim();
  }
  const n = numericValue(value);
  if (n == null) return compact(value);
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function seriesColor(index: number): string {
  if (index === 0) return "var(--ds-chart-series-1)";
  if (index === 1) return "var(--ds-chart-series-2)";
  if (index === 2) return "var(--ds-chart-series-3)";
  return "var(--ds-chart-series-fallback)";
}

function chartRows(result: QueryResult) {
  return result.rows.slice(0, 80);
}

function chartableColumns(result: QueryResult, columns: string[]) {
  const rows = chartRows(result);
  return columns.filter((column) => {
    const index = result.columns.indexOf(column);
    return index >= 0 && rows.some((row) => numericValue(row[index]) != null);
  });
}

function chartValues(result: QueryResult, yColumns: string[]) {
  return chartRows(result).flatMap((row) =>
    yColumns
      .map((column) => numericValue(row[result.columns.indexOf(column)]))
      .filter((value): value is number => value != null),
  );
}

function lineBounds(result: QueryResult, yColumns: string[]) {
  const values = chartValues(result, yColumns);
  if (values.length === 0) return { min: 0, max: 1 };
  const low = Math.min(...values);
  const high = Math.max(...values);
  const span = Math.max(Math.abs(high - low), Math.abs(high) * 0.04, 1);
  return { min: low - span * 0.08, max: high + span * 0.08 };
}

function barBounds(result: QueryResult, yColumns: string[]) {
  const values = chartValues(result, yColumns);
  if (values.length === 0) return { min: 0, max: 1 };
  let min = Math.min(0, ...values);
  let max = Math.max(0, ...values);
  if (min === max) {
    min -= 1;
    max += 1;
  }
  return { min, max };
}

function yAt(value: number, min: number, max: number) {
  return PAD_T + PLOT_H - ((value - min) / (max - min)) * PLOT_H;
}

function Axis({ min, max }: { min: number; max: number }) {
  return (
    <g>
      {[0, 1, 2, 3, 4].map((step) => {
        const ratio = step / 4;
        const y = PAD_T + PLOT_H * ratio;
        const value = max - (max - min) * ratio;
        return (
          <g key={step}>
            <line
              className="tw:stroke-border-subtle tw:[stroke-width:var(--ds-border-width)] tw:[vector-effect:non-scaling-stroke]"
              x1={PAD_L}
              x2={VIEW_W - PAD_R}
              y1={y}
              y2={y}
            />
            <text
              className="tw:fill-muted-foreground tw:font-mono tw:text-2xs tw:tabular-nums"
              x={PAD_L - 8}
              y={y + 4}
              textAnchor="end"
            >
              {Number(value.toFixed(2)).toLocaleString()}
            </text>
          </g>
        );
      })}
    </g>
  );
}

function XLabels({ result, xColumn }: { result: QueryResult; xColumn: string | null }) {
  const rows = chartRows(result);
  if (!xColumn || rows.length === 0) return null;
  const xIndex = result.columns.indexOf(xColumn);
  const count = Math.min(6, rows.length);
  const indexes = Array.from({ length: count }, (_, i) =>
    Math.round((i * (rows.length - 1)) / Math.max(1, count - 1)),
  );
  return (
    <g>
      {[...new Set(indexes)].map((index) => {
        const x = PAD_L + (index / Math.max(1, rows.length - 1)) * PLOT_W;
        const textAnchor =
          index === 0 ? "start" : index === rows.length - 1 ? "end" : "middle";
        return (
          <text
            className="tw:fill-muted-foreground tw:font-mono tw:text-2xs tw:tabular-nums"
            key={index}
            x={x}
            y={VIEW_H - 18}
            textAnchor={textAnchor}
          >
            {compact(rows[index]?.[xIndex])}
          </text>
        );
      })}
    </g>
  );
}

function Legend({
  columns,
  compactView,
}: {
  columns: string[];
  compactView: boolean;
}) {
  return (
    <div
      data-compact={compactView}
      className="tw:flex tw:min-w-0 tw:flex-wrap tw:items-center tw:gap-3 tw:text-sm tw:text-muted-foreground tw:data-[compact=true]:gap-2 tw:data-[compact=true]:text-xs"
      aria-hidden="true"
    >
      {columns.map((column, index) => (
        <span
          className="tw:inline-flex tw:min-w-0 tw:items-center tw:gap-1"
          key={column}
        >
          <i
            className="tw:h-px tw:w-3 tw:shrink-0 tw:rounded-full"
            style={{ background: seriesColor(index) }}
          />
          {column}
        </span>
      ))}
    </div>
  );
}

function LineChart({
  result,
  visualization,
  compactView,
}: {
  result: QueryResult;
  visualization: DashboardVisualization;
  compactView: boolean;
}) {
  const { t } = useI18n();
  const rows = chartRows(result);
  const mapping = dashboardMapping(result, visualization);
  const xColumn = mapping.xColumn;
  const yColumns = chartableColumns(result, mapping.yColumns);
  const { min, max } = lineBounds(result, yColumns);
  return (
    <figure
      data-compact={compactView}
      className="tw:group tw:m-0 tw:grid tw:gap-3 tw:data-[compact=true]:gap-2"
      aria-label={t("dashboard.lineChartLabel")}
    >
      <Legend columns={yColumns} compactView={compactView} />
      <svg
        data-compact={compactView}
        className="tw:max-h-[360px] tw:min-h-[240px] tw:w-full tw:overflow-visible tw:rounded-md tw:border tw:border-border-subtle tw:bg-muted tw:data-[compact=true]:max-h-[220px] tw:data-[compact=true]:min-h-[176px] tw:data-[compact=true]:rounded-none tw:data-[compact=true]:border-0 tw:data-[compact=true]:bg-transparent"
        role="img"
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      >
        <title>{t("dashboard.lineChartLabel")}</title>
        <Axis min={min} max={max} />
        {yColumns.map((column, seriesIndex) => {
          const columnIndex = result.columns.indexOf(column);
          const points = rows
            .map((row, index) => {
              const value = numericValue(row[columnIndex]);
              if (value == null) return null;
              const x = PAD_L + (index / Math.max(1, rows.length - 1)) * PLOT_W;
              return `${x},${yAt(value, min, max)}`;
            })
            .filter((point): point is string => point != null)
            .join(" ");
          return (
            <polyline
              key={column}
              points={points}
              fill="none"
              stroke={seriesColor(seriesIndex)}
              strokeWidth={seriesIndex === 0 ? 3 : 2}
              strokeDasharray={seriesIndex > 1 ? "6 4" : undefined}
              vectorEffect="non-scaling-stroke"
              className="tw:transition-opacity tw:duration-150 tw:group-hover:opacity-90 tw:motion-reduce:transition-none"
            />
          );
        })}
        <XLabels result={result} xColumn={xColumn} />
      </svg>
    </figure>
  );
}

function BarChart({
  result,
  visualization,
  compactView,
}: {
  result: QueryResult;
  visualization: DashboardVisualization;
  compactView: boolean;
}) {
  const { t } = useI18n();
  const rows = chartRows(result).slice(0, 32);
  const mapping = dashboardMapping(
    { ...result, rows },
    visualization,
  );
  const xColumn = mapping.xColumn;
  const yColumns = chartableColumns({ ...result, rows }, mapping.yColumns);
  const { min, max } = barBounds({ ...result, rows }, yColumns);
  const zeroY = yAt(0, min, max);
  const groupWidth = PLOT_W / Math.max(1, rows.length);
  const barWidth = Math.max(2, (groupWidth * 0.72) / Math.max(1, yColumns.length));
  return (
    <figure
      data-compact={compactView}
      className="tw:group tw:m-0 tw:grid tw:gap-3 tw:data-[compact=true]:gap-2"
      aria-label={t("dashboard.barChartLabel")}
    >
      <Legend columns={yColumns} compactView={compactView} />
      <svg
        data-compact={compactView}
        className="tw:max-h-[360px] tw:min-h-[240px] tw:w-full tw:overflow-visible tw:rounded-md tw:border tw:border-border-subtle tw:bg-muted tw:data-[compact=true]:max-h-[220px] tw:data-[compact=true]:min-h-[176px] tw:data-[compact=true]:rounded-none tw:data-[compact=true]:border-0 tw:data-[compact=true]:bg-transparent"
        role="img"
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      >
        <title>{t("dashboard.barChartLabel")}</title>
        <Axis min={min} max={max} />
        {rows.flatMap((row, rowIndex) =>
          yColumns.map((column, seriesIndex) => {
            const value = numericValue(row[result.columns.indexOf(column)]);
            if (value == null) return null;
            const valueY = yAt(value, min, max);
            const x =
              PAD_L +
              rowIndex * groupWidth +
              groupWidth * 0.14 +
              seriesIndex * barWidth;
            return (
              <rect
                key={`${rowIndex}-${column}`}
                x={x}
                y={Math.min(valueY, zeroY)}
                width={barWidth}
                height={Math.max(1, Math.abs(zeroY - valueY))}
                fill={seriesColor(seriesIndex)}
                rx={1}
                className="tw:transition-opacity tw:duration-150 tw:group-hover:opacity-90 tw:motion-reduce:transition-none"
              />
            );
          }),
        )}
        <XLabels result={{ ...result, rows }} xColumn={xColumn} />
      </svg>
    </figure>
  );
}

function MetricView({
  result,
  visualization,
  compactView,
}: {
  result: QueryResult;
  visualization: DashboardVisualization;
  compactView: boolean;
}) {
  const mapping = dashboardMapping(result, visualization);
  const columns = mapping.yColumns.length > 0 ? mapping.yColumns : result.columns.slice(0, 4);
  const row = result.rows[0] ?? [];
  return (
    <div
      data-compact={compactView}
      className="tw:grid tw:grid-cols-[repeat(auto-fit,minmax(180px,1fr))] tw:gap-2 tw:data-[compact=true]:grid-cols-[repeat(auto-fit,minmax(120px,1fr))]"
    >
      {columns.map((column) => (
        <article
          data-compact={compactView}
          className="card tw:grid tw:min-w-0 tw:gap-2 tw:border-l-3 tw:border-l-primary tw:data-[compact=true]:rounded-none tw:data-[compact=true]:border-y-0 tw:data-[compact=true]:border-r-0 tw:data-[compact=true]:bg-transparent tw:data-[compact=true]:p-2 tw:data-[compact=true]:shadow-none"
          key={column}
        >
          <span className="tw:overflow-hidden tw:text-sm tw:text-muted-foreground tw:text-ellipsis tw:whitespace-nowrap">
            {column}
          </span>
          <strong
            data-compact={compactView}
            className="tw:overflow-hidden tw:font-mono tw:text-heading tw:tracking-[-0.02em] tw:tabular-nums tw:text-ellipsis tw:data-[compact=true]:text-title"
          >
            {metric(row[result.columns.indexOf(column)])}
          </strong>
        </article>
      ))}
    </div>
  );
}

function TableFallback({ result }: { result: QueryResult }) {
  const { t } = useI18n();
  return (
    <div className="tw:grid tw:min-w-0 tw:gap-2">
      <p className="tw:m-0 tw:text-muted-foreground">
        {t("dashboard.chartFallback")}
      </p>
      <DataGrid result={result} />
    </div>
  );
}

function VisualizationFrame({
  compactView,
  children,
}: {
  compactView: boolean;
  children: ReactNode;
}) {
  return (
    <div
      data-dashboard-visualization
      data-compact={compactView}
      className="tw:min-w-0 tw:data-[compact=true]:min-h-0 tw:data-[compact=true]:flex-1 tw:data-[compact=true]:overflow-hidden tw:data-[compact=true]:[&_[data-data-grid-scroll]]:max-h-[230px]"
    >
      {children}
    </div>
  );
}

export default function DashboardVisualizationView({
  result,
  visualization,
  compact = false,
}: {
  result: QueryResult;
  visualization: DashboardVisualization;
  compact?: boolean;
}) {
  const { t } = useI18n();
  if (result.rows.length === 0) {
    return (
      <VisualizationFrame compactView={compact}>
        <div className="tw:text-muted-foreground">{t("dashboard.noRows")}</div>
      </VisualizationFrame>
    );
  }
  const kind = resolvedDashboardKind(result, visualization);
  const mapping = dashboardMapping(result, visualization);
  if (kind !== "table" && mapping.yColumns.length === 0) {
    return (
      <VisualizationFrame compactView={compact}>
        <TableFallback result={result} />
      </VisualizationFrame>
    );
  }
  if (
    (kind === "line" || kind === "bar") &&
    chartableColumns(result, mapping.yColumns).length === 0
  ) {
    return (
      <VisualizationFrame compactView={compact}>
        <TableFallback result={result} />
      </VisualizationFrame>
    );
  }
  if (kind === "table") {
    return (
      <VisualizationFrame compactView={compact}>
        <DataGrid result={result} />
      </VisualizationFrame>
    );
  }
  return (
    <VisualizationFrame compactView={compact}>
      {kind === "metric" ? (
        <MetricView
          result={result}
          visualization={visualization}
          compactView={compact}
        />
      ) : kind === "line" ? (
        <LineChart
          result={result}
          visualization={visualization}
          compactView={compact}
        />
      ) : (
        <BarChart
          result={result}
          visualization={visualization}
          compactView={compact}
        />
      )}
      {!compact && (
        <details className="tw:mt-4 tw:[&_[data-data-grid-scroll]]:max-h-[360px]">
          <summary className="tw:mb-2 tw:w-fit tw:cursor-pointer tw:rounded-xs tw:text-sm tw:text-muted-foreground tw:hover:text-foreground tw:focus-visible:outline-none tw:focus-visible:ring-2 tw:focus-visible:ring-ring">
            {t("dashboard.rawData")}
          </summary>
          <DataGrid result={result} />
        </details>
      )}
    </VisualizationFrame>
  );
}
