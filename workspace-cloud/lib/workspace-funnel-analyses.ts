// Runtime-neutral contract for Environment funnel analysis definitions. This
// intentionally has no result-row, credential, transcript, or local-handle shape.

export const funnelAnalysisStates = ["draft", "published", "archived"] as const;
export type FunnelAnalysisState = (typeof funnelAnalysisStates)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const UNSAFE_DISPLAY = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u;

export type FunnelAnalysisConnection = Readonly<{
  connectionId: string;
  connectionRevision: number;
  role: string;
  alias: string;
}>;

export type FunnelAnalysisDefinition = Readonly<{
  sourceAgent: "dopedb.acp.claude" | "dopedb.acp.codex";
  title: string;
  question: string;
  purpose: string;
  timezone: string;
  conversionWindowSeconds: number;
  denominatorSemantics: string;
  numeratorSemantics: string;
  deduplicationPolicy: string;
  lateEventPolicy: string;
  steps: readonly Record<string, unknown>[];
  tiles: readonly Record<string, unknown>[];
  warnings: readonly string[];
}>;

export type SharedFunnelAnalysisCreate = Readonly<{
  id: string;
  projectEnvironmentId: string;
  environmentRevision: number;
  sourceKnowledgeGrantId: string;
  graphRevisionIds: readonly string[];
  connections: readonly FunnelAnalysisConnection[];
  definition: FunnelAnalysisDefinition;
}>;

function exactRecord(value: unknown, fields: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === fields.length
    && fields.every((field) => Object.prototype.hasOwnProperty.call(record, field))
    ? record
    : null;
}

function text(value: unknown, maxChars: number) {
  if (typeof value !== "string" || UNSAFE_DISPLAY.test(value)) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && [...value].length <= maxChars ? trimmed : null;
}

function positiveSafeInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function parseConnection(value: unknown): FunnelAnalysisConnection {
  const row = exactRecord(value, ["connectionId", "connectionRevision", "role", "alias"]);
  const role = text(row?.role, 64);
  const alias = text(row?.alias, 128);
  const revision = positiveSafeInteger(row?.connectionRevision);
  if (!row || typeof row.connectionId !== "string" || !UUID.test(row.connectionId)
    || role === null || alias === null || revision === null) {
    throw new Error("Invalid funnel analysis connection");
  }
  return { connectionId: row.connectionId, connectionRevision: revision, role, alias };
}

function parseStep(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid funnel step");
  }
  const row = value as Record<string, unknown>;
  const optional = row.mappingProposalId === undefined ? [] : ["mappingProposalId"];
  const exact = exactRecord(row, [
    "id", "label", "meaning", "connectionRole", "entityKey", "timestampField",
    "orderingRule", "mappingState", ...optional, "graphNodeIds", "evidenceIds",
  ]);
  const mappingState = exact?.mappingState;
  if (!exact || typeof exact.id !== "string" || !ID.test(exact.id)
    || text(exact.label, 256) === null || text(exact.meaning, 4_000) === null
    || text(exact.connectionRole, 64) === null || text(exact.entityKey, 512) === null
    || text(exact.timestampField, 512) === null || text(exact.orderingRule, 2_000) === null
    || !(mappingState === "inferred" || mappingState === "confirmed")
    || (mappingState === "inferred" && exact.mappingProposalId !== undefined)
    || (mappingState === "confirmed"
      && (typeof exact.mappingProposalId !== "string" || !UUID.test(exact.mappingProposalId)))
    || !Array.isArray(exact.graphNodeIds) || exact.graphNodeIds.length < 1
    || exact.graphNodeIds.length > 64
    || exact.graphNodeIds.some((id) => typeof id !== "string" || !HASH.test(id))
    || !Array.isArray(exact.evidenceIds) || exact.evidenceIds.length > 64
    || exact.evidenceIds.some((id) => typeof id !== "string" || !HASH.test(id))) {
    throw new Error("Invalid funnel step");
  }
  return { ...exact };
}

function parseTile(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid funnel tile");
  }
  const row = value as Record<string, unknown>;
  const optional = [
    ...(row.dashboardId === undefined ? [] : ["dashboardId"]),
    ...(row.expectedDashboardRevision === undefined ? [] : ["expectedDashboardRevision"]),
    ...(row.queryRunId === undefined ? [] : ["queryRunId"]),
    ...(row.markdown === undefined ? [] : ["markdown"]),
  ];
  const exact = exactRecord(row, ["id", "title", "kind", ...optional, "stepIds"]);
  const kinds = ["metric", "funnel", "time_series", "breakdown", "table", "markdown"];
  if (!exact || typeof exact.id !== "string" || !ID.test(exact.id)
    || text(exact.title, 256) === null || typeof exact.kind !== "string"
    || !kinds.includes(exact.kind) || !Array.isArray(exact.stepIds)
    || exact.stepIds.length > 32
    || exact.stepIds.some((id) => typeof id !== "string" || !ID.test(id))) {
    throw new Error("Invalid funnel tile");
  }
  if (exact.kind === "markdown") {
    if (exact.dashboardId !== undefined || exact.expectedDashboardRevision !== undefined
      || exact.queryRunId !== undefined
      || text(exact.markdown, 32_000) === null) throw new Error("Invalid Markdown tile");
  } else if (typeof exact.dashboardId !== "string" || !UUID.test(exact.dashboardId)
    || positiveSafeInteger(exact.expectedDashboardRevision) === null
    || typeof exact.queryRunId !== "string" || !UUID.test(exact.queryRunId)
    || exact.markdown !== undefined || exact.stepIds.length === 0) {
    throw new Error("Invalid query tile");
  }
  return { ...exact };
}

function parseDefinition(value: unknown): FunnelAnalysisDefinition {
  const row = exactRecord(value, [
    "sourceAgent", "title", "question", "purpose", "timezone", "conversionWindowSeconds",
    "denominatorSemantics", "numeratorSemantics", "deduplicationPolicy",
    "lateEventPolicy", "steps", "tiles", "warnings",
  ]);
  const sourceAgent = row?.sourceAgent;
  const title = text(row?.title, 256);
  const question = text(row?.question, 8_000);
  const purpose = text(row?.purpose, 8_000);
  const timezone = text(row?.timezone, 128);
  const denominatorSemantics = text(row?.denominatorSemantics, 4_000);
  const numeratorSemantics = text(row?.numeratorSemantics, 4_000);
  const deduplicationPolicy = text(row?.deduplicationPolicy, 4_000);
  const lateEventPolicy = text(row?.lateEventPolicy, 4_000);
  const window = positiveSafeInteger(row?.conversionWindowSeconds);
  if (!row || !(sourceAgent === "dopedb.acp.claude" || sourceAgent === "dopedb.acp.codex")
    || title === null || question === null || purpose === null || timezone === null
    || denominatorSemantics === null || numeratorSemantics === null
    || deduplicationPolicy === null || lateEventPolicy === null
    || window === null || window > 31_622_400
    || !Array.isArray(row.steps) || row.steps.length < 1 || row.steps.length > 32
    || !Array.isArray(row.tiles) || row.tiles.length < 1 || row.tiles.length > 32
    || !Array.isArray(row.warnings) || row.warnings.length > 32) {
    throw new Error("Invalid funnel analysis definition");
  }
  const steps = row.steps.map(parseStep);
  const stepIds = new Set(steps.map((step) => step.id));
  if (stepIds.size !== steps.length) throw new Error("Duplicate funnel step id");
  const tiles = row.tiles.map(parseTile);
  if (new Set(tiles.map((tile) => tile.id)).size !== tiles.length
    || tiles.some((tile) => (tile.stepIds as string[]).some((id) => !stepIds.has(id)))) {
    throw new Error("Invalid funnel tile references");
  }
  const warnings = row.warnings.map((warning) => text(warning, 2_000));
  if (warnings.some((warning) => warning === null)) throw new Error("Invalid funnel warning");
  return {
    sourceAgent, title, question, purpose, timezone, conversionWindowSeconds: window,
    denominatorSemantics, numeratorSemantics, deduplicationPolicy, lateEventPolicy,
    steps, tiles, warnings: warnings as string[],
  };
}

export function parseSharedFunnelAnalysisCreate(value: unknown): SharedFunnelAnalysisCreate {
  const row = exactRecord(value, [
    "id", "projectEnvironmentId", "environmentRevision", "sourceKnowledgeGrantId",
    "graphRevisionIds", "connections", "definition",
  ]);
  const environmentRevision = positiveSafeInteger(row?.environmentRevision);
  if (!row || typeof row.id !== "string" || !UUID.test(row.id)
    || typeof row.projectEnvironmentId !== "string" || !UUID.test(row.projectEnvironmentId)
    || typeof row.sourceKnowledgeGrantId !== "string" || !UUID.test(row.sourceKnowledgeGrantId)
    || environmentRevision === null || !Array.isArray(row.graphRevisionIds)
    || row.graphRevisionIds.length < 1 || row.graphRevisionIds.length > 32
    || row.graphRevisionIds.some((id) => typeof id !== "string" || !UUID.test(id))
    || !Array.isArray(row.connections) || row.connections.length < 1 || row.connections.length > 32) {
    throw new Error("Invalid funnel analysis authority");
  }
  const connections = row.connections.map(parseConnection);
  if (new Set(connections.map((connection) => connection.connectionId)).size !== connections.length
    || new Set(row.graphRevisionIds).size !== row.graphRevisionIds.length) {
    throw new Error("Duplicate funnel analysis authority");
  }
  const definition = parseDefinition(row.definition);
  const roles = new Set(connections.map((connection) => connection.role));
  if (definition.steps.some((step) => !roles.has(String(step.connectionRole)))) {
    throw new Error("Funnel step references an unknown connection role");
  }
  return {
    id: row.id,
    projectEnvironmentId: row.projectEnvironmentId,
    environmentRevision,
    sourceKnowledgeGrantId: row.sourceKnowledgeGrantId,
    graphRevisionIds: row.graphRevisionIds as string[],
    connections,
    definition,
  };
}

export function publicFunnelAnalysis(row: {
  id: string;
  projectEnvironmentId: string;
  environmentRevision: number;
  sourceKnowledgeGrantId: string;
  definition: unknown;
  state: string;
  ownerMemberId: string;
  updatedByMemberId: string;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}, graphRevisionIds: string[], connections: FunnelAnalysisConnection[]) {
  if (!UUID.test(row.id) || !UUID.test(row.projectEnvironmentId)
    || !UUID.test(row.sourceKnowledgeGrantId) || !funnelAnalysisStates.includes(row.state as FunnelAnalysisState)
    || positiveSafeInteger(row.environmentRevision) === null || positiveSafeInteger(row.revision) === null
    || Number.isNaN(row.createdAt.valueOf()) || Number.isNaN(row.updatedAt.valueOf())) {
    throw new Error("Invalid stored funnel analysis");
  }
  return {
    id: row.id,
    projectEnvironmentId: row.projectEnvironmentId,
    environmentRevision: row.environmentRevision,
    sourceKnowledgeGrantId: row.sourceKnowledgeGrantId,
    graphRevisionIds,
    connections,
    definition: parseDefinition(row.definition),
    state: row.state as FunnelAnalysisState,
    ownerMemberId: row.ownerMemberId,
    updatedByMemberId: row.updatedByMemberId,
    revision: row.revision,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
