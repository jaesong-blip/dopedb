import { CronExpressionParser } from "cron-parser";

import {
  analysisBlockKinds,
  analysisTransformOperations,
  type AnalysisBlock,
  type AnalysisBlockKind,
  type AnalysisEvidenceClaim,
  type AnalysisMetric,
  type AnalysisNumberFormat,
  type AnalysisRefreshPolicy,
  type AnalysisTransformNode,
  type AnalysisTransformOperation,
} from "./workspace-analysis-article-contracts";
import {
  analysisId as id,
  displayText,
  exactRecord,
  safeInteger,
  uniqueValues as unique,
} from "./workspace-analysis-validation";
import { parseColumns } from "./workspace-analysis-column-parser";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function stringList(value: unknown, maximum: number, itemMax = 256) {
  if (!Array.isArray(value) || value.length > maximum
    || value.some((item) => displayText(item, itemMax) === null)
    || !unique(value as string[])) return null;
  return value as string[];
}

function parseFormat(value: unknown): AnalysisNumberFormat {
  const row = exactRecord(value, ["style", "decimals", "currency"]);
  const styles = ["number", "percent", "currency", "duration", "compact"];
  if (!row || typeof row.style !== "string" || !styles.includes(row.style)
    || safeInteger(row.decimals, 0, 8) === null
    || !(row.currency === null || (typeof row.currency === "string" && /^[A-Z]{3}$/.test(row.currency)))
    || ((row.style === "currency") !== (row.currency !== null))) {
    throw new Error("Invalid Analysis Article number format");
  }
  return {
    style: row.style as AnalysisNumberFormat["style"],
    decimals: row.decimals as number,
    currency: row.currency as string | null,
  };
}

export function parseMetric(value: unknown): AnalysisMetric {
  const row = exactRecord(value, [
    "id", "label", "description", "sourceNodeId", "valueColumn",
    "unit", "lowerIsBetter", "format",
  ]);
  const metricId = id(row?.id);
  const label = displayText(row?.label, 256);
  const description = displayText(row?.description, 4_000, true);
  const sourceNodeId = id(row?.sourceNodeId);
  const valueColumn = displayText(row?.valueColumn, 256);
  const unit = displayText(row?.unit, 64, true);
  if (!row || metricId === null || label === null || description === null
    || sourceNodeId === null || valueColumn === null || unit === null
    || !(row.lowerIsBetter === null || typeof row.lowerIsBetter === "boolean")) {
    throw new Error("Invalid Analysis Article metric");
  }
  return {
    id: metricId,
    label,
    description,
    sourceNodeId,
    valueColumn,
    unit,
    lowerIsBetter: row.lowerIsBetter as boolean | null,
    format: parseFormat(row.format),
  };
}

function parseTransformConfig(operation: AnalysisTransformOperation, value: unknown) {
  switch (operation) {
    case "project": {
      const row = exactRecord(value, ["columns"]);
      const columns = stringList(row?.columns, 256);
      if (!row || !columns?.length) throw new Error("Invalid project transform");
      return { columns };
    }
    case "filter": {
      const row = exactRecord(value, ["column", "operator", "value"]);
      const operators = ["eq", "neq", "gt", "gte", "lt", "lte", "contains", "in", "is_null", "not_null"];
      if (!row || displayText(row.column, 256) === null || typeof row.operator !== "string"
        || !operators.includes(row.operator)
        || !(row.value === null || typeof row.value === "string" || typeof row.value === "number" || typeof row.value === "boolean" || Array.isArray(row.value))) {
        throw new Error("Invalid filter transform");
      }
      return { column: row.column, operator: row.operator, value: row.value };
    }
    case "sort": {
      const row = exactRecord(value, ["columns"]);
      if (!row || !Array.isArray(row.columns) || row.columns.length < 1 || row.columns.length > 32) {
        throw new Error("Invalid sort transform");
      }
      const columns = row.columns.map((entry) => {
        const item = exactRecord(entry, ["column", "direction"]);
        if (!item || displayText(item.column, 256) === null
          || !(item.direction === "asc" || item.direction === "desc")) {
          throw new Error("Invalid sort column");
        }
        return { column: item.column as string, direction: item.direction };
      });
      return { columns };
    }
    case "limit": {
      const row = exactRecord(value, ["count"]);
      const count = safeInteger(row?.count, 1, 50_000);
      if (!row || count === null) throw new Error("Invalid limit transform");
      return { count };
    }
    case "union": {
      const row = exactRecord(value, ["all", "mappingProposalId"]);
      if (!row || typeof row.all !== "boolean" || typeof row.mappingProposalId !== "string"
        || !UUID.test(row.mappingProposalId)) throw new Error("Invalid union transform");
      return { all: row.all, mappingProposalId: row.mappingProposalId };
    }
    case "group": {
      const row = exactRecord(value, ["columns"]);
      const columns = stringList(row?.columns, 32);
      if (!row || !columns?.length) throw new Error("Invalid group transform");
      return { columns };
    }
    case "aggregate": {
      const row = exactRecord(value, ["groupBy", "measures"]);
      const groupBy = stringList(row?.groupBy, 32);
      if (!row || groupBy === null || !Array.isArray(row.measures)
        || row.measures.length < 1 || row.measures.length > 64) throw new Error("Invalid aggregate transform");
      const functions = ["count", "count_distinct", "sum", "avg", "min", "max"];
      const measures = row.measures.map((entry) => {
        const item = exactRecord(entry, ["column", "function", "as"]);
        if (!item || displayText(item.column, 256) === null || typeof item.function !== "string"
          || !functions.includes(item.function) || id(item.as) === null) {
          throw new Error("Invalid aggregate measure");
        }
        return { column: item.column as string, function: item.function, as: item.as as string };
      });
      return { groupBy, measures };
    }
    case "inner_join":
    case "left_join": {
      const row = exactRecord(value, ["mappingProposalId", "keys"]);
      if (!row || typeof row.mappingProposalId !== "string" || !UUID.test(row.mappingProposalId)
        || !Array.isArray(row.keys) || row.keys.length < 1 || row.keys.length > 16) {
        throw new Error("Invalid join transform");
      }
      const keys = row.keys.map((entry) => {
        const item = exactRecord(entry, ["left", "right"]);
        if (!item || displayText(item.left, 256) === null || displayText(item.right, 256) === null) {
          throw new Error("Invalid join key");
        }
        return { left: item.left as string, right: item.right as string };
      });
      return { mappingProposalId: row.mappingProposalId, keys };
    }
    case "window": {
      const row = exactRecord(value, ["partitionBy", "orderBy", "measures"]);
      const partitionBy = stringList(row?.partitionBy, 16);
      if (!row || partitionBy === null || displayText(row.orderBy, 256) === null
        || !Array.isArray(row.measures) || row.measures.length < 1 || row.measures.length > 32) {
        throw new Error("Invalid window transform");
      }
      const functions = ["row_number", "rank", "dense_rank", "running_sum", "running_avg"];
      const measures = row.measures.map((entry) => {
        const item = exactRecord(entry, ["column", "function", "as"]);
        if (!item || !(item.column === null || displayText(item.column, 256) !== null)
          || typeof item.function !== "string" || !functions.includes(item.function)
          || id(item.as) === null) throw new Error("Invalid window measure");
        return { column: item.column as string | null, function: item.function, as: item.as as string };
      });
      return { partitionBy, orderBy: row.orderBy, measures };
    }
    case "lag": {
      const row = exactRecord(value, ["column", "offset", "partitionBy", "orderBy", "as"]);
      const partitionBy = stringList(row?.partitionBy, 16);
      const offset = safeInteger(row?.offset, 1, 1_000);
      if (!row || displayText(row.column, 256) === null || offset === null || partitionBy === null
        || displayText(row.orderBy, 256) === null || id(row.as) === null) throw new Error("Invalid lag transform");
      return { column: row.column, offset, partitionBy, orderBy: row.orderBy, as: row.as };
    }
    case "ratio":
    case "difference":
    case "rate": {
      const row = exactRecord(value, ["numerator", "denominator", "as"]);
      if (!row || displayText(row.numerator, 256) === null
        || displayText(row.denominator, 256) === null || id(row.as) === null) {
        throw new Error(`Invalid ${operation} transform`);
      }
      return { numerator: row.numerator, denominator: row.denominator, as: row.as };
    }
    case "cohort": {
      const row = exactRecord(value, ["entityColumn", "eventTimeColumn", "cohortUnit", "as"]);
      if (!row || displayText(row.entityColumn, 256) === null
        || displayText(row.eventTimeColumn, 256) === null
        || typeof row.cohortUnit !== "string"
        || !["day", "week", "month"].includes(row.cohortUnit)
        || id(row.as) === null) {
        throw new Error("Invalid cohort transform");
      }
      return { entityColumn: row.entityColumn, eventTimeColumn: row.eventTimeColumn, cohortUnit: row.cohortUnit, as: row.as };
    }
    case "retention": {
      const row = exactRecord(value, ["entityColumn", "cohortColumn", "eventTimeColumn", "periodUnit", "periods", "as"]);
      const periods = safeInteger(row?.periods, 1, 365);
      if (!row || displayText(row.entityColumn, 256) === null
        || displayText(row.cohortColumn, 256) === null || displayText(row.eventTimeColumn, 256) === null
        || typeof row.periodUnit !== "string"
        || !["day", "week", "month"].includes(row.periodUnit) || periods === null
        || id(row.as) === null) throw new Error("Invalid retention transform");
      return { entityColumn: row.entityColumn, cohortColumn: row.cohortColumn, eventTimeColumn: row.eventTimeColumn, periodUnit: row.periodUnit, periods, as: row.as };
    }
  }
}

function transformArity(operation: AnalysisTransformOperation) {
  return ["inner_join", "left_join", "union"].includes(operation) ? 2 : 1;
}

export function parseTransform(value: unknown): AnalysisTransformNode {
  const row = exactRecord(value, ["id", "title", "operation", "inputNodeIds", "config", "columns"]);
  const transformId = id(row?.id);
  const title = displayText(row?.title, 256);
  if (!row || transformId === null || title === null || typeof row.operation !== "string"
    || !analysisTransformOperations.includes(row.operation as AnalysisTransformOperation)
    || !Array.isArray(row.inputNodeIds) || !unique(row.inputNodeIds as string[])
    || row.inputNodeIds.some((nodeId) => id(nodeId) === null)) {
    throw new Error("Invalid Analysis Article transform");
  }
  const operation = row.operation as AnalysisTransformOperation;
  if (row.inputNodeIds.length !== transformArity(operation)) {
    throw new Error("Invalid Analysis Article transform arity");
  }
  return {
    id: transformId,
    title,
    operation,
    inputNodeIds: row.inputNodeIds as string[],
    config: parseTransformConfig(operation, row.config),
    columns: parseColumns(row.columns),
  };
}

function chartConfig(value: unknown, scatter = false) {
  const fields = scatter
    ? ["xColumn", "yColumns", "seriesColumn", "stacked", "format"]
    : ["xColumn", "yColumns", "seriesColumn", "stacked", "format"];
  const row = exactRecord(value, fields);
  const yColumns = stringList(row?.yColumns, 12);
  if (!row || displayText(row.xColumn, 256) === null || !yColumns?.length
    || !(row.seriesColumn === null || displayText(row.seriesColumn, 256) !== null)
    || typeof row.stacked !== "boolean" || (scatter && row.stacked)) {
    throw new Error("Invalid Analysis Article chart config");
  }
  return {
    xColumn: row.xColumn,
    yColumns,
    seriesColumn: row.seriesColumn,
    stacked: row.stacked,
    format: parseFormat(row.format),
  };
}

function parseBlockConfig(kind: AnalysisBlockKind, value: unknown) {
  if (kind === "heading") {
    const row = exactRecord(value, ["level", "text"]);
    const level = safeInteger(row?.level, 1, 3);
    const text = displayText(row?.text, 1_000);
    if (!row || level === null || text === null) throw new Error("Invalid heading block");
    return { level, text };
  }
  if (kind === "markdown") {
    const row = exactRecord(value, ["markdown"]);
    const markdown = displayText(row?.markdown, 100_000, true);
    if (!row || markdown === null) throw new Error("Invalid Markdown block");
    return { markdown };
  }
  if (kind === "callout") {
    const row = exactRecord(value, ["tone", "markdown"]);
    const markdown = displayText(row?.markdown, 32_000);
    if (!row || typeof row.tone !== "string"
      || !["info", "success", "warning", "danger"].includes(row.tone)
      || markdown === null) throw new Error("Invalid callout block");
    return { tone: row.tone, markdown };
  }
  if (kind === "divider") {
    const row = exactRecord(value, []);
    if (!row) throw new Error("Invalid divider block");
    return {};
  }
  if (kind === "metric") {
    const row = exactRecord(value, [
      "metricId", "comparisonColumn", "sparklineColumn", "sampleCountColumn",
    ]);
    if (!row || id(row.metricId) === null
      || !(row.comparisonColumn === null || displayText(row.comparisonColumn, 256) !== null)
      || !(row.sparklineColumn === null || displayText(row.sparklineColumn, 256) !== null)
      || !(row.sampleCountColumn === null || displayText(row.sampleCountColumn, 256) !== null)) {
      throw new Error("Invalid metric block");
    }
    return {
      metricId: row.metricId,
      comparisonColumn: row.comparisonColumn,
      sparklineColumn: row.sparklineColumn,
      sampleCountColumn: row.sampleCountColumn,
    };
  }
  if (["time_series", "bar", "area", "scatter"].includes(kind)) {
    return chartConfig(value, kind === "scatter");
  }
  if (kind === "table") {
    const row = exactRecord(value, ["columns", "pageSize"]);
    const columns = stringList(row?.columns, 64);
    const pageSize = safeInteger(row?.pageSize, 10, 500);
    if (!row || !columns?.length || pageSize === null) throw new Error("Invalid table block");
    return { columns, pageSize };
  }
  if (kind === "funnel") {
    const row = exactRecord(value, ["stageColumn", "valueColumn", "rateColumn", "format"]);
    if (!row || displayText(row.stageColumn, 256) === null || displayText(row.valueColumn, 256) === null
      || !(row.rateColumn === null || displayText(row.rateColumn, 256) !== null)) throw new Error("Invalid funnel block");
    return { stageColumn: row.stageColumn, valueColumn: row.valueColumn, rateColumn: row.rateColumn, format: parseFormat(row.format) };
  }
  if (kind === "retention_cohort") {
    const row = exactRecord(value, ["cohortColumn", "periodColumn", "valueColumn", "format"]);
    if (!row || displayText(row.cohortColumn, 256) === null || displayText(row.periodColumn, 256) === null
      || displayText(row.valueColumn, 256) === null) throw new Error("Invalid retention block");
    return { cohortColumn: row.cohortColumn, periodColumn: row.periodColumn, valueColumn: row.valueColumn, format: parseFormat(row.format) };
  }
  if (kind === "heatmap") {
    const row = exactRecord(value, ["xColumn", "yColumn", "valueColumn", "format"]);
    if (!row || displayText(row.xColumn, 256) === null || displayText(row.yColumn, 256) === null
      || displayText(row.valueColumn, 256) === null) throw new Error("Invalid heatmap block");
    return { xColumn: row.xColumn, yColumn: row.yColumn, valueColumn: row.valueColumn, format: parseFormat(row.format) };
  }
  const row = exactRecord(value, ["parameterIds"]);
  const parameterIds = stringList(row?.parameterIds, kind === "date_range_control" ? 2 : 1, 64);
  if (!row || !parameterIds?.length || (kind === "date_range_control" && parameterIds.length !== 2)) {
    throw new Error("Invalid Analysis Article control block");
  }
  return { parameterIds };
}

export function parseBlock(value: unknown): AnalysisBlock {
  const row = exactRecord(value, ["id", "kind", "title", "sourceNodeId", "width", "config"]);
  const blockId = id(row?.id);
  const title = displayText(row?.title, 256, true);
  const width = safeInteger(row?.width, 1, 12);
  if (!row || blockId === null || title === null || width === null
    || typeof row.kind !== "string" || !analysisBlockKinds.includes(row.kind as AnalysisBlockKind)
    || !(row.sourceNodeId === null || id(row.sourceNodeId) !== null)) {
    throw new Error("Invalid Analysis Article block");
  }
  const kind = row.kind as AnalysisBlockKind;
  const sourceRequired = ["metric", "time_series", "bar", "area", "scatter", "table", "funnel", "retention_cohort", "heatmap"].includes(kind);
  if (sourceRequired !== (row.sourceNodeId !== null)) {
    throw new Error("Analysis Article block source is inconsistent with its kind");
  }
  return {
    id: blockId,
    kind,
    title,
    sourceNodeId: row.sourceNodeId as string | null,
    width,
    config: parseBlockConfig(kind, row.config),
  };
}

export function parseClaim(value: unknown): AnalysisEvidenceClaim {
  const row = exactRecord(value, ["id", "text", "blockIds", "nodeIds"]);
  const claimId = id(row?.id);
  const text = displayText(row?.text, 8_000);
  const blockIds = stringList(row?.blockIds, 64, 64);
  const nodeIds = stringList(row?.nodeIds, 64, 64);
  if (!row || claimId === null || text === null || blockIds === null || nodeIds === null
    || (blockIds.length === 0 && nodeIds.length === 0)) throw new Error("Invalid Analysis Article claim");
  return { id: claimId, text, blockIds, nodeIds };
}

export function parseRefresh(value: unknown): AnalysisRefreshPolicy {
  const row = exactRecord(value, [
    "mode", "cron", "timezone", "runnerId", "maxStalenessSeconds",
    "resultRetentionDays", "shareReviewedResults",
  ]);
  const timezone = displayText(row?.timezone, 128);
  const maxStalenessSeconds = safeInteger(row?.maxStalenessSeconds, 60, 31_622_400);
  const resultRetentionDays = safeInteger(row?.resultRetentionDays, 1, 365);
  if (!row || !(row.mode === "manual" || row.mode === "scheduled") || timezone === null
    || maxStalenessSeconds === null || resultRetentionDays === null
    || typeof row.shareReviewedResults !== "boolean"
    || !(row.runnerId === null || (typeof row.runnerId === "string" && UUID.test(row.runnerId)))
    || !(row.cron === null || displayText(row.cron, 128) !== null)
    || (row.mode === "manual" && (row.cron !== null || row.runnerId !== null))
    || (row.mode === "scheduled" && (row.cron === null || row.runnerId === null))) {
    throw new Error("Invalid Analysis Article refresh policy");
  }
  const cron = row.cron as string | null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    if (cron !== null) {
      const fields = cron.trim().split(/\s+/u);
      const minuteStep = /^\*\/(\d+)$/.exec(fields[0] ?? "");
      if (fields.length !== 5 || fields.some((field) => !/^[0-9*/?,\-]+$/.test(field))
        || (minuteStep !== null && Number(minuteStep[1]) < 5)) {
        throw new Error("Invalid schedule");
      }
      CronExpressionParser.parse(cron, { currentDate: new Date(), tz: timezone }).next();
    }
  } catch {
    throw new Error("Invalid Analysis Article refresh schedule");
  }
  return {
    mode: row.mode,
    cron,
    timezone,
    runnerId: row.runnerId as string | null,
    maxStalenessSeconds,
    resultRetentionDays,
    shareReviewedResults: row.shareReviewedResults,
  };
}
