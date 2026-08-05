// Runtime-neutral, secret-free contract for evidence-bound Agent reports.
// Shared evidence is deliberately limited to the exact successful query-run
// identity, SQL text, and execution time. Result rows, local artifact handles,
// credentials, and Agent transcripts have no representation in this module.

export const reportStates = ["draft", "review", "published", "archived"] as const;
export const reportSources = ["human", "agent_proposal"] as const;

export type ReportState = (typeof reportStates)[number];
export type ReportSource = (typeof reportSources)[number];

export type SharedReportEvidence = Readonly<{
  id: string;
  queryRunId: string;
  sql: string;
  executedAt: string;
}>;

export type SharedReportClaim = Readonly<{
  id: string;
  statement: string;
  evidenceIds: readonly string[];
}>;

export type SharedReportDefinition = Readonly<{
  title: string;
  question: string;
  conclusion: string;
  preflightWarnings: readonly string[];
  claims: readonly SharedReportClaim[];
}>;

export type SharedReportCreate = SharedReportDefinition & Readonly<{
  id: string;
  connectionId: string;
  evidence: readonly SharedReportEvidence[];
}>;

export type SharedReportEvidenceAppend = Readonly<{
  connectionId: string;
  claims: readonly SharedReportClaim[];
  evidence: readonly SharedReportEvidence[];
}>;

export type ReportVersionPayload = SharedReportDefinition & Readonly<{
  connectionId: string;
  state: ReportState;
  source: ReportSource;
  ownerMemberId: string;
  deleted: boolean;
}>;

export const MAX_REPORT_EVIDENCE = 32;
export const MAX_REPORT_STORED_EVIDENCE = 256;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RFC3339_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i;
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

function parseEvidence(value: unknown): SharedReportEvidence {
  const row = exactRecord(value, ["id", "queryRunId", "sql", "executedAt"]);
  if (
    !row
    || typeof row.id !== "string"
    || !UUID.test(row.id)
    || typeof row.queryRunId !== "string"
    || !UUID.test(row.queryRunId)
    || typeof row.sql !== "string"
    || row.sql.trim().length === 0
    || row.sql.includes("\u0000")
    || new TextEncoder().encode(row.sql).byteLength > 20_000
    || typeof row.executedAt !== "string"
    || !RFC3339_WITH_ZONE.test(row.executedAt)
  ) {
    throw new Error("Invalid report evidence");
  }
  const executedAt = new Date(row.executedAt);
  if (Number.isNaN(executedAt.valueOf()) || executedAt.valueOf() > Date.now() + 5 * 60_000) {
    throw new Error("Invalid report evidence timestamp");
  }
  return {
    id: row.id.toLowerCase(),
    queryRunId: row.queryRunId.toLowerCase(),
    sql: row.sql,
    executedAt: executedAt.toISOString(),
  };
}

function parseClaim(value: unknown): SharedReportClaim {
  const row = exactRecord(value, ["id", "statement", "evidenceIds"]);
  const statement = row ? displayText(row.statement, 4_000) : null;
  if (
    !row
    || typeof row.id !== "string"
    || !UUID.test(row.id)
    || statement === null
    || !Array.isArray(row.evidenceIds)
    || row.evidenceIds.length < 1
    || row.evidenceIds.length > 8
    || row.evidenceIds.some((id) => typeof id !== "string" || !UUID.test(id))
  ) {
    throw new Error("Invalid report claim");
  }
  const evidenceIds = row.evidenceIds.map((id) => (id as string).toLowerCase());
  if (new Set(evidenceIds).size !== evidenceIds.length) {
    throw new Error("Invalid report claim evidence");
  }
  return {
    id: row.id.toLowerCase(),
    statement,
    evidenceIds,
  };
}

function parseDefinitionRecord(row: Record<string, unknown>): SharedReportDefinition {
  const title = displayText(row.title, 120);
  const question = displayText(row.question, 8_000);
  const conclusion = displayText(row.conclusion, 20_000);
  if (
    title === null
    || question === null
    || conclusion === null
    || !Array.isArray(row.preflightWarnings)
    || row.preflightWarnings.length > 32
    || !Array.isArray(row.claims)
    || row.claims.length < 1
    || row.claims.length > 32
  ) {
    throw new Error("Invalid report definition");
  }
  const preflightWarnings = row.preflightWarnings.map((warning) => displayText(warning, 2_000));
  if (preflightWarnings.some((warning) => warning === null)) {
    throw new Error("Invalid report warnings");
  }
  const claims = row.claims.map(parseClaim);
  if (new Set(claims.map((claim) => claim.id)).size !== claims.length) {
    throw new Error("Invalid report claim identities");
  }
  const evidenceIds = evidenceIdsForClaims(claims);
  if (evidenceIds.length > MAX_REPORT_EVIDENCE) {
    throw new Error("Report references too much evidence");
  }
  return {
    title,
    question,
    conclusion,
    preflightWarnings: preflightWarnings as string[],
    claims,
  };
}

export function evidenceIdsForClaims(claims: readonly SharedReportClaim[]) {
  return [...new Set(claims.flatMap((claim) => claim.evidenceIds))].sort();
}

export function parseSharedReportCreate(value: unknown): SharedReportCreate {
  const row = exactRecord(value, [
    "id",
    "connectionId",
    "title",
    "question",
    "conclusion",
    "preflightWarnings",
    "claims",
    "evidence",
  ]);
  if (
    !row
    || typeof row.id !== "string"
    || !UUID.test(row.id)
    || typeof row.connectionId !== "string"
    || !UUID.test(row.connectionId)
    || !Array.isArray(row.evidence)
    || row.evidence.length < 1
    || row.evidence.length > MAX_REPORT_EVIDENCE
  ) {
    throw new Error("Invalid report identity");
  }
  const definition = parseDefinitionRecord(row);
  const evidence = row.evidence.map(parseEvidence);
  if (
    new Set(evidence.map((item) => item.id)).size !== evidence.length
    || new Set(evidence.map((item) => item.queryRunId)).size !== evidence.length
  ) {
    throw new Error("Invalid report evidence identities");
  }
  const suppliedIds = evidence.map((item) => item.id).sort();
  const referencedIds = evidenceIdsForClaims(definition.claims);
  if (
    suppliedIds.length !== referencedIds.length
    || suppliedIds.some((id, index) => id !== referencedIds[index])
  ) {
    throw new Error("Every report evidence record must support a claim");
  }
  return {
    id: row.id.toLowerCase(),
    connectionId: row.connectionId.toLowerCase(),
    ...definition,
    evidence,
  };
}

export function parseSharedReportEvidenceAppend(value: unknown): SharedReportEvidenceAppend {
  const row = exactRecord(value, ["connectionId", "claims", "evidence"]);
  if (
    !row
    || typeof row.connectionId !== "string"
    || !UUID.test(row.connectionId)
    || !Array.isArray(row.claims)
    || row.claims.length < 1
    || row.claims.length > 32
    || !Array.isArray(row.evidence)
    || row.evidence.length < 1
    || row.evidence.length > MAX_REPORT_EVIDENCE
  ) {
    throw new Error("Invalid report evidence append");
  }
  const claims = row.claims.map(parseClaim);
  const evidence = row.evidence.map(parseEvidence);
  if (
    new Set(claims.map((claim) => claim.id)).size !== claims.length
    || new Set(evidence.map((item) => item.id)).size !== evidence.length
    || new Set(evidence.map((item) => item.queryRunId)).size !== evidence.length
  ) {
    throw new Error("Invalid appended report identities");
  }
  const suppliedIds = evidence.map((item) => item.id).sort();
  const referencedIds = evidenceIdsForClaims(claims);
  if (
    suppliedIds.length !== referencedIds.length
    || suppliedIds.some((id, index) => id !== referencedIds[index])
  ) {
    throw new Error("Every appended report evidence record must support a new claim");
  }
  return {
    connectionId: row.connectionId.toLowerCase(),
    claims,
    evidence,
  };
}

export function parseSharedReportDefinition(value: unknown): SharedReportDefinition {
  const row = exactRecord(value, [
    "title",
    "question",
    "conclusion",
    "preflightWarnings",
    "claims",
  ]);
  if (!row) throw new Error("Invalid report definition");
  return parseDefinitionRecord(row);
}

export function parseSharedReportEvidenceList(value: unknown) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_REPORT_EVIDENCE) {
    throw new Error("Invalid report evidence list");
  }
  const evidence = value.map(parseEvidence);
  if (
    new Set(evidence.map((item) => item.id)).size !== evidence.length
    || new Set(evidence.map((item) => item.queryRunId)).size !== evidence.length
  ) {
    throw new Error("Invalid report evidence identities");
  }
  return evidence;
}

export function isReportState(value: unknown): value is ReportState {
  return typeof value === "string" && reportStates.includes(value as ReportState);
}

export function isReportSource(value: unknown): value is ReportSource {
  return typeof value === "string" && reportSources.includes(value as ReportSource);
}

export function reportVersionPayload(input: {
  connectionId: string;
  definition: SharedReportDefinition;
  state: ReportState;
  source: ReportSource;
  ownerMemberId: string;
  deleted?: boolean;
}): ReportVersionPayload {
  if (!UUID.test(input.connectionId) || !input.ownerMemberId) {
    throw new Error("Invalid report version authority");
  }
  return {
    connectionId: input.connectionId.toLowerCase(),
    title: input.definition.title,
    question: input.definition.question,
    conclusion: input.definition.conclusion,
    preflightWarnings: input.definition.preflightWarnings,
    claims: input.definition.claims,
    state: input.state,
    source: input.source,
    ownerMemberId: input.ownerMemberId,
    deleted: input.deleted ?? false,
  };
}

export function parseReportVersionPayload(value: unknown): ReportVersionPayload {
  const row = exactRecord(value, [
    "connectionId",
    "title",
    "question",
    "conclusion",
    "preflightWarnings",
    "claims",
    "state",
    "source",
    "ownerMemberId",
    "deleted",
  ]);
  if (
    !row
    || typeof row.connectionId !== "string"
    || !UUID.test(row.connectionId)
    || !isReportState(row.state)
    || !isReportSource(row.source)
    || typeof row.ownerMemberId !== "string"
    || row.ownerMemberId.length === 0
    || typeof row.deleted !== "boolean"
  ) {
    throw new Error("Invalid report revision payload");
  }
  return {
    connectionId: row.connectionId.toLowerCase(),
    ...parseDefinitionRecord(row),
    state: row.state,
    source: row.source,
    ownerMemberId: row.ownerMemberId,
    deleted: row.deleted,
  };
}

type StoredReportShape = {
  id: string;
  connectionId: string;
  title: string;
  question: string;
  conclusion: string;
  preflightWarnings: unknown;
  claims: unknown;
  state: string;
  source: string;
  ownerMemberId: string;
  updatedByMemberId: string;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
};

export function publicReportSummary(row: StoredReportShape, evidenceCount: number) {
  const definition = parseSharedReportDefinition({
    title: row.title,
    question: row.question,
    conclusion: row.conclusion,
    preflightWarnings: row.preflightWarnings,
    claims: row.claims,
  });
  if (
    !UUID.test(row.id)
    || !UUID.test(row.connectionId)
    || !isReportState(row.state)
    || !isReportSource(row.source)
    || typeof row.ownerMemberId !== "string"
    || typeof row.updatedByMemberId !== "string"
    || !Number.isSafeInteger(row.revision)
    || row.revision < 1
    || !Number.isSafeInteger(evidenceCount)
    || evidenceCount < 1
    || evidenceCount > MAX_REPORT_STORED_EVIDENCE
    || Number.isNaN(row.createdAt.valueOf())
    || Number.isNaN(row.updatedAt.valueOf())
  ) {
    throw new Error("Invalid stored report");
  }
  return {
    id: row.id,
    connectionId: row.connectionId,
    ...definition,
    state: row.state,
    source: row.source,
    ownerMemberId: row.ownerMemberId,
    updatedByMemberId: row.updatedByMemberId,
    revision: row.revision,
    evidenceCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function publicReportEvidence(row: {
  id: string;
  queryRunId: string;
  sql: string;
  executedAt: Date;
  addedAtRevision: number;
  createdByMemberId: string;
  createdAt: Date;
}) {
  const evidence = parseEvidence({
    id: row.id,
    queryRunId: row.queryRunId,
    sql: row.sql,
    executedAt: row.executedAt.toISOString(),
  });
  if (
    !Number.isSafeInteger(row.addedAtRevision)
    || row.addedAtRevision < 1
    || !row.createdByMemberId
    || Number.isNaN(row.createdAt.valueOf())
  ) {
    throw new Error("Invalid stored report evidence");
  }
  return {
    ...evidence,
    addedAtRevision: row.addedAtRevision,
    createdByMemberId: row.createdByMemberId,
    createdAt: row.createdAt.toISOString(),
  };
}
