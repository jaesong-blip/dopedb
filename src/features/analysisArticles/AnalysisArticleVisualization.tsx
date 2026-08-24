import { useMemo, useState, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

import { Icon } from "../../components/Icon";
import { AgentRichText } from "../../design-system/components/AgentRichText";
import { Button } from "../../design-system/components/Button";
import {
  CheckboxField,
  Field,
  SelectInput,
  TextInput,
} from "../../design-system/components/FormControls";
import { useI18n } from "../../lib/i18n";
import type {
  AnalysisArticleDefinition,
  AnalysisBlock,
  AnalysisBlockData,
  AnalysisMetric,
  AnalysisNumberFormat,
  AnalysisParameter,
  AnalysisParameterValue,
} from "./domain";

const VIEW_WIDTH = 900;
const VIEW_HEIGHT = 320;
const PAD_LEFT = 72;
const PAD_RIGHT = 20;
const PAD_TOP = 22;
const PAD_BOTTOM = 48;
const PLOT_WIDTH = VIEW_WIDTH - PAD_LEFT - PAD_RIGHT;
const PLOT_HEIGHT = VIEW_HEIGHT - PAD_TOP - PAD_BOTTOM;
const MAX_CHART_ROWS = 160;

type ArticleParameterValues = Record<string, AnalysisParameterValue>;
export type AnalysisArticleVisualizationMode = "interactive" | "snapshot";

function configString(block: AnalysisBlock, key: string): string | null {
  const value = block.config[key];
  return typeof value === "string" ? value : null;
}

function configStrings(block: AnalysisBlock, key: string): string[] {
  const value = block.config[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function configBoolean(block: AnalysisBlock, key: string): boolean {
  return block.config[key] === true;
}

function configNumber(block: AnalysisBlock, key: string): number | null {
  const value = block.config[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function numberFormat(block: AnalysisBlock): AnalysisNumberFormat {
  const candidate = block.config.format;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return { style: "number", decimals: 2, currency: null };
  }
  const value = candidate as Record<string, unknown>;
  const style = ["number", "percent", "currency", "duration", "compact"].includes(
    String(value.style),
  )
    ? (value.style as AnalysisNumberFormat["style"])
    : "number";
  const decimals = typeof value.decimals === "number"
    ? Math.max(0, Math.min(8, Math.trunc(value.decimals)))
    : 2;
  const currency = typeof value.currency === "string" ? value.currency : null;
  return { style, decimals, currency };
}

function numberValue(value: AnalysisParameterValue): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function textValue(value: AnalysisParameterValue): string {
  if (value === null) return "NULL";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

function shortValue(value: AnalysisParameterValue): string {
  const text = textValue(value);
  return text.length > 18 ? `${text.slice(0, 17)}…` : text;
}

function formatNumber(value: number, format: AnalysisNumberFormat): string {
  if (format.style === "duration") {
    const absolute = Math.abs(value);
    if (absolute >= 86_400) return `${(value / 86_400).toFixed(format.decimals)}d`;
    if (absolute >= 3_600) return `${(value / 3_600).toFixed(format.decimals)}h`;
    if (absolute >= 60) return `${(value / 60).toFixed(format.decimals)}m`;
    return `${value.toFixed(format.decimals)}s`;
  }
  const options: Intl.NumberFormatOptions = {
    maximumFractionDigits: format.decimals,
    minimumFractionDigits: format.decimals,
  };
  if (format.style === "percent") options.style = "percent";
  if (format.style === "compact") options.notation = "compact";
  if (format.style === "currency" && format.currency) {
    options.style = "currency";
    options.currency = format.currency;
  }
  return new Intl.NumberFormat(undefined, options).format(value);
}

function formatCell(value: AnalysisParameterValue, format?: AnalysisNumberFormat): string {
  const numeric = numberValue(value);
  if (numeric !== null) {
    return formatNumber(numeric, format ?? { style: "number", decimals: 2, currency: null });
  }
  return textValue(value);
}

function columnIndex(data: AnalysisBlockData, name: string | null): number {
  if (!name) return -1;
  return data.columns.findIndex((column) => column.name === name);
}

function seriesColor(index: number): string {
  if (index === 0) return "var(--ds-chart-series-1)";
  if (index === 1) return "var(--ds-chart-series-2)";
  if (index === 2) return "var(--ds-chart-series-3)";
  return "var(--ds-chart-series-fallback)";
}

function bounds(values: number[], includeZero: boolean) {
  if (values.length === 0) return { min: 0, max: 1 };
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (includeZero) {
    min = Math.min(0, min);
    max = Math.max(0, max);
  }
  if (min === max) {
    min -= Math.max(1, Math.abs(min) * 0.05);
    max += Math.max(1, Math.abs(max) * 0.05);
  }
  const padding = (max - min) * 0.06;
  return { min: min - padding, max: max + padding };
}

function yPosition(value: number, min: number, max: number) {
  return PAD_TOP + PLOT_HEIGHT - ((value - min) / (max - min)) * PLOT_HEIGHT;
}

function ChartAxis({ min, max, format }: {
  min: number;
  max: number;
  format: AnalysisNumberFormat;
}) {
  return (
    <g aria-hidden="true">
      {[0, 1, 2, 3, 4].map((step) => {
        const ratio = step / 4;
        const y = PAD_TOP + PLOT_HEIGHT * ratio;
        const value = max - (max - min) * ratio;
        return (
          <g key={step}>
            <line
              className="tw:stroke-border-subtle tw:[stroke-width:var(--ds-border-width)] tw:[vector-effect:non-scaling-stroke]"
              x1={PAD_LEFT}
              x2={VIEW_WIDTH - PAD_RIGHT}
              y1={y}
              y2={y}
            />
            <text
              className="tw:fill-muted-foreground tw:font-mono tw:text-2xs tw:tabular-nums"
              x={PAD_LEFT - 8}
              y={y + 4}
              textAnchor="end"
            >
              {formatNumber(value, { ...format, decimals: Math.min(format.decimals, 2) })}
            </text>
          </g>
        );
      })}
    </g>
  );
}

function ChartLabels({ data, xIndex }: { data: AnalysisBlockData; xIndex: number }) {
  const rows = data.rows.slice(0, MAX_CHART_ROWS);
  if (rows.length === 0 || xIndex < 0) return null;
  const count = Math.min(6, rows.length);
  const indexes = Array.from({ length: count }, (_, index) =>
    Math.round((index * (rows.length - 1)) / Math.max(1, count - 1)),
  );
  return (
    <g aria-hidden="true">
      {[...new Set(indexes)].map((index) => {
        const x = PAD_LEFT + (index / Math.max(1, rows.length - 1)) * PLOT_WIDTH;
        return (
          <text
            key={index}
            className="tw:fill-muted-foreground tw:font-mono tw:text-2xs"
            x={x}
            y={VIEW_HEIGHT - 18}
            textAnchor={index === 0 ? "start" : index === rows.length - 1 ? "end" : "middle"}
          >
            {shortValue(rows[index]?.[xIndex] ?? null)}
          </text>
        );
      })}
    </g>
  );
}

type ChartSeries = {
  key: string;
  label: string;
  values: Array<number | null>;
};

function chartSeries(block: AnalysisBlock, data: AnalysisBlockData): ChartSeries[] {
  const rows = data.rows.slice(0, MAX_CHART_ROWS);
  const yColumns = configStrings(block, "yColumns");
  const seriesIndex = columnIndex(data, configString(block, "seriesColumn"));
  if (seriesIndex < 0) {
    return yColumns.map((column) => {
      const index = columnIndex(data, column);
      return {
        key: column,
        label: column,
        values: rows.map((row) => numberValue(row[index] ?? null)),
      };
    });
  }
  const labels = [...new Set(rows.map((row) => textValue(row[seriesIndex] ?? null)))].slice(0, 12);
  return labels.flatMap((label) =>
    yColumns.map((column) => {
      const yIndex = columnIndex(data, column);
      return {
        key: `${label}:${column}`,
        label: yColumns.length === 1 ? label : `${label} · ${column}`,
        values: rows.map((row) =>
          textValue(row[seriesIndex] ?? null) === label
            ? numberValue(row[yIndex] ?? null)
            : null,
        ),
      };
    }),
  );
}

function ChartLegend({ series }: { series: ChartSeries[] }) {
  return (
    <div className="tw:flex tw:min-w-0 tw:flex-wrap tw:items-center tw:gap-3 tw:text-xs tw:text-muted-foreground">
      {series.map((item, index) => (
        <span className="tw:inline-flex tw:min-w-0 tw:items-center tw:gap-1.5" key={item.key}>
          <i
            aria-hidden="true"
            className="tw:h-0.5 tw:w-3 tw:shrink-0 tw:rounded-full"
            style={{ backgroundColor: seriesColor(index) }}
          />
          <span className="tw:truncate">{item.label}</span>
        </span>
      ))}
    </div>
  );
}

function CartesianChart({ block, data }: { block: AnalysisBlock; data: AnalysisBlockData }) {
  const rows = data.rows.slice(0, MAX_CHART_ROWS);
  const xIndex = columnIndex(data, configString(block, "xColumn"));
  const series = chartSeries(block, data);
  const values = series.flatMap((item) => item.values.filter((value): value is number => value !== null));
  const format = numberFormat(block);
  const { min, max } = bounds(values, block.kind === "bar" || block.kind === "area");
  const baseline = yPosition(Math.max(min, Math.min(max, 0)), min, max);
  const barGroupWidth = PLOT_WIDTH / Math.max(1, rows.length);
  const barWidth = Math.max(1, (barGroupWidth * 0.78) / Math.max(1, series.length));

  return (
    <figure className="tw:m-0 tw:grid tw:min-w-0 tw:gap-3" aria-label={block.title || block.kind}>
      <ChartLegend series={series} />
      <svg
        className="tw:max-h-[380px] tw:min-h-[230px] tw:w-full tw:overflow-visible tw:rounded-md tw:border tw:border-border-subtle tw:bg-muted"
        role="img"
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
      >
        <title>{block.title || block.kind.replace(/_/g, " ")}</title>
        <ChartAxis min={min} max={max} format={format} />
        {block.kind === "bar" ? series.flatMap((item, seriesIndex) =>
          item.values.map((value, rowIndex) => {
            if (value === null) return null;
            const y = yPosition(value, min, max);
            return (
              <rect
                key={`${item.key}:${rowIndex}`}
                x={PAD_LEFT + rowIndex * barGroupWidth + barGroupWidth * 0.11 + seriesIndex * barWidth}
                y={Math.min(y, baseline)}
                width={barWidth}
                height={Math.max(1, Math.abs(baseline - y))}
                fill={seriesColor(seriesIndex)}
                opacity={0.88}
              />
            );
          }),
        ) : series.map((item, seriesIndex) => {
          const points = item.values.flatMap((value, rowIndex) =>
            value === null
              ? []
              : [[
                  PAD_LEFT + (rowIndex / Math.max(1, rows.length - 1)) * PLOT_WIDTH,
                  yPosition(value, min, max),
                ] as const],
          );
          if (block.kind === "scatter") {
            return points.map(([x, y], index) => (
              <circle
                key={`${item.key}:${index}`}
                cx={x}
                cy={y}
                r={4}
                fill={seriesColor(seriesIndex)}
                opacity={0.88}
              />
            ));
          }
          const polyline = points.map(([x, y]) => `${x},${y}`).join(" ");
          return (
            <g key={item.key}>
              {block.kind === "area" && points.length > 1 ? (
                <polygon
                  points={`${points[0]![0]},${baseline} ${polyline} ${points[points.length - 1]![0]},${baseline}`}
                  fill={seriesColor(seriesIndex)}
                  opacity={configBoolean(block, "stacked") ? 0.22 : 0.14}
                />
              ) : null}
              <polyline
                points={polyline}
                fill="none"
                stroke={seriesColor(seriesIndex)}
                strokeWidth={seriesIndex === 0 ? 3 : 2}
                strokeDasharray={seriesIndex > 2 ? "6 4" : undefined}
                vectorEffect="non-scaling-stroke"
              />
            </g>
          );
        })}
        <ChartLabels data={{ ...data, rows }} xIndex={xIndex} />
      </svg>
    </figure>
  );
}

function MetricBlock({ block, data, metric }: {
  block: AnalysisBlock;
  data: AnalysisBlockData;
  metric: AnalysisMetric | null;
}) {
  const valueIndex = columnIndex(data, metric?.valueColumn ?? null);
  const value = data.rows[0]?.[valueIndex] ?? null;
  const comparisonColumn = configString(block, "comparisonColumn");
  const comparisonIndex = columnIndex(data, comparisonColumn);
  const comparison = numberValue(data.rows[0]?.[comparisonIndex] ?? null);
  const format = metric?.format ?? { style: "number", decimals: 2, currency: null };
  const numeric = numberValue(value);
  const favorable = comparison !== null && metric?.lowerIsBetter !== null
    ? metric?.lowerIsBetter ? comparison <= 0 : comparison >= 0
    : null;
  return (
    <div className="tw:grid tw:min-h-28 tw:content-center tw:gap-1">
      <span className="tw:text-xs tw:text-muted-foreground">{metric?.label ?? block.title}</span>
      <strong className="tw:min-w-0 tw:truncate tw:text-[clamp(1.5rem,4cqi,2.5rem)] tw:font-semibold tw:tracking-tight tw:tabular-nums">
        {numeric === null ? textValue(value) : formatNumber(numeric, format)}
      </strong>
      {comparison !== null ? (
        <span
          data-favorable={favorable === true}
          data-unfavorable={favorable === false}
          className="tw:inline-flex tw:items-center tw:gap-1 tw:text-xs tw:text-muted-foreground tw:data-[favorable=true]:text-success tw:data-[unfavorable=true]:text-danger"
        >
          <Icon name={comparison >= 0 ? "caretUp" : "caretDown"} />
          {formatNumber(Math.abs(comparison), { style: "percent", decimals: 1, currency: null })}
        </span>
      ) : metric?.description ? (
        <span className="tw:text-xs tw:leading-body tw:text-muted-foreground">{metric.description}</span>
      ) : null}
    </div>
  );
}

function TableBlock({ block, data }: { block: AnalysisBlock; data: AnalysisBlockData }) {
  const { t } = useI18n();
  const requestedPageSize = configNumber(block, "pageSize") ?? 50;
  const pageSize = Math.max(10, Math.min(500, Math.trunc(requestedPageSize)));
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(data.rows.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const rows = data.rows.slice(safePage * pageSize, (safePage + 1) * pageSize);
  return (
    <div className="tw:grid tw:min-w-0 tw:gap-2">
      <div className="scrollbar-sleek tw:max-h-[520px] tw:min-w-0 tw:overflow-auto tw:rounded-md tw:border tw:border-border-subtle">
        <table className="tw:w-full tw:min-w-max tw:border-collapse tw:text-left tw:text-xs">
          <thead className="tw:sticky tw:top-0 tw:z-[var(--ds-z-raised)] tw:bg-card">
            <tr>
              {data.columns.map((column) => (
                <th className="tw:border-b tw:border-r tw:border-border-subtle tw:px-2 tw:py-1.5 tw:font-medium tw:text-muted-foreground tw:last:border-r-0" key={column.name}>
                  {column.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr className="tw:odd:bg-secondary/25" key={safePage * pageSize + rowIndex}>
                {data.columns.map((column, columnIndexValue) => (
                  <td
                    className="tw:max-w-[420px] tw:truncate tw:border-r tw:border-b tw:border-border-subtle tw:px-2 tw:py-1.5 tw:font-mono tw:tabular-nums tw:last:border-r-0"
                    key={column.name}
                    title={textValue(row[columnIndexValue] ?? null)}
                  >
                    {formatCell(row[columnIndexValue] ?? null)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pageCount > 1 ? (
        <div className="tw:flex tw:items-center tw:justify-end tw:gap-2 tw:text-xs tw:text-muted-foreground">
          <Button iconOnly size="xs" variant="ghost" disabled={safePage === 0} title={t("analysis.tablePrevious")} onClick={() => setPage((value) => Math.max(0, value - 1))}>
            <Icon name="chevronRight" className="tw:rotate-180" />
          </Button>
          <span className="tw:font-mono tw:tabular-nums">{safePage + 1} / {pageCount}</span>
          <Button iconOnly size="xs" variant="ghost" disabled={safePage + 1 >= pageCount} title={t("analysis.tableNext")} onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))}>
            <Icon name="chevronRight" />
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function FunnelBlock({ block, data }: { block: AnalysisBlock; data: AnalysisBlockData }) {
  const stageIndex = columnIndex(data, configString(block, "stageColumn"));
  const valueIndex = columnIndex(data, configString(block, "valueColumn"));
  const rateIndex = columnIndex(data, configString(block, "rateColumn"));
  const format = numberFormat(block);
  const maximum = Math.max(1, ...data.rows.map((row) => numberValue(row[valueIndex] ?? null) ?? 0));
  return (
    <ol className="tw:m-0 tw:grid tw:list-none tw:gap-2 tw:p-0">
      {data.rows.slice(0, 32).map((row, index) => {
        const value = numberValue(row[valueIndex] ?? null) ?? 0;
        const rate = numberValue(row[rateIndex] ?? null);
        return (
          <li className="tw:grid tw:grid-cols-[minmax(100px,0.8fr)_minmax(140px,2fr)_auto] tw:items-center tw:gap-3 tw:@max-[520px]:grid-cols-[minmax(80px,1fr)_2fr]" key={`${textValue(row[stageIndex] ?? null)}:${index}`}>
            <span className="tw:min-w-0 tw:truncate tw:text-xs tw:font-medium">{textValue(row[stageIndex] ?? null)}</span>
            <span className="tw:h-6 tw:overflow-hidden tw:rounded-xs tw:bg-muted">
              <span
                className="tw:block tw:h-full tw:min-w-px tw:bg-[var(--ds-chart-series-1)]"
                style={{ width: `${Math.max(0, Math.min(100, (value / maximum) * 100))}%` }}
              />
            </span>
            <span className="tw:text-right tw:font-mono tw:text-xs tw:tabular-nums tw:@max-[520px]:col-start-2">
              {formatNumber(value, format)}{rate === null ? "" : ` · ${formatNumber(rate, { style: "percent", decimals: 1, currency: null })}`}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function MatrixBlock({ block, data }: { block: AnalysisBlock; data: AnalysisBlockData }) {
  const xColumn = block.kind === "retention_cohort" ? "periodColumn" : "xColumn";
  const yColumn = block.kind === "retention_cohort" ? "cohortColumn" : "yColumn";
  const xIndex = columnIndex(data, configString(block, xColumn));
  const yIndex = columnIndex(data, configString(block, yColumn));
  const valueIndex = columnIndex(data, configString(block, "valueColumn"));
  const xs = [...new Set(data.rows.map((row) => textValue(row[xIndex] ?? null)))].slice(0, 64);
  const ys = [...new Set(data.rows.map((row) => textValue(row[yIndex] ?? null)))].slice(0, 128);
  const cells = new Map(data.rows.map((row) => [
    `${textValue(row[yIndex] ?? null)}\u0000${textValue(row[xIndex] ?? null)}`,
    numberValue(row[valueIndex] ?? null),
  ]));
  const values = [...cells.values()].filter((value): value is number => value !== null);
  const low = values.length ? Math.min(...values) : 0;
  const high = values.length ? Math.max(...values) : 1;
  const format = numberFormat(block);
  return (
    <div className="scrollbar-sleek tw:min-w-0 tw:overflow-auto tw:rounded-md tw:border tw:border-border-subtle">
      <table className="tw:w-full tw:min-w-max tw:border-collapse tw:text-xs">
        <thead>
          <tr>
            <th className="tw:sticky tw:left-0 tw:z-[var(--ds-z-raised)] tw:border-r tw:border-b tw:border-border-subtle tw:bg-card tw:px-2 tw:py-1.5" />
            {xs.map((x) => <th className="tw:border-r tw:border-b tw:border-border-subtle tw:px-2 tw:py-1.5 tw:font-medium tw:text-muted-foreground" key={x}>{x}</th>)}
          </tr>
        </thead>
        <tbody>
          {ys.map((y) => (
            <tr key={y}>
              <th className="tw:sticky tw:left-0 tw:z-[var(--ds-z-raised)] tw:border-r tw:border-b tw:border-border-subtle tw:bg-card tw:px-2 tw:py-1.5 tw:text-left tw:font-medium">{y}</th>
              {xs.map((x) => {
                const value = cells.get(`${y}\u0000${x}`) ?? null;
                const ratio = value === null ? 0 : (value - low) / Math.max(1e-12, high - low);
                return (
                  <td className="tw:relative tw:border-r tw:border-b tw:border-border-subtle tw:px-2 tw:py-1.5 tw:text-center tw:font-mono tw:tabular-nums" key={x}>
                    {value !== null ? <span aria-hidden="true" className="tw:absolute tw:inset-0 tw:bg-[var(--ds-chart-series-1)]" style={{ opacity: 0.08 + ratio * 0.72 }} /> : null}
                    <span className="tw:relative">{value === null ? "—" : formatNumber(value, format)}</span>
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

function ParameterField({ parameter, value, onChange }: {
  parameter: AnalysisParameter;
  value: AnalysisParameterValue;
  onChange: (value: AnalysisParameterValue) => void;
}) {
  const { t } = useI18n();
  if (parameter.type === "boolean") {
    return (
      <CheckboxField
        label={parameter.label}
        checked={value === true}
        onChange={(event) => onChange(event.target.checked)}
      />
    );
  }
  if (parameter.type === "enum") {
    return (
      <Field label={parameter.label}>
        <SelectInput density="compact" value={typeof value === "string" ? value : ""} onChange={(event) => onChange(event.target.value)}>
          {!parameter.required ? <option value="">{t("analysis.parameterAny")}</option> : null}
          {parameter.options.map((option) => <option key={option}>{option}</option>)}
        </SelectInput>
      </Field>
    );
  }
  return (
    <Field label={parameter.label}>
      <TextInput
        density="compact"
        type={parameter.type === "number" ? "number" : parameter.type === "datetime" ? "datetime-local" : parameter.type === "date" ? "date" : "text"}
        value={value === null ? "" : String(value)}
        required={parameter.required}
        onChange={(event) => {
          if (event.target.value === "" && !parameter.required) onChange(null);
          else if (parameter.type === "number") onChange(event.target.valueAsNumber);
          else onChange(event.target.value);
        }}
      />
    </Field>
  );
}

export function AnalysisSnapshotParameterField({
  parameter,
  value,
}: {
  parameter: AnalysisParameter;
  value: AnalysisParameterValue;
}) {
  return (
    <div className="tw:grid tw:gap-0.5">
      <span className="tw:text-xs tw:text-muted-foreground">
        {parameter.label}
      </span>
      <span className="tw:min-h-control-sm tw:rounded-sm tw:border tw:border-border-subtle tw:bg-muted tw:px-2 tw:py-1 tw:font-mono tw:text-sm">
        {textValue(value)}
      </span>
    </div>
  );
}

function ControlBlock({ block, definition, values, mode, onParameterChange }: {
  block: AnalysisBlock;
  definition: AnalysisArticleDefinition;
  values: ArticleParameterValues;
  mode: AnalysisArticleVisualizationMode;
  onParameterChange?: (id: string, value: AnalysisParameterValue) => void;
}) {
  const ids = configStrings(block, "parameterIds");
  const parameters = ids.flatMap((id) => {
    const parameter = definition.parameters.find((candidate) => candidate.id === id);
    return parameter ? [parameter] : [];
  });
  return (
    <div className="tw:grid tw:grid-cols-[repeat(auto-fit,minmax(160px,1fr))] tw:gap-3">
      {parameters.map((parameter) => {
        const value = values[parameter.id] ?? parameter.defaultValue;
        return mode === "snapshot" ? (
          <AnalysisSnapshotParameterField
            key={parameter.id}
            parameter={parameter}
            value={value}
          />
        ) : (
          <ParameterField
            key={parameter.id}
            parameter={parameter}
            value={value}
            onChange={(nextValue) =>
              onParameterChange?.(parameter.id, nextValue)
            }
          />
        );
      })}
    </div>
  );
}

function DataBlock({ block, data, definition }: {
  block: AnalysisBlock;
  data: AnalysisBlockData | undefined;
  definition: AnalysisArticleDefinition;
}) {
  const { t } = useI18n();
  if (!data) {
    return (
      <div className="tw:flex tw:min-h-28 tw:items-center tw:justify-center tw:text-sm tw:text-muted-foreground">
        {t("analysis.visualizationRunFirst")}
      </div>
    );
  }
  if (block.kind === "metric") {
    const metricId = configString(block, "metricId");
    const metric = definition.metrics.find((candidate) => candidate.id === metricId) ?? null;
    return <MetricBlock block={block} data={data} metric={metric} />;
  }
  if (["time_series", "bar", "area", "scatter"].includes(block.kind)) {
    return <CartesianChart block={block} data={data} />;
  }
  if (block.kind === "table") return <TableBlock block={block} data={data} />;
  if (block.kind === "funnel") return <FunnelBlock block={block} data={data} />;
  if (block.kind === "retention_cohort" || block.kind === "heatmap") {
    return <MatrixBlock block={block} data={data} />;
  }
  return null;
}

function narrativeBlock(
  block: AnalysisBlock,
  richTextLabels: Parameters<typeof AgentRichText>[0]["labels"],
): ReactNode {
  if (block.kind === "heading") {
    const text = configString(block, "text") ?? block.title;
    const level = configNumber(block, "level") ?? 2;
    if (level === 1) return <h2 className="tw:m-0 tw:text-heading tw:font-semibold tw:tracking-tight">{text}</h2>;
    if (level === 3) return <h4 className="tw:m-0 tw:text-base tw:font-semibold">{text}</h4>;
    return <h3 className="tw:m-0 tw:text-title tw:font-semibold tw:tracking-tight">{text}</h3>;
  }
  if (block.kind === "markdown") {
    return (
      <AgentRichText
        labels={richTextLabels}
        text={configString(block, "markdown") ?? ""}
        onOpenLink={(href) => void openUrl(href)}
      />
    );
  }
  if (block.kind === "callout") {
    const tone = configString(block, "tone");
    const safeTone = tone === "success" || tone === "warning" || tone === "danger" ? tone : "info";
    return (
      <div
        data-tone={safeTone}
        className="tw:rounded-sm tw:border tw:border-border-subtle tw:bg-muted tw:p-3 tw:data-[tone=danger]:border-danger-border tw:data-[tone=danger]:bg-danger-muted tw:data-[tone=success]:border-success tw:data-[tone=warning]:border-warning"
        role={safeTone === "danger" ? "alert" : "note"}
      >
        <AgentRichText
          labels={richTextLabels}
          text={configString(block, "markdown") ?? ""}
          onOpenLink={(href) => void openUrl(href)}
        />
      </div>
    );
  }
  if (block.kind === "divider") return <hr className="tw:m-0 tw:border-0 tw:border-t tw:border-border-subtle" />;
  return null;
}

export function AnalysisArticleVisualization({
  definition,
  data,
  parameterValues,
  mode,
  onParameterChange,
}: {
  definition: AnalysisArticleDefinition;
  data: ReadonlyMap<string, AnalysisBlockData>;
  parameterValues: ArticleParameterValues;
} & (
  | {
      mode: "interactive";
      onParameterChange: (id: string, value: AnalysisParameterValue) => void;
    }
  | { mode: "snapshot"; onParameterChange?: never }
)) {
  const { t } = useI18n();
  const richTextLabels = {
    copied: t("agent.acpCopied"),
    copyCode: t("agent.acpCopyCode"),
    diagram: t("agent.acpDiagram"),
    diagramError: t("agent.acpDiagramError"),
    diagramLoading: t("agent.acpDiagramLoading"),
    diagramSource: t("agent.acpDiagramSource"),
    imageOmitted: t("agent.acpImageOmitted"),
    openLink: t("agent.acpOpenLink"),
    plainTextFallback: t("agent.acpPlainTextFallback"),
  };
  const blocks = useMemo(() => definition.blocks, [definition.blocks]);
  return (
    <div className="tw:grid tw:grid-cols-12 tw:items-start tw:gap-3">
      {blocks.map((block) => {
        const narrative = narrativeBlock(block, richTextLabels);
        const control = ["date_range_control", "comparison_control", "segment_control"].includes(block.kind);
        return (
          <section
            key={block.id}
            data-width={Math.max(1, Math.min(12, Math.trunc(block.width)))}
            className="tw:col-span-12 tw:grid tw:min-w-0 tw:gap-2 tw:rounded-md tw:border tw:border-border-subtle tw:bg-card tw:p-4 tw:data-[width=1]:col-span-1 tw:data-[width=2]:col-span-2 tw:data-[width=3]:col-span-3 tw:data-[width=4]:col-span-4 tw:data-[width=5]:col-span-5 tw:data-[width=6]:col-span-6 tw:data-[width=7]:col-span-7 tw:data-[width=8]:col-span-8 tw:data-[width=9]:col-span-9 tw:data-[width=10]:col-span-10 tw:data-[width=11]:col-span-11 tw:data-[width=12]:col-span-12 tw:@max-[760px]:col-span-12"
          >
            {block.title && !narrative && block.kind !== "metric" ? (
              <h3 className="tw:m-0 tw:text-sm tw:font-semibold">{block.title}</h3>
            ) : null}
            {narrative}
            {narrative ? null : control ? (
              <ControlBlock
                block={block}
                definition={definition}
                values={parameterValues}
                mode={mode}
                onParameterChange={onParameterChange}
              />
            ) : (
              <DataBlock block={block} data={data.get(block.id)} definition={definition} />
            )}
            {data.get(block.id)?.truncated ? (
              <span className="tw:text-2xs tw:text-warning">{t("analysis.resultTruncated")}</span>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
