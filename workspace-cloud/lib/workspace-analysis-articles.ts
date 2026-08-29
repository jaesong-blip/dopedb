import {
  analysisArticleStates,
  analysisArticleSources,
  analysisParameterTypes,
  analysisColumnTypes,
  analysisColumnRoles,
  analysisColumnSensitivities,
  analysisColumnMasking,
  analysisTransformOperations,
  analysisBlockKinds,
  analysisBlockResultColumns,
  nextAnalysisRefreshAt,
  type AnalysisArticleState,
  type AnalysisArticleSource,
  type AnalysisParameterType,
  type AnalysisColumnType,
  type AnalysisColumnRole,
  type AnalysisColumnSensitivity,
  type AnalysisColumnMasking,
  type AnalysisTransformOperation,
  type AnalysisBlockKind,
  type AnalysisArticleConnection,
  type AnalysisParameterValue,
  type AnalysisParameter,
  type AnalysisColumn,
  type AnalysisNumberFormat,
  type AnalysisMetric,
  type AnalysisQueryNode,
  type AnalysisTransformNode,
  type AnalysisBlock,
  type AnalysisEvidenceClaim,
  type AnalysisRefreshPolicy,
  type AnalysisArticleDefinition,
  type SharedAnalysisArticleCreate,
  type AnalysisArticleVersionPayload,
} from "./workspace-analysis-article-contracts";
import {
  analysisId as id,
  displayText,
  exactRecord,
  safeInteger,
  uniqueValues as unique,
} from "./workspace-analysis-validation";
import {
  legacyArticleHtml,
  queryResultBlock,
  sanitizeAnalysisArticleHtml,
} from "./workspace-analysis-html";

export * from "./workspace-analysis-article-contracts";
export { sanitizeAnalysisArticleHtml } from "./workspace-analysis-html";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PARAMETER_TOKEN = /\{\{([A-Za-z][A-Za-z0-9_-]{0,63})\}\}/g;

function sqlTokens(sql: string) {
  const tokens: string[] = [];
  let index = 0;
  while (index < sql.length) {
    const char = sql[index]!;
    const next = sql[index + 1];
    if (/\s/u.test(char)) {
      index += 1;
      continue;
    }
    if (char === "-" && next === "-") {
      index = sql.indexOf("\n", index + 2);
      if (index < 0) break;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = sql.indexOf("*/", index + 2);
      if (end < 0) throw new Error("Unterminated Analysis Article SQL comment");
      index = end + 2;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      const quote = char;
      index += 1;
      let closed = false;
      while (index < sql.length) {
        if (sql[index] === quote) {
          if (sql[index + 1] === quote) {
            index += 2;
            continue;
          }
          index += 1;
          closed = true;
          break;
        }
        if (sql[index] === "\\" && quote !== '"') index += 1;
        index += 1;
      }
      if (!closed) throw new Error("Unterminated Analysis Article SQL string");
      continue;
    }
    if (char === "$") {
      const tag = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/u.exec(sql.slice(index))?.[0];
      if (tag) {
        const end = sql.indexOf(tag, index + tag.length);
        if (end < 0) throw new Error("Unterminated Analysis Article SQL string");
        index = end + tag.length;
        continue;
      }
    }
    if (/[A-Za-z_]/u.test(char)) {
      const match = /^[A-Za-z_][A-Za-z0-9_$]*/u.exec(sql.slice(index))![0];
      tokens.push(match.toLowerCase());
      index += match.length;
      continue;
    }
    if (char === ";") tokens.push(";");
    index += 1;
  }
  return tokens;
}

function validateReadOnlySql(sql: string) {
  const tokens = sqlTokens(sql);
  const first = tokens[0];
  if (!first || !["select", "with", "show", "describe", "desc", "explain"].includes(first)
    || tokens.filter((token) => token === ";").length > 1
    || (tokens.includes(";") && tokens.at(-1) !== ";")) {
    throw new Error("Analysis Article source must be one read-only statement");
  }
  const prohibited = new Set([
    "insert", "update", "delete", "merge", "replace", "upsert", "copy", "call", "do",
    "create", "alter", "drop", "truncate", "grant", "revoke", "attach", "detach",
    "vacuum", "analyze", "refresh", "reindex", "cluster", "lock", "set", "reset",
  ]);
  if (tokens.some((token) => prohibited.has(token))) {
    throw new Error("Analysis Article source contains a write or session command");
  }
}

function parseConnection(value: unknown): AnalysisArticleConnection {
  const row = exactRecord(value, ["connectionId", "connectionRevision", "role", "alias"]);
  const revision = safeInteger(row?.connectionRevision, 1, Number.MAX_SAFE_INTEGER);
  const role = id(row?.role);
  const alias = displayText(row?.alias, 128);
  if (!row || typeof row.connectionId !== "string" || !UUID.test(row.connectionId)
    || revision === null || role === null || alias === null) {
    throw new Error("Invalid Analysis Article connection");
  }
  return { connectionId: row.connectionId, connectionRevision: revision, role, alias };
}

function validParameterValue(type: AnalysisParameterType, value: unknown, options: readonly string[]) {
  if (value === null) return true;
  if (type === "boolean") return typeof value === "boolean";
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (typeof value !== "string" || value.length > 4_000 || value.includes("\u0000")) return false;
  if (type === "date") return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
  if (type === "datetime") return !Number.isNaN(Date.parse(value));
  if (type === "enum") return options.includes(value);
  return true;
}

function parseParameter(value: unknown): AnalysisParameter {
  const row = exactRecord(value, ["id", "label", "type", "required", "defaultValue", "options"]);
  const parameterId = id(row?.id);
  const label = displayText(row?.label, 128);
  if (!row || parameterId === null || label === null
    || typeof row.type !== "string"
    || !analysisParameterTypes.includes(row.type as AnalysisParameterType)
    || typeof row.required !== "boolean" || !Array.isArray(row.options)
    || row.options.length > 100
    || row.options.some((option) => displayText(option, 256) === null)
    || !unique(row.options as string[])) {
    throw new Error("Invalid Analysis Article parameter");
  }
  const type = row.type as AnalysisParameterType;
  const options = row.options as string[];
  if ((type === "enum") !== (options.length > 0)
    || !validParameterValue(type, row.defaultValue, options)
    || (row.required && row.defaultValue === null)) {
    throw new Error("Invalid Analysis Article parameter value");
  }
  return {
    id: parameterId,
    label,
    type,
    required: row.required,
    defaultValue: row.defaultValue as AnalysisParameterValue,
    options,
  };
}

import { parseColumns } from "./workspace-analysis-column-parser";

function parseQuery(value: unknown, parameterIds: ReadonlySet<string>): AnalysisQueryNode {
  const row = exactRecord(value, [
    "id", "title", "connectionRole", "sql", "parameterIds",
    "maxRows", "maxBytes", "cacheTtlSeconds", "columns",
  ]);
  const queryId = id(row?.id);
  const title = displayText(row?.title, 256);
  const connectionRole = id(row?.connectionRole);
  const maxRows = safeInteger(row?.maxRows, 1, 50_000);
  const maxBytes = safeInteger(row?.maxBytes, 1_024, 16 * 1024 * 1024);
  const cacheTtlSeconds = safeInteger(row?.cacheTtlSeconds, 0, 7 * 24 * 60 * 60);
  if (!row || queryId === null || title === null || connectionRole === null
    || typeof row.sql !== "string" || row.sql.trim().length === 0
    || new TextEncoder().encode(row.sql).byteLength > 100_000 || row.sql.includes("\u0000")
    || !Array.isArray(row.parameterIds) || row.parameterIds.length > 32
    || row.parameterIds.some((parameterId) => id(parameterId) === null || !parameterIds.has(parameterId as string))
    || !unique(row.parameterIds as string[]) || maxRows === null || maxBytes === null
    || cacheTtlSeconds === null) {
    throw new Error("Invalid Analysis Article query");
  }
  validateReadOnlySql(row.sql);
  const declaredParameterIds = row.parameterIds as string[];
  const tokens = [...row.sql.matchAll(PARAMETER_TOKEN)].map((match) => match[1]!);
  if (!unique(tokens) || tokens.some((token) => !declaredParameterIds.includes(token))
    || declaredParameterIds.some((parameterId) => !tokens.includes(parameterId))) {
    throw new Error("Analysis Article query parameter tokens do not match parameterIds");
  }
  return {
    id: queryId,
    title,
    connectionRole,
    sql: row.sql,
    parameterIds: declaredParameterIds,
    maxRows,
    maxBytes,
    cacheTtlSeconds,
    columns: parseColumns(row.columns),
  };
}

import {
  parseBlock,
  parseClaim,
  parseMetric,
  parseRefresh,
  parseTransform,
} from "./workspace-analysis-definition-parser";

function sourceRolesForNode(
  nodeId: string,
  queries: ReadonlyMap<string, AnalysisQueryNode>,
  transforms: ReadonlyMap<string, AnalysisTransformNode>,
  memo: Map<string, ReadonlySet<string>>,
): ReadonlySet<string> {
  const cached = memo.get(nodeId);
  if (cached) return cached;
  const query = queries.get(nodeId);
  if (query) {
    const roles = new Set([query.connectionRole]);
    memo.set(nodeId, roles);
    return roles;
  }
  const transform = transforms.get(nodeId);
  if (!transform) return new Set();
  const roles = new Set<string>();
  memo.set(nodeId, roles);
  for (const inputId of transform.inputNodeIds) {
    for (const role of sourceRolesForNode(inputId, queries, transforms, memo)) roles.add(role);
  }
  return roles;
}

function sameColumn(left: AnalysisColumn, right: AnalysisColumn) {
  return left.name === right.name && left.type === right.type && left.nullable === right.nullable
    && left.role === right.role && left.sensitivity === right.sensitivity
    && left.masking === right.masking;
}

function sameSchema(left: readonly AnalysisColumn[], right: readonly AnalysisColumn[]) {
  return left.length === right.length && left.every((column, index) => sameColumn(column, right[index]!));
}

function columnByName(columns: readonly AnalysisColumn[], name: unknown) {
  return typeof name === "string" ? columns.find((column) => column.name === name) : undefined;
}

function exactProjectedSchema(
  input: readonly AnalysisColumn[],
  output: readonly AnalysisColumn[],
  names: readonly string[],
) {
  const expected = names.map((name) => columnByName(input, name));
  return expected.every(Boolean)
    && sameSchema(expected as AnalysisColumn[], output);
}

function inheritedColumnsRemainExact(
  input: readonly AnalysisColumn[],
  output: readonly AnalysisColumn[],
) {
  return input.every((column) => {
    const inherited = columnByName(output, column.name);
    return inherited ? sameColumn(column, inherited) : false;
  });
}

function validateTransformSchema(
  transform: AnalysisTransformNode,
  inputs: readonly (readonly AnalysisColumn[])[],
) {
  const first = inputs[0]!;
  const config = transform.config;
  const fail = () => {
    throw new Error(`Analysis Article transform schema is invalid: ${transform.title}`);
  };
  if (["filter", "sort", "limit"].includes(transform.operation)) {
    if (!sameSchema(first, transform.columns)) fail();
    if (transform.operation === "filter" && !columnByName(first, config.column)) fail();
    if (transform.operation === "sort") {
      const items = config.columns as readonly { column: string }[];
      if (items.some((item) => !columnByName(first, item.column))) fail();
    }
    return;
  }
  if (transform.operation === "project" || transform.operation === "group") {
    if (!exactProjectedSchema(first, transform.columns, config.columns as string[])) fail();
    return;
  }
  if (transform.operation === "union") {
    if (!sameSchema(first, inputs[1]!) || !sameSchema(first, transform.columns)) fail();
    return;
  }
  if (transform.operation === "inner_join" || transform.operation === "left_join") {
    const second = inputs[1]!;
    const keys = config.keys as readonly { left: string; right: string }[];
    if (keys.some((key) => !columnByName(first, key.left) || !columnByName(second, key.right))) fail();
    const combined = [...first, ...second];
    if (!unique(combined.map((column) => column.name)) || !sameSchema(combined, transform.columns)) fail();
    return;
  }
  if (transform.operation === "aggregate") {
    const groupBy = config.groupBy as string[];
    const measures = config.measures as readonly { column: string; function: string; as: string }[];
    if (!exactProjectedSchema(first, transform.columns.slice(0, groupBy.length), groupBy)
      || transform.columns.length !== groupBy.length + measures.length) fail();
    measures.forEach((measure, index) => {
      const source = columnByName(first, measure.column);
      const output = transform.columns[groupBy.length + index];
      if (!source || !output || output.name !== measure.as || output.role !== "measure"
        || !["number", "duration", "currency", "percent"].includes(output.type)
        || (measure.function !== "count" && measure.function !== "count_distinct"
          && !["number", "duration", "currency", "percent"].includes(source.type))) fail();
    });
    return;
  }
  if (!inheritedColumnsRemainExact(first, transform.columns)) fail();
  if (transform.operation === "window") {
    if (!columnByName(first, config.orderBy)
      || (config.partitionBy as string[]).some((name) => !columnByName(first, name))) fail();
    for (const measure of config.measures as readonly { column: string | null; as: string }[]) {
      if ((measure.column !== null && !columnByName(first, measure.column))
        || !columnByName(transform.columns, measure.as)) fail();
    }
    return;
  }
  if (transform.operation === "lag") {
    if (!columnByName(first, config.column) || !columnByName(first, config.orderBy)
      || (config.partitionBy as string[]).some((name) => !columnByName(first, name))
      || !columnByName(transform.columns, config.as)) fail();
    return;
  }
  if (["ratio", "difference", "rate"].includes(transform.operation)) {
    if (!columnByName(first, config.numerator) || !columnByName(first, config.denominator)
      || !columnByName(transform.columns, config.as)) fail();
    return;
  }
  if (transform.operation === "cohort") {
    if (!columnByName(first, config.entityColumn) || !columnByName(first, config.eventTimeColumn)
      || !columnByName(transform.columns, config.as)) fail();
    return;
  }
  if (transform.operation === "retention") {
    if (!columnByName(first, config.entityColumn) || !columnByName(first, config.cohortColumn)
      || !columnByName(first, config.eventTimeColumn) || !columnByName(transform.columns, config.as)) fail();
  }
}

function validateBlockSchema(
  block: AnalysisBlock,
  columns: readonly AnalysisColumn[] | undefined,
) {
  if (!block.sourceNodeId || !columns) return;
  const config = block.config;
  const required: unknown[] = [];
  if (["time_series", "bar", "area", "scatter"].includes(block.kind)) {
    required.push(config.xColumn, ...(config.yColumns as unknown[]));
    if (config.seriesColumn !== null) required.push(config.seriesColumn);
  } else if (block.kind === "table") {
    required.push(...(config.columns as unknown[]));
  } else if (block.kind === "funnel") {
    required.push(config.stageColumn, config.valueColumn);
    if (config.rateColumn !== null) required.push(config.rateColumn);
  } else if (block.kind === "retention_cohort") {
    required.push(config.cohortColumn, config.periodColumn, config.valueColumn);
  } else if (block.kind === "heatmap") {
    required.push(config.xColumn, config.yColumn, config.valueColumn);
  } else if (block.kind === "metric") {
    if (config.comparisonColumn !== null) required.push(config.comparisonColumn);
    if (config.sparklineColumn !== null) required.push(config.sparklineColumn);
    if (config.sampleCountColumn !== null) required.push(config.sampleCountColumn);
  }
  if (required.some((name) => !columnByName(columns, name))) {
    throw new Error(`Analysis Article block column is invalid: ${block.title}`);
  }
}

function parseDefinition(value: unknown, connectionRoles: ReadonlySet<string>): AnalysisArticleDefinition {
  const candidate = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
  const version = candidate?.version;
  const row = exactRecord(value, [
    "version", "source", "title", "question", "summary", "timezone", "parameters",
    "queries", "transforms", "metrics", "blocks", "claims", "refresh", "warnings",
    ...(version === 2 ? ["html"] : []),
  ]);
  const title = displayText(row?.title, 160);
  const question = displayText(row?.question, 8_000, true);
  const summary = displayText(row?.summary, 20_000, true);
  const timezone = displayText(row?.timezone, 128);
  if (!row || (row.version !== 1 && row.version !== 2) || typeof row.source !== "string"
    || !analysisArticleSources.includes(row.source as AnalysisArticleSource)
    || title === null || question === null || summary === null || timezone === null
    || !Array.isArray(row.parameters) || row.parameters.length > 32
    || !Array.isArray(row.queries) || row.queries.length < 1 || row.queries.length > 64
    || !Array.isArray(row.transforms) || row.transforms.length > 128
    || !Array.isArray(row.metrics) || row.metrics.length > 128
    || !Array.isArray(row.blocks) || row.blocks.length < 1 || row.blocks.length > 128
    || !Array.isArray(row.claims) || row.claims.length > 128
    || !Array.isArray(row.warnings) || row.warnings.length > 64) {
    throw new Error("Invalid Analysis Article definition");
  }
  const parameters = row.parameters.map(parseParameter);
  if (!unique(parameters.map((parameter) => parameter.id))) throw new Error("Duplicate Analysis Article parameter");
  const parameterIds = new Set(parameters.map((parameter) => parameter.id));
  const queries = row.queries.map((query) => parseQuery(query, parameterIds));
  const transforms = row.transforms.map(parseTransform);
  const nodeIds = [...queries.map((query) => query.id), ...transforms.map((transform) => transform.id)];
  if (!unique(nodeIds) || queries.some((query) => !connectionRoles.has(query.connectionRole))) {
    throw new Error("Invalid Analysis Article query authority");
  }
  const known = new Set(queries.map((query) => query.id));
  for (const transform of transforms) {
    if (transform.inputNodeIds.some((inputId) => !known.has(inputId))) {
      throw new Error("Analysis Article transforms must be topologically ordered");
    }
    const available = new Map<string, readonly AnalysisColumn[]>([
      ...queries.map((query) => [query.id, query.columns] as const),
      ...transforms.filter((candidate) => known.has(candidate.id))
        .map((candidate) => [candidate.id, candidate.columns] as const),
    ]);
    validateTransformSchema(
      transform,
      transform.inputNodeIds.map((inputId) => available.get(inputId)!),
    );
    known.add(transform.id);
  }
  const queryById = new Map(queries.map((query) => [query.id, query]));
  const transformById = new Map(transforms.map((transform) => [transform.id, transform]));
  const roleMemo = new Map<string, ReadonlySet<string>>();
  for (const transform of transforms) {
    const roles = sourceRolesForNode(transform.id, queryById, transformById, roleMemo);
    if (roles.size > 1 && !["inner_join", "left_join", "union"].includes(transform.operation)) {
      throw new Error("Cross-connection data may only meet in an approved join or union");
    }
  }
  const metrics = row.metrics.map(parseMetric);
  if (!unique(metrics.map((metric) => metric.id))) {
    throw new Error("Duplicate Analysis Article metric");
  }
  const columnsByNode = new Map<string, readonly AnalysisColumn[]>([
    ...queries.map((query) => [query.id, query.columns] as const),
    ...transforms.map((transform) => [transform.id, transform.columns] as const),
  ]);
  for (const metric of metrics) {
    const column = columnsByNode.get(metric.sourceNodeId)
      ?.find((candidate) => candidate.name === metric.valueColumn);
    if (!column || !["number", "duration", "currency", "percent"].includes(column.type)
      || column.role !== "measure") {
      throw new Error("Analysis Article metric must reference a numeric measure");
    }
  }
  const blocks = row.blocks.map(parseBlock);
  if (!unique(blocks.map((block) => block.id))
    || blocks.some((block) => block.sourceNodeId !== null && !known.has(block.sourceNodeId))) {
    throw new Error("Invalid Analysis Article block reference");
  }
  const blockIds = new Set(blocks.map((block) => block.id));
  for (const block of blocks) {
    validateBlockSchema(
      block,
      block.sourceNodeId ? columnsByNode.get(block.sourceNodeId) : undefined,
    );
    if (block.kind === "metric") {
      const metric = metrics.find((candidate) => candidate.id === block.config.metricId);
      if (!metric || metric.sourceNodeId !== block.sourceNodeId) {
        throw new Error("Analysis Article metric block references an incompatible metric");
      }
    }
    if (!["date_range_control", "comparison_control", "segment_control"].includes(block.kind)) continue;
    const config = block.config as { parameterIds: readonly string[] };
    if (config.parameterIds.some((parameterId) => !parameterIds.has(parameterId))) {
      throw new Error("Analysis Article control references an unknown parameter");
    }
  }
  const claims = row.claims.map(parseClaim);
  if (!unique(claims.map((claim) => claim.id))
    || claims.some((claim) => claim.blockIds.some((blockId) => !blockIds.has(blockId))
      || claim.nodeIds.some((nodeId) => !known.has(nodeId)))) {
    throw new Error("Invalid Analysis Article claim reference");
  }
  const warnings = row.warnings.map((warning) => displayText(warning, 2_000));
  if (warnings.some((warning) => warning === null)) throw new Error("Invalid Analysis Article warning");
  const refresh = parseRefresh(row.refresh);
  const parsedPrimaryQuery = queries[0]!;
  const primaryQuery = { ...parsedPrimaryQuery, cacheTtlSeconds: 0 };
  const referencedParameterIds = new Set(primaryQuery.parameterIds);
  const retainedParameters = parameters.filter((parameter) => referencedParameterIds.has(parameter.id));
  if (row.version === 2) {
    if (queries.length !== 1 || transforms.length !== 0 || metrics.length !== 0 || claims.length !== 0
      || warnings.length !== 0 || blocks.length !== 1 || blocks[0]?.kind !== "table"
      || blocks[0]?.id !== "query_result"
      || blocks[0].sourceNodeId !== parsedPrimaryQuery.id || question !== "" || summary !== ""
      || timezone !== "UTC" || refresh.mode !== "manual" || refresh.cron !== null
      || refresh.runnerId !== null || refresh.shareReviewedResults) {
      throw new Error("Analysis Article must contain one HTML document and one manual read query");
    }
    return {
      version: 2,
      source: row.source as AnalysisArticleSource,
      title,
      html: sanitizeAnalysisArticleHtml(row.html),
      question: "",
      summary: "",
      timezone: "UTC",
      parameters: retainedParameters,
      queries: [primaryQuery],
      transforms: [],
      metrics: [],
      blocks: [queryResultBlock(primaryQuery)],
      claims: [],
      refresh: {
        mode: "manual",
        cron: null,
        timezone: "UTC",
        runnerId: null,
        maxStalenessSeconds: 86_400,
        resultRetentionDays: 30,
        shareReviewedResults: false,
      },
      warnings: [],
    };
  }
  return {
    version: 2,
    source: row.source as AnalysisArticleSource,
    title,
    html: legacyArticleHtml(question, summary, blocks),
    question: "",
    summary: "",
    timezone: "UTC",
    parameters: retainedParameters,
    queries: [primaryQuery],
    transforms: [],
    metrics: [],
    blocks: [queryResultBlock(primaryQuery)],
    claims: [],
    refresh: {
      mode: "manual",
      cron: null,
      timezone: "UTC",
      runnerId: null,
      maxStalenessSeconds: 86_400,
      resultRetentionDays: 30,
      shareReviewedResults: false,
    },
    warnings: [],
  };
}

export function parseSharedAnalysisArticleCreate(value: unknown): SharedAnalysisArticleCreate {
  const row = exactRecord(value, [
    "id", "projectEnvironmentId", "environmentRevision", "sourceKnowledgeGrantId",
    "graphRevisionIds", "connections", "definition",
  ]);
  const environmentRevision = safeInteger(row?.environmentRevision, 1, Number.MAX_SAFE_INTEGER);
  if (!row || typeof row.id !== "string" || !UUID.test(row.id)
    || typeof row.projectEnvironmentId !== "string" || !UUID.test(row.projectEnvironmentId)
    || environmentRevision === null
    || !(row.sourceKnowledgeGrantId === null
      || (typeof row.sourceKnowledgeGrantId === "string" && UUID.test(row.sourceKnowledgeGrantId)))
    || !Array.isArray(row.graphRevisionIds) || row.graphRevisionIds.length > 32
    || row.graphRevisionIds.some((revisionId) => typeof revisionId !== "string" || !UUID.test(revisionId))
    || !unique(row.graphRevisionIds as string[])
    || !Array.isArray(row.connections) || row.connections.length < 1 || row.connections.length > 32) {
    throw new Error("Invalid Analysis Article authority");
  }
  const connections = row.connections.map(parseConnection);
  if (!unique(connections.map((connection) => connection.connectionId))
    || !unique(connections.map((connection) => connection.role))) {
    throw new Error("Duplicate Analysis Article connection authority");
  }
  if ((row.sourceKnowledgeGrantId === null) !== (row.graphRevisionIds.length === 0)) {
    throw new Error("Analysis Article knowledge authority is incomplete");
  }
  const definition = parseDefinition(
    row.definition,
    new Set(connections.map((connection) => connection.role)),
  );
  const queryConnection = connections.find(
    (connection) => connection.role === definition.queries[0]!.connectionRole,
  );
  if (!queryConnection) throw new Error("Analysis Article query connection is unavailable");
  return {
    id: row.id,
    projectEnvironmentId: row.projectEnvironmentId,
    environmentRevision,
    sourceKnowledgeGrantId: null,
    graphRevisionIds: [],
    connections: [queryConnection],
    definition,
  };
}

export function isAnalysisArticleState(value: unknown): value is AnalysisArticleState {
  return typeof value === "string"
    && analysisArticleStates.includes(value as AnalysisArticleState);
}

export function analysisArticleVersionPayload(input: SharedAnalysisArticleCreate & {
  state: AnalysisArticleState;
  ownerMemberId: string;
  deleted?: boolean;
}): AnalysisArticleVersionPayload {
  const parsed = parseSharedAnalysisArticleCreate({
    id: input.id,
    projectEnvironmentId: input.projectEnvironmentId,
    environmentRevision: input.environmentRevision,
    sourceKnowledgeGrantId: input.sourceKnowledgeGrantId,
    graphRevisionIds: input.graphRevisionIds,
    connections: input.connections,
    definition: input.definition,
  });
  if (!isAnalysisArticleState(input.state) || !input.ownerMemberId) {
    throw new Error("Invalid Analysis Article version authority");
  }
  return {
    ...parsed,
    state: input.state,
    ownerMemberId: input.ownerMemberId,
    deleted: input.deleted ?? false,
  };
}

export function parseAnalysisArticleVersionPayload(value: unknown): AnalysisArticleVersionPayload {
  const row = exactRecord(value, [
    "id", "projectEnvironmentId", "environmentRevision", "sourceKnowledgeGrantId",
    "graphRevisionIds", "connections", "definition", "state", "ownerMemberId", "deleted",
  ]);
  if (!row || !isAnalysisArticleState(row.state) || typeof row.ownerMemberId !== "string"
    || row.ownerMemberId.length === 0 || typeof row.deleted !== "boolean") {
    throw new Error("Invalid Analysis Article revision payload");
  }
  const article = parseSharedAnalysisArticleCreate({
    id: row.id,
    projectEnvironmentId: row.projectEnvironmentId,
    environmentRevision: row.environmentRevision,
    sourceKnowledgeGrantId: row.sourceKnowledgeGrantId,
    graphRevisionIds: row.graphRevisionIds,
    connections: row.connections,
    definition: row.definition,
  });
  return {
    ...article,
    state: row.state,
    ownerMemberId: row.ownerMemberId,
    deleted: row.deleted,
  };
}

export function publicAnalysisArticle(row: {
  id: string;
  projectEnvironmentId: string;
  environmentRevision: number;
  sourceKnowledgeGrantId: string | null;
  graphRevisionIds: readonly string[];
  connections: readonly AnalysisArticleConnection[];
  definition: unknown;
  state: string;
  ownerMemberId: string;
  updatedByMemberId: string;
  revision: number;
  liveRevision: number | null;
  liveRunId: string | null;
  nextRefreshAt: Date | null;
  latestSuccessfulRunId: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  const parsed = parseSharedAnalysisArticleCreate({
    id: row.id,
    projectEnvironmentId: row.projectEnvironmentId,
    environmentRevision: row.environmentRevision,
    sourceKnowledgeGrantId: row.sourceKnowledgeGrantId,
    graphRevisionIds: row.graphRevisionIds,
    connections: row.connections,
    definition: row.definition,
  });
  if (!isAnalysisArticleState(row.state) || !row.ownerMemberId || !row.updatedByMemberId
    || safeInteger(row.revision, 1, Number.MAX_SAFE_INTEGER) === null
    || !(row.liveRevision === null
      || (safeInteger(row.liveRevision, 1, row.revision) !== null))
    || !(row.liveRunId === null || UUID.test(row.liveRunId))
    || !(row.nextRefreshAt === null || (row.nextRefreshAt instanceof Date
      && !Number.isNaN(row.nextRefreshAt.valueOf())))
    || !(row.latestSuccessfulRunId === null || UUID.test(row.latestSuccessfulRunId))
    || Number.isNaN(row.createdAt.valueOf()) || Number.isNaN(row.updatedAt.valueOf())) {
    throw new Error("Invalid stored Analysis Article");
  }
  return {
    ...parsed,
    state: row.state,
    ownerMemberId: row.ownerMemberId,
    updatedByMemberId: row.updatedByMemberId,
    revision: row.revision,
    liveRevision: row.liveRevision,
    liveRunId: row.liveRunId,
    nextRefreshAt: row.nextRefreshAt?.toISOString() ?? null,
    latestSuccessfulRunId: row.latestSuccessfulRunId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
