// Atomic persistence for evidence-bound reports. Every write rechecks the live
// session, membership, connection grant, report owner, and exact revision in the
// same PostgreSQL statement that appends evidence, history, and audit.
import "server-only";

import { sql } from "drizzle-orm";

import { db } from "./db";
import { revocationGateLockKey } from "./revocation-gates";
import {
  workspaceAuditEvent,
  workspaceConnection,
  workspaceConnectionGrant,
  workspaceReport,
  workspaceReportEvidence,
  workspaceReportRevision,
} from "./schema";
import {
  evidenceIdsForClaims,
  MAX_REPORT_STORED_EVIDENCE,
  reportVersionPayload,
  type ReportSource,
  type ReportState,
  type ReportVersionPayload,
  type SharedReportCreate,
  type SharedReportDefinition,
  type SharedReportEvidence,
} from "./workspace-reports";
import { canonicalHash } from "./workspace-versioning";

export type ReportMutationAuthority = Readonly<{
  sessionId: string;
  userId: string;
  membershipId: string;
  role: string;
}>;

export type StoredReport = Readonly<{
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
  evidenceCount: number;
  createdAt: Date;
  updatedAt: Date;
}>;

export type StoredReportEvidence = Readonly<{
  id: string;
  queryRunId: string;
  sql: string;
  executedAt: Date;
  addedAtRevision: number;
  createdByMemberId: string;
  createdAt: Date;
}>;

type RawRow = Record<string, unknown>;

function safeInteger(value: unknown, minimum: number) {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string"
      ? Number(value)
      : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : null;
}

function date(value: unknown) {
  const parsed = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(parsed.valueOf()) ? null : parsed;
}

export function returnedReport(row: RawRow | undefined): StoredReport | null {
  if (!row) return null;
  const revision = safeInteger(row.revision, 1);
  const evidenceCount = safeInteger(row.evidenceCount, 1);
  const createdAt = date(row.createdAt);
  const updatedAt = date(row.updatedAt);
  if (
    typeof row.id !== "string"
    || typeof row.connectionId !== "string"
    || typeof row.title !== "string"
    || typeof row.question !== "string"
    || typeof row.conclusion !== "string"
    || typeof row.state !== "string"
    || typeof row.source !== "string"
    || typeof row.ownerMemberId !== "string"
    || typeof row.updatedByMemberId !== "string"
    || revision === null
    || evidenceCount === null
    || evidenceCount > MAX_REPORT_STORED_EVIDENCE
    || createdAt === null
    || updatedAt === null
  ) return null;
  return {
    id: row.id,
    connectionId: row.connectionId,
    title: row.title,
    question: row.question,
    conclusion: row.conclusion,
    preflightWarnings: row.preflightWarnings,
    claims: row.claims,
    state: row.state,
    source: row.source,
    ownerMemberId: row.ownerMemberId,
    updatedByMemberId: row.updatedByMemberId,
    revision,
    evidenceCount,
    createdAt,
    updatedAt,
  };
}

export function returnedReportEvidence(row: RawRow): StoredReportEvidence | null {
  const executedAt = date(row.executedAt);
  const createdAt = date(row.createdAt);
  const addedAtRevision = safeInteger(row.addedAtRevision, 1);
  if (
    typeof row.id !== "string"
    || typeof row.queryRunId !== "string"
    || typeof row.sql !== "string"
    || typeof row.createdByMemberId !== "string"
    || executedAt === null
    || createdAt === null
    || addedAtRevision === null
  ) return null;
  return {
    id: row.id,
    queryRunId: row.queryRunId,
    sql: row.sql,
    executedAt,
    addedAtRevision,
    createdByMemberId: row.createdByMemberId,
    createdAt,
  };
}

function memberLockKey(input: {
  organizationId: string;
  authority: ReportMutationAuthority;
}) {
  return revocationGateLockKey({
    kind: "member",
    organizationId: input.organizationId,
    memberId: input.authority.membershipId,
    userId: input.authority.userId,
  });
}

function reportColumns() {
  return sql`
    report."id"::text AS "id",
    report."connection_id"::text AS "connectionId",
    report."title" AS "title",
    report."question" AS "question",
    report."conclusion" AS "conclusion",
    report."preflight_warnings" AS "preflightWarnings",
    report."claims" AS "claims",
    report."state" AS "state",
    report."source" AS "source",
    report."owner_member_id" AS "ownerMemberId",
    report."updated_by_member_id" AS "updatedByMemberId",
    report."revision" AS "revision",
    report."created_at" AS "createdAt",
    report."updated_at" AS "updatedAt"`;
}

function evidencePayload(evidence: readonly SharedReportEvidence[]) {
  return evidence.map((item) => ({
    ...item,
    queryHash: canonicalHash({ sql: item.sql }),
  }));
}

export async function commitReportCreate(input: {
  organizationId: string;
  report: SharedReportCreate;
  source: ReportSource;
  authority: ReportMutationAuthority;
}): Promise<StoredReport | null> {
  const operation = input.source === "agent_proposal" ? "propose" : "create";
  const payload = reportVersionPayload({
    connectionId: input.report.connectionId,
    definition: input.report,
    state: "draft",
    source: input.source,
    ownerMemberId: input.authority.membershipId,
  });
  const evidence = evidencePayload(input.report.evidence);
  const requestId = crypto.randomUUID();
  const result = await db.execute<RawRow>(sql`
    WITH authority_lock AS MATERIALIZED (
      SELECT pg_advisory_xact_lock(hashtextextended(${memberLockKey(input)}, 0))
    ), authority AS MATERIALIZED (
      SELECT member."id"
      FROM "workspace_control"."session" session
      JOIN "workspace_control"."member" member
        ON member."id" = ${input.authority.membershipId}
       AND member."organization_id" = ${input.organizationId}
       AND member."user_id" = ${input.authority.userId}
      JOIN ${workspaceConnectionGrant} AS connection_grant
        ON connection_grant."organization_id" = ${input.organizationId}
       AND connection_grant."connection_id" = ${input.report.connectionId}::uuid
       AND connection_grant."member_id" = member."id"
       AND connection_grant."capability" IN ('use', 'manage')
      JOIN ${workspaceConnection} AS connection
        ON connection."organization_id" = connection_grant."organization_id"
       AND connection."id" = connection_grant."connection_id"
       AND connection."deleted_at" IS NULL
       AND connection."revocation_pending_at" IS NULL
      JOIN authority_lock ON TRUE
      WHERE session."id" = ${input.authority.sessionId}
        AND session."user_id" = ${input.authority.userId}
        AND session."expires_at" > now()
        AND member."role" = ${input.authority.role}
        AND member."role" IN ('editor', 'admin', 'owner')
        AND member."revocation_pending_at" IS NULL
        AND member."revocation_claim_id" IS NULL
      FOR UPDATE OF session, member, connection_grant, connection
    ), evidence_input AS MATERIALIZED (
      SELECT evidence.*
      FROM jsonb_to_recordset(${JSON.stringify(evidence)}::jsonb) AS evidence(
        "id" text,
        "queryRunId" text,
        "sql" text,
        "executedAt" text,
        "queryHash" text
      )
    ), inserted AS MATERIALIZED (
      INSERT INTO ${workspaceReport} AS report
        ("id", "organization_id", "connection_id", "title", "question", "conclusion",
         "preflight_warnings", "claims", "state", "source", "owner_member_id",
         "updated_by_member_id", "revision")
      SELECT ${input.report.id}::uuid, ${input.organizationId},
        ${input.report.connectionId}::uuid, ${input.report.title},
        ${input.report.question}, ${input.report.conclusion},
        ${JSON.stringify(input.report.preflightWarnings)}::jsonb,
        ${JSON.stringify(input.report.claims)}::jsonb, 'draft', ${input.source},
        authority."id", authority."id", 1
      FROM authority
      RETURNING report.*
    ), evidence_inserted AS MATERIALIZED (
      INSERT INTO ${workspaceReportEvidence}
        ("id", "organization_id", "report_id", "connection_id", "query_run_id",
         "sql", "query_hash", "executed_at", "added_at_revision",
         "created_by_user_id", "created_by_member_id")
      SELECT evidence_input."id"::uuid, ${input.organizationId}, inserted."id",
        inserted."connection_id", evidence_input."queryRunId"::uuid,
        evidence_input."sql", evidence_input."queryHash",
        evidence_input."executedAt"::timestamptz, 1,
        ${input.authority.userId}, ${input.authority.membershipId}
      FROM inserted CROSS JOIN evidence_input
      RETURNING "report_id"
    ), revision AS MATERIALIZED (
      INSERT INTO ${workspaceReportRevision}
        ("organization_id", "report_id", "revision", "base_revision", "operation",
         "payload", "payload_hash", "created_by_user_id", "created_by_member_id")
      SELECT ${input.organizationId}, inserted."id", 1, 0, ${operation},
        ${JSON.stringify(payload)}::jsonb, ${canonicalHash(payload)},
        ${input.authority.userId}, ${input.authority.membershipId}
      FROM inserted
      WHERE (SELECT count(*) FROM evidence_inserted) = ${evidence.length}
      RETURNING "report_id"
    ), audit AS MATERIALIZED (
      INSERT INTO ${workspaceAuditEvent}
        ("organization_id", "actor_user_id", "action", "resource_type", "resource_id",
         "redacted_summary", "request_id")
      SELECT ${input.organizationId}, ${input.authority.userId},
        ${input.source === "agent_proposal" ? "report.propose" : "report.create"},
        'report', inserted."id"::text,
        jsonb_build_object(
          'connectionId', inserted."connection_id",
          'title', inserted."title",
          'state', inserted."state",
          'source', inserted."source",
          'revision', inserted."revision",
          'evidenceCount', ${evidence.length}::bigint
        ), ${requestId}::uuid
      FROM inserted JOIN revision ON revision."report_id" = inserted."id"
      RETURNING "resource_id"
    )
    SELECT ${reportColumns()}, ${evidence.length}::bigint AS "evidenceCount"
    FROM inserted report
    JOIN audit ON audit."resource_id" = report."id"::text
  `);
  return returnedReport(result.rows[0]);
}

export type ReportMutationOperation =
  | "update"
  | "submit_review"
  | "return_draft"
  | "publish"
  | "archive"
  | "restore"
  | "transfer"
  | "append_evidence"
  | "delete";

export async function commitReportMutation(input: {
  organizationId: string;
  reportId: string;
  connectionId: string;
  expectedRevision: number;
  definition: SharedReportDefinition;
  state: ReportState;
  source: ReportSource;
  ownerMemberId: string;
  authority: ReportMutationAuthority;
  operation: ReportMutationOperation;
  evidence?: readonly SharedReportEvidence[];
}): Promise<StoredReport | null> {
  const deleted = input.operation === "delete";
  const payload: ReportVersionPayload = reportVersionPayload({
    connectionId: input.connectionId,
    definition: input.definition,
    state: input.state,
    source: input.source,
    ownerMemberId: input.ownerMemberId,
    deleted,
  });
  const nextRevision = input.expectedRevision + 1;
  if (!Number.isSafeInteger(nextRevision) || nextRevision > 9_007_199_254_740_991) {
    throw new Error("Invalid report revision");
  }
  const evidence = evidencePayload(input.evidence ?? []);
  const referencedEvidenceIds = evidenceIdsForClaims(input.definition.claims);
  if (evidence.some((item) => !referencedEvidenceIds.includes(item.id))) {
    throw new Error("New report evidence must support a claim");
  }
  const requestId = crypto.randomUUID();
  const result = await db.execute<RawRow>(sql`
    WITH authority_lock AS MATERIALIZED (
      SELECT pg_advisory_xact_lock(hashtextextended(${memberLockKey(input)}, 0))
    ), authority AS MATERIALIZED (
      SELECT member."id", member."role"
      FROM "workspace_control"."session" session
      JOIN "workspace_control"."member" member
        ON member."id" = ${input.authority.membershipId}
       AND member."organization_id" = ${input.organizationId}
       AND member."user_id" = ${input.authority.userId}
      JOIN authority_lock ON TRUE
      WHERE session."id" = ${input.authority.sessionId}
        AND session."user_id" = ${input.authority.userId}
        AND session."expires_at" > now()
        AND member."role" = ${input.authority.role}
        AND member."role" IN ('editor', 'admin', 'owner')
        AND member."revocation_pending_at" IS NULL
        AND member."revocation_claim_id" IS NULL
      FOR UPDATE OF session, member
    ), target_owner AS MATERIALIZED (
      SELECT owner."id"
      FROM "workspace_control"."member" owner
      JOIN authority ON TRUE
      WHERE owner."organization_id" = ${input.organizationId}
        AND owner."id" = ${input.ownerMemberId}
        AND owner."role" IN ('editor', 'admin', 'owner')
        AND owner."revocation_pending_at" IS NULL
        AND owner."revocation_claim_id" IS NULL
      FOR UPDATE OF owner
    ), current AS MATERIALIZED (
      SELECT report."id", report."organization_id", report."connection_id", (
        SELECT count(*) FROM ${workspaceReportEvidence} stored_evidence
        WHERE stored_evidence."organization_id" = report."organization_id"
          AND stored_evidence."report_id" = report."id"
      )::bigint AS "evidence_count"
      FROM ${workspaceReport} AS report
      JOIN authority ON TRUE
      JOIN target_owner ON TRUE
      JOIN ${workspaceConnectionGrant} AS connection_grant
        ON connection_grant."organization_id" = report."organization_id"
       AND connection_grant."connection_id" = report."connection_id"
       AND connection_grant."member_id" = authority."id"
       AND connection_grant."capability" IN ('use', 'manage')
      JOIN ${workspaceConnection} AS connection
        ON connection."organization_id" = report."organization_id"
       AND connection."id" = report."connection_id"
       AND connection."deleted_at" IS NULL
       AND connection."revocation_pending_at" IS NULL
      WHERE report."organization_id" = ${input.organizationId}
        AND report."id" = ${input.reportId}::uuid
        AND report."connection_id" = ${input.connectionId}::uuid
        AND report."revision" = ${input.expectedRevision}
        AND report."source" = ${input.source}
        AND report."deleted_at" IS NULL
        AND (report."owner_member_id" = authority."id"
          OR authority."role" IN ('admin', 'owner'))
        AND (
          SELECT count(*) FROM ${workspaceReportEvidence} stored_evidence
          WHERE stored_evidence."organization_id" = report."organization_id"
            AND stored_evidence."report_id" = report."id"
        ) + ${evidence.length} <= ${MAX_REPORT_STORED_EVIDENCE}
      FOR UPDATE OF report, connection_grant, connection
    ), evidence_input AS MATERIALIZED (
      SELECT evidence.*
      FROM jsonb_to_recordset(${JSON.stringify(evidence)}::jsonb) AS evidence(
        "id" text,
        "queryRunId" text,
        "sql" text,
        "executedAt" text,
        "queryHash" text
      )
    ), evidence_inserted AS MATERIALIZED (
      INSERT INTO ${workspaceReportEvidence}
        ("id", "organization_id", "report_id", "connection_id", "query_run_id",
         "sql", "query_hash", "executed_at", "added_at_revision",
         "created_by_user_id", "created_by_member_id")
      SELECT evidence_input."id"::uuid, ${input.organizationId}, current."id",
        current."connection_id", evidence_input."queryRunId"::uuid,
        evidence_input."sql", evidence_input."queryHash",
        evidence_input."executedAt"::timestamptz, ${nextRevision},
        ${input.authority.userId}, ${input.authority.membershipId}
      FROM current CROSS JOIN evidence_input
      RETURNING "id", "report_id"
    ), evidence_refs AS MATERIALIZED (
      SELECT value::uuid AS "id"
      FROM jsonb_array_elements_text(${JSON.stringify(referencedEvidenceIds)}::jsonb)
    ), valid_evidence AS MATERIALIZED (
      SELECT stored_evidence."id"
      FROM ${workspaceReportEvidence} stored_evidence
      JOIN current
        ON stored_evidence."organization_id" = current."organization_id"
       AND stored_evidence."report_id" = current."id"
      JOIN evidence_refs ON evidence_refs."id" = stored_evidence."id"
      UNION
      SELECT evidence_inserted."id"
      FROM evidence_inserted
      JOIN evidence_refs ON evidence_refs."id" = evidence_inserted."id"
    ), evidence_check AS MATERIALIZED (
      SELECT (SELECT count(*) FROM evidence_refs) AS "referenced_count",
             (SELECT count(*) FROM valid_evidence) AS "valid_count",
             (SELECT count(*) FROM evidence_inserted) AS "inserted_count"
    ), updated AS MATERIALIZED (
      UPDATE ${workspaceReport} AS report
      SET "title" = ${input.definition.title},
        "question" = ${input.definition.question},
        "conclusion" = ${input.definition.conclusion},
        "preflight_warnings" = ${JSON.stringify(input.definition.preflightWarnings)}::jsonb,
        "claims" = ${JSON.stringify(input.definition.claims)}::jsonb,
        "state" = ${input.state},
        "owner_member_id" = ${input.ownerMemberId},
        "updated_by_member_id" = ${input.authority.membershipId},
        "revision" = report."revision" + 1,
        "updated_at" = now(),
        "deleted_at" = CASE WHEN ${deleted} THEN now() ELSE NULL END
      FROM current, evidence_check
      WHERE report."organization_id" = current."organization_id"
        AND report."id" = current."id"
        AND report."revision" = ${input.expectedRevision}
        AND evidence_check."referenced_count" = ${referencedEvidenceIds.length}
        AND evidence_check."valid_count" = evidence_check."referenced_count"
        AND evidence_check."inserted_count" = ${evidence.length}
      RETURNING report.*
    ), revision AS MATERIALIZED (
      INSERT INTO ${workspaceReportRevision}
        ("organization_id", "report_id", "revision", "base_revision", "operation",
         "payload", "payload_hash", "created_by_user_id", "created_by_member_id")
      SELECT ${input.organizationId}, updated."id", updated."revision",
        ${input.expectedRevision}, ${input.operation}, ${JSON.stringify(payload)}::jsonb,
        ${canonicalHash(payload)}, ${input.authority.userId}, ${input.authority.membershipId}
      FROM updated
      RETURNING "report_id"
    ), audit AS MATERIALIZED (
      INSERT INTO ${workspaceAuditEvent}
        ("organization_id", "actor_user_id", "action", "resource_type", "resource_id",
         "redacted_summary", "request_id")
      SELECT ${input.organizationId}, ${input.authority.userId},
        ${`report.${input.operation}`}, 'report', updated."id"::text,
        jsonb_build_object(
          'connectionId', updated."connection_id",
          'title', updated."title",
          'state', updated."state",
          'source', updated."source",
          'revision', updated."revision",
          'ownerMemberId', updated."owner_member_id",
          'evidenceAdded', ${evidence.length}::bigint
        ), ${requestId}::uuid
      FROM updated JOIN revision ON revision."report_id" = updated."id"
      RETURNING "resource_id"
    )
    SELECT ${reportColumns()},
      (current."evidence_count" + ${evidence.length})::bigint AS "evidenceCount"
    FROM updated report
    JOIN current ON current."id" = report."id"
    JOIN audit ON audit."resource_id" = report."id"::text
  `);
  const report = returnedReport(result.rows[0]);
  if (report && report.revision !== nextRevision) {
    throw new Error("Report revision did not advance exactly once");
  }
  return report;
}
