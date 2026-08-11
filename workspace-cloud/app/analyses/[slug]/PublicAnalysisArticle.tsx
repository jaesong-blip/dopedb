import type {
  AnalysisPublicSnapshot,
} from "../../../lib/workspace-analysis-publications";
import type { AnalysisResultFragmentPayload } from "../../../lib/workspace-analysis-runs";

type Cell = string | number | boolean | null;
type PublicBlock = AnalysisPublicSnapshot["blocks"][number];
type BlockData = {
  columns: AnalysisResultFragmentPayload["columns"];
  rows: readonly (readonly Cell[])[];
  truncated: boolean;
};

const WIDTH = 900;
const HEIGHT = 320;
const LEFT = 72;
const RIGHT = 20;
const TOP = 22;
const BOTTOM = 48;
const PLOT_WIDTH = WIDTH - LEFT - RIGHT;
const PLOT_HEIGHT = HEIGHT - TOP - BOTTOM;

function blockData(block: PublicBlock): BlockData | null {
  if (block.fragments.length === 0) return null;
  const fragments = [...block.fragments].sort((left, right) => left.ordinal - right.ordinal);
  return {
    columns: fragments[0]?.columns ?? [],
    rows: fragments.flatMap((fragment) => fragment.rows),
    truncated: fragments.some((fragment) => fragment.truncated),
  };
}

function stringConfig(block: PublicBlock, key: string) {
  const value = block.config[key];
  return typeof value === "string" ? value : null;
}

function stringArrayConfig(block: PublicBlock, key: string) {
  const value = block.config[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function numeric(value: Cell): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function text(value: Cell): string {
  if (value === null) return "—";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

function short(value: Cell) {
  const valueText = text(value);
  return valueText.length > 18 ? `${valueText.slice(0, 17)}…` : valueText;
}

type NumberFormat = {
  style: "number" | "percent" | "currency" | "duration" | "compact";
  decimals: number;
  currency: string | null;
};

function formatFrom(value: unknown): NumberFormat {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { style: "number", decimals: 2, currency: null };
  }
  const row = value as Record<string, unknown>;
  const style = ["number", "percent", "currency", "duration", "compact"].includes(String(row.style))
    ? row.style as NumberFormat["style"] : "number";
  return {
    style,
    decimals: typeof row.decimals === "number" ? Math.max(0, Math.min(8, Math.trunc(row.decimals))) : 2,
    currency: typeof row.currency === "string" ? row.currency : null,
  };
}

function formatNumber(value: number, format: NumberFormat) {
  if (format.style === "duration") {
    if (Math.abs(value) >= 86_400) return `${(value / 86_400).toFixed(format.decimals)}d`;
    if (Math.abs(value) >= 3_600) return `${(value / 3_600).toFixed(format.decimals)}h`;
    if (Math.abs(value) >= 60) return `${(value / 60).toFixed(format.decimals)}m`;
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

function column(data: BlockData, name: string | null) {
  return name ? data.columns.findIndex((candidate) => candidate.name === name) : -1;
}

function color(index: number) {
  if (index === 0) return "var(--ds-chart-series-1)";
  if (index === 1) return "var(--ds-chart-series-2)";
  if (index === 2) return "var(--ds-chart-series-3)";
  return "var(--ds-text-muted)";
}

function range(values: number[], includeZero: boolean) {
  if (!values.length) return { min: 0, max: 1 };
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
  const pad = (max - min) * 0.06;
  return { min: min - pad, max: max + pad };
}

function y(value: number, min: number, max: number) {
  return TOP + PLOT_HEIGHT - ((value - min) / (max - min)) * PLOT_HEIGHT;
}

function SafeNarrative({ markdown }: { markdown: string }) {
  const lines = markdown.split(/\r?\n/).slice(0, 1_000);
  return (
    <div className="tw:grid tw:gap-2 tw:text-sm tw:leading-body">
      {lines.map((line, index) => {
        if (line.startsWith("### ")) return <h4 className="tw:text-sm tw:font-semibold" key={index}>{line.slice(4)}</h4>;
        if (line.startsWith("## ")) return <h3 className="tw:text-base tw:font-semibold" key={index}>{line.slice(3)}</h3>;
        if (line.startsWith("# ")) return <h2 className="tw:font-serif tw:text-2xl tw:font-medium" key={index}>{line.slice(2)}</h2>;
        if (/^[-*] /.test(line)) return <p className="tw:pl-4 tw:before:mr-2 tw:before:content-['•']" key={index}>{line.slice(2)}</p>;
        if (!line.trim()) return <span className="tw:h-1" aria-hidden="true" key={index} />;
        return <p key={index}>{line}</p>;
      })}
    </div>
  );
}

function Metric({ block, data }: { block: PublicBlock; data: BlockData }) {
  const publicMetric = block.config.publicMetric && typeof block.config.publicMetric === "object"
    && !Array.isArray(block.config.publicMetric)
    ? block.config.publicMetric as Record<string, unknown> : {};
  const valueIndex = column(data, typeof publicMetric.valueColumn === "string" ? publicMetric.valueColumn : data.columns[0]?.name ?? null);
  const value = data.rows[0]?.[valueIndex] ?? null;
  const valueNumber = numeric(value);
  const format = formatFrom(publicMetric.format);
  return (
    <div className="tw:grid tw:min-h-28 tw:content-center tw:gap-1">
      <span className="tw:text-xs tw:text-muted-foreground">{typeof publicMetric.label === "string" ? publicMetric.label : block.title}</span>
      <strong className="tw:text-4xl tw:font-semibold tw:tracking-[-0.03em] tw:tabular-nums">
        {valueNumber === null ? text(value) : formatNumber(valueNumber, format)}
      </strong>
      {typeof publicMetric.description === "string" && publicMetric.description ? (
        <span className="tw:text-xs tw:leading-body tw:text-muted-foreground">{publicMetric.description}</span>
      ) : null}
    </div>
  );
}

function Chart({ block, data }: { block: PublicBlock; data: BlockData }) {
  const rows = data.rows.slice(0, 160);
  const xIndex = column(data, stringConfig(block, "xColumn"));
  const yColumns = stringArrayConfig(block, "yColumns");
  const series = yColumns.map((name) => {
    const index = column(data, name);
    return { name, values: rows.map((row) => numeric(row[index] ?? null)) };
  });
  const values = series.flatMap((item) => item.values.filter((value): value is number => value !== null));
  const format = formatFrom(block.config.format);
  const { min, max } = range(values, block.kind === "bar" || block.kind === "area");
  const baseline = y(Math.max(min, Math.min(max, 0)), min, max);
  const groupWidth = PLOT_WIDTH / Math.max(1, rows.length);
  const barWidth = Math.max(1, groupWidth * 0.78 / Math.max(1, series.length));
  return (
    <figure className="tw:m-0 tw:grid tw:gap-3">
      <div className="tw:flex tw:flex-wrap tw:gap-3 tw:text-xs tw:text-muted-foreground">
        {series.map((item, index) => (
          <span className="tw:inline-flex tw:items-center tw:gap-1.5" key={item.name}>
            <i className="tw:h-0.5 tw:w-3 tw:rounded-full" style={{ backgroundColor: color(index) }} />
            {item.name}
          </span>
        ))}
      </div>
      <svg className="tw:min-h-[230px] tw:w-full tw:rounded-surface tw:border tw:border-border tw:bg-surface-inset" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={`${block.title}: ${series.length} series across ${rows.length} observations`}>
        <title>{block.title}</title>
        <desc>{series.map((item) => item.name).join(", ") || "No numeric series"}</desc>
        {[0, 1, 2, 3, 4].map((step) => {
          const ratio = step / 4;
          const yPosition = TOP + PLOT_HEIGHT * ratio;
          return (
            <g key={step}>
              <line x1={LEFT} x2={WIDTH - RIGHT} y1={yPosition} y2={yPosition} stroke="var(--ds-border)" />
              <text x={LEFT - 8} y={yPosition + 4} textAnchor="end" fill="var(--ds-text-muted)" fontSize="11" fontFamily="var(--font-workspace-mono)">
                {formatNumber(max - (max - min) * ratio, { ...format, decimals: Math.min(format.decimals, 2) })}
              </text>
            </g>
          );
        })}
        {block.kind === "bar" ? series.flatMap((item, seriesIndex) => item.values.map((value, rowIndex) => {
          if (value === null) return null;
          const top = y(value, min, max);
          return <rect key={`${item.name}:${rowIndex}`} x={LEFT + rowIndex * groupWidth + groupWidth * 0.11 + seriesIndex * barWidth} y={Math.min(top, baseline)} width={barWidth} height={Math.max(1, Math.abs(top - baseline))} fill={color(seriesIndex)} opacity="0.88" />;
        })) : series.map((item, seriesIndex) => {
          const points = item.values.flatMap((value, index) => value === null ? [] : [[
            LEFT + index / Math.max(1, rows.length - 1) * PLOT_WIDTH,
            y(value, min, max),
          ] as const]);
          if (block.kind === "scatter") return points.map(([cx, cy], index) => <circle key={`${item.name}:${index}`} cx={cx} cy={cy} r="4" fill={color(seriesIndex)} />);
          const line = points.map(([xValue, yValue]) => `${xValue},${yValue}`).join(" ");
          return (
            <g key={item.name}>
              {block.kind === "area" && points.length > 1 ? <polygon points={`${points[0]![0]},${baseline} ${line} ${points[points.length - 1]![0]},${baseline}`} fill={color(seriesIndex)} opacity="0.14" /> : null}
              <polyline points={line} fill="none" stroke={color(seriesIndex)} strokeWidth={seriesIndex === 0 ? 3 : 2} />
            </g>
          );
        })}
        {rows.length && xIndex >= 0 ? [0, Math.floor((rows.length - 1) / 2), rows.length - 1].map((index) => (
          <text key={index} x={LEFT + index / Math.max(1, rows.length - 1) * PLOT_WIDTH} y={HEIGHT - 18} textAnchor={index === 0 ? "start" : index === rows.length - 1 ? "end" : "middle"} fill="var(--ds-text-muted)" fontSize="11" fontFamily="var(--font-workspace-mono)">
            {short(rows[index]?.[xIndex] ?? null)}
          </text>
        )) : null}
      </svg>
    </figure>
  );
}

function Table({ data, title }: { data: BlockData; title: string }) {
  return (
    <div className="tw:max-h-[520px] tw:overflow-auto tw:rounded-surface tw:border tw:border-border">
      <table className="tw:w-full tw:min-w-max tw:border-collapse tw:text-left tw:text-xs">
        <caption className="tw:sr-only">{title}</caption>
        <thead className="tw:sticky tw:top-0 tw:bg-surface">
          <tr>{data.columns.map((column) => <th className="tw:border-r tw:border-b tw:border-border tw:px-2 tw:py-1.5 tw:font-medium tw:text-muted-foreground" key={column.name}>{column.name}</th>)}</tr>
        </thead>
        <tbody>{data.rows.slice(0, 500).map((row, rowIndex) => (
          <tr className="tw:odd:bg-surface-inset" key={rowIndex}>{data.columns.map((column, index) => <td className="tw:max-w-[420px] tw:truncate tw:border-r tw:border-b tw:border-border tw:px-2 tw:py-1.5 tw:font-mono tw:tabular-nums" title={text(row[index] ?? null)} key={column.name}>{text(row[index] ?? null)}</td>)}</tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function Funnel({ block, data }: { block: PublicBlock; data: BlockData }) {
  const stageIndex = column(data, stringConfig(block, "stageColumn"));
  const valueIndex = column(data, stringConfig(block, "valueColumn"));
  const rateIndex = column(data, stringConfig(block, "rateColumn"));
  const maximum = Math.max(1, ...data.rows.map((row) => numeric(row[valueIndex] ?? null) ?? 0));
  const format = formatFrom(block.config.format);
  return (
    <ol className="tw:m-0 tw:grid tw:list-none tw:gap-2 tw:p-0">
      {data.rows.slice(0, 32).map((row, index) => {
        const value = numeric(row[valueIndex] ?? null) ?? 0;
        const rate = numeric(row[rateIndex] ?? null);
        return (
          <li className="tw:grid tw:grid-cols-[minmax(100px,0.8fr)_minmax(140px,2fr)_auto] tw:items-center tw:gap-3" key={index}>
            <span className="tw:truncate tw:text-xs tw:font-medium">{text(row[stageIndex] ?? null)}</span>
            <span className="tw:h-6 tw:overflow-hidden tw:rounded-control tw:bg-surface-inset"><span className="tw:block tw:h-full tw:bg-primary" style={{ width: `${Math.max(0, Math.min(100, value / maximum * 100))}%` }} /></span>
            <span className="tw:font-mono tw:text-xs tw:tabular-nums">{formatNumber(value, format)}{rate === null ? "" : ` · ${formatNumber(rate, { style: "percent", decimals: 1, currency: null })}`}</span>
          </li>
        );
      })}
    </ol>
  );
}

function Matrix({ block, data }: { block: PublicBlock; data: BlockData }) {
  const xKey = block.kind === "retention_cohort" ? "periodColumn" : "xColumn";
  const yKey = block.kind === "retention_cohort" ? "cohortColumn" : "yColumn";
  const xIndex = column(data, stringConfig(block, xKey));
  const yIndex = column(data, stringConfig(block, yKey));
  const valueIndex = column(data, stringConfig(block, "valueColumn"));
  const xs = [...new Set(data.rows.map((row) => text(row[xIndex] ?? null)))].slice(0, 64);
  const ys = [...new Set(data.rows.map((row) => text(row[yIndex] ?? null)))].slice(0, 128);
  const cells = new Map(data.rows.map((row) => [`${text(row[yIndex] ?? null)}\u0000${text(row[xIndex] ?? null)}`, numeric(row[valueIndex] ?? null)]));
  const values = [...cells.values()].filter((value): value is number => value !== null);
  const low = values.length ? Math.min(...values) : 0;
  const high = values.length ? Math.max(...values) : 1;
  const format = formatFrom(block.config.format);
  return (
    <div className="tw:overflow-auto tw:rounded-surface tw:border tw:border-border">
      <table className="tw:w-full tw:min-w-max tw:border-collapse tw:text-xs">
        <caption className="tw:sr-only">{block.title}</caption>
        <thead><tr><th className="tw:border-r tw:border-b tw:border-border" />{xs.map((xValue) => <th className="tw:border-r tw:border-b tw:border-border tw:px-2 tw:py-1.5 tw:text-muted-foreground" key={xValue}>{xValue}</th>)}</tr></thead>
        <tbody>{ys.map((yValue) => <tr key={yValue}><th className="tw:border-r tw:border-b tw:border-border tw:px-2 tw:py-1.5 tw:text-left">{yValue}</th>{xs.map((xValue) => {
          const value = cells.get(`${yValue}\u0000${xValue}`) ?? null;
          const opacity = value === null ? 0 : 0.08 + (value - low) / Math.max(1e-12, high - low) * 0.72;
          return <td className="tw:relative tw:border-r tw:border-b tw:border-border tw:px-2 tw:py-1.5 tw:text-center tw:font-mono" key={xValue}>{value !== null ? <span className="tw:absolute tw:inset-0 tw:bg-primary" style={{ opacity }} /> : null}<span className="tw:relative">{value === null ? "—" : formatNumber(value, format)}</span></td>;
        })}</tr>)}</tbody>
      </table>
    </div>
  );
}

function PublicBlockView({ block }: { block: PublicBlock }) {
  const data = blockData(block);
  let content: React.ReactNode = null;
  if (block.kind === "heading") {
    content = <h2 className="tw:font-serif tw:text-3xl tw:font-medium tw:tracking-[-0.025em]">{stringConfig(block, "text") ?? block.title}</h2>;
  } else if (block.kind === "markdown") {
    content = <SafeNarrative markdown={stringConfig(block, "markdown") ?? ""} />;
  } else if (block.kind === "callout") {
    content = <div className="tw:rounded-control tw:border tw:border-border tw:bg-surface-inset tw:p-4"><SafeNarrative markdown={stringConfig(block, "markdown") ?? ""} /></div>;
  } else if (block.kind === "divider") {
    content = <hr className="tw:border-0 tw:border-t tw:border-border" />;
  } else if (!data) {
    content = <p className="tw:text-sm tw:text-muted-foreground">No retained rows for this block.</p>;
  } else if (block.kind === "metric") {
    content = <Metric block={block} data={data} />;
  } else if (["time_series", "bar", "area", "scatter"].includes(block.kind)) {
    content = <Chart block={block} data={data} />;
  } else if (block.kind === "table") {
    content = <Table data={data} title={block.title} />;
  } else if (block.kind === "funnel") {
    content = <Funnel block={block} data={data} />;
  } else if (block.kind === "retention_cohort" || block.kind === "heatmap") {
    content = <Matrix block={block} data={data} />;
  }
  return (
    <section
      className="tw:grid tw:min-w-0 tw:gap-3 tw:rounded-panel tw:border tw:border-border tw:bg-surface tw:p-5 tw:shadow-panel tw:max-[700px]:col-span-12"
      style={{ gridColumn: `span ${Math.max(1, Math.min(12, block.width))}` }}
    >
      {block.title && !["heading", "markdown", "callout", "divider", "metric"].includes(block.kind) ? <h2 className="tw:text-sm tw:font-semibold">{block.title}</h2> : null}
      {content}
      {data?.truncated ? <span className="tw:text-2xs tw:text-warning">The source result reached its declared safety limit.</span> : null}
    </section>
  );
}

export function AnalysisArticleDocument({
  article,
  eyebrow = "Analysis Article",
  resultLabel = "Fixed snapshot",
}: {
  article: AnalysisPublicSnapshot;
  eyebrow?: string;
  resultLabel?: string;
}) {
  return (
    <article className="tw:grid tw:gap-8">
      <header className="tw:grid tw:max-w-[900px] tw:gap-4">
        <span className="tw:font-mono tw:text-2xs tw:font-semibold tw:tracking-[0.09em] tw:text-primary tw:uppercase">{eyebrow}</span>
        <h1 className="tw:font-serif tw:text-[clamp(2.6rem,7vw,5.8rem)] tw:font-medium tw:leading-[0.94] tw:tracking-[-0.045em]">{article.title}</h1>
        {article.description ? <p className="tw:max-w-[74ch] tw:text-base tw:leading-body tw:text-muted-foreground">{article.description}</p> : null}
        {article.summary ? <p className="tw:max-w-[82ch] tw:text-sm tw:leading-body">{article.summary}</p> : null}
        <div className="tw:flex tw:flex-wrap tw:gap-2 tw:text-xs tw:text-muted-foreground">
          <span className="tw:rounded-full tw:border tw:border-border tw:px-2.5 tw:py-1">{resultLabel}</span>
          <span className="tw:rounded-full tw:border tw:border-border tw:px-2.5 tw:py-1">Data as of {new Date(article.dataAsOf).toLocaleString()}</span>
          <span className="tw:rounded-full tw:border tw:border-border tw:px-2.5 tw:py-1">{article.timezone}</span>
        </div>
        {article.parameters.length ? <dl className="tw:flex tw:flex-wrap tw:gap-2">{article.parameters.map((parameter) => <div className="tw:flex tw:items-center tw:gap-1.5 tw:rounded-full tw:bg-surface-raised tw:px-2.5 tw:py-1 tw:text-xs" key={parameter.label}><dt className="tw:text-muted-foreground">{parameter.label}</dt><dd className="tw:m-0 tw:font-mono">{text(parameter.value)}</dd></div>)}</dl> : null}
      </header>
      <div className="tw:grid tw:grid-cols-12 tw:items-start tw:gap-4">
        {article.blocks.map((block) => <PublicBlockView block={block} key={block.id} />)}
      </div>
    </article>
  );
}

export function PublicAnalysisArticle({ article }: { article: AnalysisPublicSnapshot }) {
  return <AnalysisArticleDocument article={article} />;
}
