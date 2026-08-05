// Runtime-neutral, secret-free contract for shared dashboard definitions. This
// module deliberately has no result-row, credential, parameter-value, or local
// history representation. Desktop execution revalidates the SQL through the
// native read-only safety path before touching a database.

export const dashboardStates = ["draft", "published", "archived"] as const;
export const dashboardKinds = ["auto", "metric", "line", "bar", "table"] as const;

export type DashboardState = (typeof dashboardStates)[number];
export type DashboardKind = (typeof dashboardKinds)[number];

export type SharedDashboardVisualization = Readonly<{
  version: 1;
  kind: DashboardKind;
  xColumn: string | null;
  yColumns: readonly string[];
}>;

export type SharedDashboardDefinition = Readonly<{
  title: string;
  description: string;
  sql: string;
  visualization: SharedDashboardVisualization;
}>;

export type SharedDashboardCreate = SharedDashboardDefinition & Readonly<{
  id: string;
  connectionId: string;
}>;

export type DashboardVersionPayload = SharedDashboardDefinition & Readonly<{
  connectionId: string;
  state: DashboardState;
  ownerMemberId: string;
  deleted: boolean;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UNSAFE_DISPLAY = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u;

function exactRecord(value: unknown, fields: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === fields.length
    && fields.every((field) => Object.prototype.hasOwnProperty.call(record, field))
    ? record
    : null;
}

function displayText(value: unknown, maxChars: number, allowEmpty = false) {
  if (typeof value !== "string" || UNSAFE_DISPLAY.test(value)) return null;
  const trimmed = value.trim();
  if ((!allowEmpty && trimmed.length === 0) || [...value].length > maxChars) return null;
  return allowEmpty ? value : trimmed;
}

function column(value: unknown) {
  return displayText(value, 256);
}

function parseVisualization(value: unknown): SharedDashboardVisualization {
  const row = exactRecord(value, ["version", "kind", "xColumn", "yColumns"]);
  if (
    !row
    || row.version !== 1
    || typeof row.kind !== "string"
    || !dashboardKinds.includes(row.kind as DashboardKind)
    || !(row.xColumn === null || column(row.xColumn) !== null)
    || !Array.isArray(row.yColumns)
    || row.yColumns.length > 4
  ) {
    throw new Error("Invalid dashboard visualization");
  }
  const yColumns = row.yColumns.map(column);
  if (
    yColumns.some((item) => item === null)
    || new Set(yColumns).size !== yColumns.length
  ) {
    throw new Error("Invalid dashboard visualization columns");
  }
  return {
    version: 1,
    kind: row.kind as DashboardKind,
    xColumn: row.xColumn === null ? null : column(row.xColumn),
    yColumns: yColumns as string[],
  };
}

function parseDefinitionRecord(row: Record<string, unknown>): SharedDashboardDefinition {
  const title = displayText(row.title, 120);
  const description = displayText(row.description, 2_000, true);
  if (
    title === null
    || description === null
    || typeof row.sql !== "string"
    || row.sql.trim().length === 0
    || new TextEncoder().encode(row.sql).byteLength > 100_000
    || row.sql.includes("\u0000")
  ) {
    throw new Error("Invalid dashboard definition");
  }
  return {
    title,
    description,
    sql: row.sql,
    visualization: parseVisualization(row.visualization),
  };
}

export function parseSharedDashboardCreate(value: unknown): SharedDashboardCreate {
  const row = exactRecord(value, [
    "id",
    "connectionId",
    "title",
    "description",
    "sql",
    "visualization",
  ]);
  if (!row || typeof row.id !== "string" || !UUID.test(row.id)
    || typeof row.connectionId !== "string" || !UUID.test(row.connectionId)) {
    throw new Error("Invalid dashboard identity");
  }
  return {
    id: row.id,
    connectionId: row.connectionId,
    ...parseDefinitionRecord(row),
  };
}

export function parseSharedDashboardDefinition(value: unknown): SharedDashboardDefinition {
  const row = exactRecord(value, ["title", "description", "sql", "visualization"]);
  if (!row) throw new Error("Invalid dashboard definition");
  return parseDefinitionRecord(row);
}

export function isDashboardState(value: unknown): value is DashboardState {
  return typeof value === "string" && dashboardStates.includes(value as DashboardState);
}

export function dashboardVersionPayload(input: {
  connectionId: string;
  definition: SharedDashboardDefinition;
  state: DashboardState;
  ownerMemberId: string;
  deleted?: boolean;
}): DashboardVersionPayload {
  if (!UUID.test(input.connectionId) || !input.ownerMemberId) {
    throw new Error("Invalid dashboard version authority");
  }
  return {
    connectionId: input.connectionId,
    title: input.definition.title,
    description: input.definition.description,
    sql: input.definition.sql,
    visualization: input.definition.visualization,
    state: input.state,
    ownerMemberId: input.ownerMemberId,
    deleted: input.deleted ?? false,
  };
}

export function parseDashboardVersionPayload(value: unknown): DashboardVersionPayload {
  const row = exactRecord(value, [
    "connectionId",
    "title",
    "description",
    "sql",
    "visualization",
    "state",
    "ownerMemberId",
    "deleted",
  ]);
  if (
    !row
    || typeof row.connectionId !== "string"
    || !UUID.test(row.connectionId)
    || !isDashboardState(row.state)
    || typeof row.ownerMemberId !== "string"
    || row.ownerMemberId.length === 0
    || typeof row.deleted !== "boolean"
  ) {
    throw new Error("Invalid dashboard revision payload");
  }
  return {
    connectionId: row.connectionId,
    ...parseDefinitionRecord(row),
    state: row.state,
    ownerMemberId: row.ownerMemberId,
    deleted: row.deleted,
  };
}

export function publicDashboard(row: {
  id: string;
  connectionId: string;
  title: string;
  description: string;
  sql: string;
  visualization: unknown;
  state: string;
  ownerMemberId: string;
  updatedByMemberId: string;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}) {
  const definition = parseSharedDashboardDefinition({
    title: row.title,
    description: row.description,
    sql: row.sql,
    visualization: row.visualization,
  });
  if (!UUID.test(row.id) || !UUID.test(row.connectionId)
    || !isDashboardState(row.state)
    || typeof row.ownerMemberId !== "string"
    || typeof row.updatedByMemberId !== "string"
    || !Number.isSafeInteger(row.revision) || row.revision < 1
    || Number.isNaN(row.createdAt.valueOf()) || Number.isNaN(row.updatedAt.valueOf())) {
    throw new Error("Invalid stored dashboard");
  }
  return {
    id: row.id,
    connectionId: row.connectionId,
    ...definition,
    state: row.state,
    ownerMemberId: row.ownerMemberId,
    updatedByMemberId: row.updatedByMemberId,
    revision: row.revision,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
