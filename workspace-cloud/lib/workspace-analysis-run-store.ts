// Atomic run persistence for Desktop-executed Analysis Articles. The control
// plane never opens a database connection; it verifies exact pins and stores
// only receipts plus already-encrypted bounded fragments.
import "server-only";

import { sql } from "drizzle-orm";

import { db } from "./db";
import { revocationGateLockKey } from "./revocation-gates";
import {
  workspaceAnalysisArticle,
  workspaceAnalysisArticleConnection,
  workspaceAnalysisArticleQueryReceipt,
  workspaceAnalysisArticleRevision,
  workspaceAnalysisArticleRun,
  workspaceAnalysisRefreshLease,
  workspaceAnalysisResultFragment,
  workspaceAnalysisRunner,
  workspaceAuditEvent,
  workspaceConnection,
  workspaceConnectionGrant,
} from "./schema";
import type {
  AnalysisQueryReceiptInput,
  AnalysisRunCompletion,
  AnalysisRunRequest,
} from "./workspace-analysis-runs";
import { canonicalHash } from "./workspace-versioning";

export type AnalysisRunAuthority = Readonly<{
  sessionId: string;
  userId: string;
  membershipId: string;
  role: string;
}>;

export type SealedAnalysisFragment = Readonly<{
  blockId: string;
  ordinal: number;
  dataKeyId: string;
  keyReference: string;
  keyVersion: string;
  ciphertext: string;
  payloadHash: string;
  rowCount: number;
  plaintextBytes: number;
  expiresAt: Date;
}>;

type RawRow = Record<string, unknown>;

function memberLockKey(input: { organizationId: string; authority: AnalysisRunAuthority }) {
  return revocationGateLockKey({
    kind: "member",
    organizationId: input.organizationId,
    memberId: input.authority.membershipId,
    userId: input.authority.userId,
  });
}

function runProjection() {
  return sql`
    run."id"::text AS "id", run."article_id"::text AS "articleId",
    run."article_revision" AS "articleRevision", run."runner_id"::text AS "runnerId",
    run."lease_id"::text AS "leaseId", run."trigger" AS "trigger",
    run."state" AS "state", run."parameter_values" AS "parameterValues",
    run."parameter_hash" AS "parameterHash", run."definition_hash" AS "definitionHash",
    run."schema_fingerprints" AS "schemaFingerprints", run."row_count" AS "rowCount",
    run."byte_count" AS "byteCount", run."result_hash" AS "resultHash",
    run."error_kind" AS "errorKind", run."error_message" AS "errorMessage",
    run."cancel_requested_at" AS "cancelRequestedAt",
    run."cancel_requested_by_member_id" AS "cancelRequestedByMemberId",
    run."started_at" AS "startedAt", run."finished_at" AS "finishedAt",
    run."created_at" AS "createdAt"`;
}

export async function requestAnalysisRunCancellation(input: {
  organizationId: string;
  articleId: string;
  runId: string;
  authority: AnalysisRunAuthority;
}) {
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
        AND member."revocation_pending_at" IS NULL
        AND member."revocation_claim_id" IS NULL
      FOR UPDATE OF session, member
    ), current AS MATERIALIZED (
      SELECT run."id"
      FROM ${workspaceAnalysisArticleRun} run
      JOIN ${workspaceAnalysisRunner} runner
        ON runner."organization_id" = run."organization_id"
       AND runner."id" = run."runner_id"
      JOIN authority ON TRUE
      WHERE run."organization_id" = ${input.organizationId}
        AND run."article_id" = ${input.articleId}::uuid
        AND run."id" = ${input.runId}::uuid
        AND run."state" IN ('queued', 'running')
        AND run."cancel_requested_at" IS NULL
        AND (run."requested_by_member_id" = authority."id"
          OR runner."member_id" = authority."id"
          OR authority."role" IN ('editor', 'admin', 'owner'))
      FOR UPDATE OF run, runner
    ), updated AS MATERIALIZED (
      UPDATE ${workspaceAnalysisArticleRun} run SET
        "cancel_requested_at" = now(),
        "cancel_requested_by_member_id" = authority."id"
      FROM current CROSS JOIN authority
      WHERE run."organization_id" = ${input.organizationId}
        AND run."id" = current."id"
      RETURNING run.*
    ), audit AS MATERIALIZED (
      INSERT INTO ${workspaceAuditEvent}
        ("organization_id", "actor_user_id", "action", "resource_type", "resource_id",
         "redacted_summary", "request_id")
      SELECT ${input.organizationId}, ${input.authority.userId},
        'analysis_article.run_cancel_requested', 'analysis_article_run', updated."id"::text,
        jsonb_build_object('articleId', updated."article_id", 'articleRevision',
          updated."article_revision"), ${requestId}::uuid
      FROM updated RETURNING "resource_id"
    )
    SELECT ${runProjection()} FROM updated run
    JOIN audit ON audit."resource_id" = run."id"::text
  `);
  return result.rows[0] ?? null;
}

export async function commitAnalysisRunCreate(input: {
  organizationId: string;
  articleId: string;
  run: AnalysisRunRequest;
  parameterHash: string;
  definitionHash: string;
  leaseId?: string | null;
  leaseCapabilityHash?: string | null;
  authority: AnalysisRunAuthority;
}) {
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
        AND member."revocation_pending_at" IS NULL
        AND member."revocation_claim_id" IS NULL
      FOR UPDATE OF session, member
    ), runner_authority AS MATERIALIZED (
      SELECT runner."id"
      FROM ${workspaceAnalysisRunner} runner
      JOIN authority ON runner."member_id" = authority."id"
      WHERE runner."organization_id" = ${input.organizationId}
        AND runner."id" = ${input.run.runnerId}::uuid
        AND runner."revoked_at" IS NULL
        AND (${input.run.trigger} <> 'schedule' OR runner."background_allowed" = TRUE)
      FOR UPDATE OF runner
    ), article_authority AS MATERIALIZED (
      SELECT article."id"
      FROM ${workspaceAnalysisArticle} article
      JOIN ${workspaceAnalysisArticleRevision} revision
        ON revision."organization_id" = article."organization_id"
       AND revision."article_id" = article."id"
       AND revision."revision" = ${input.run.articleRevision}
      JOIN authority ON TRUE
      WHERE article."organization_id" = ${input.organizationId}
        AND article."id" = ${input.articleId}::uuid
        AND article."deleted_at" IS NULL
        AND (article."live_revision" = ${input.run.articleRevision}
          OR (article."revision" = ${input.run.articleRevision}
            AND authority."role" IN ('editor', 'admin', 'owner')))
      FOR UPDATE OF article, revision
    ), connection_authority AS MATERIALIZED (
      SELECT pin."connection_id"
      FROM ${workspaceAnalysisArticleConnection} pin
      JOIN ${workspaceConnection} connection
        ON connection."organization_id" = pin."organization_id"
       AND connection."id" = pin."connection_id"
       AND connection."revision" = pin."connection_revision"
       AND connection."deleted_at" IS NULL
       AND connection."revocation_pending_at" IS NULL
      JOIN ${workspaceConnectionGrant} connection_grant
        ON connection_grant."organization_id" = connection."organization_id"
       AND connection_grant."connection_id" = connection."id"
       AND connection_grant."member_id" = ${input.authority.membershipId}
       AND connection_grant."capability" IN ('use', 'manage')
      JOIN article_authority ON article_authority."id" = pin."article_id"
      WHERE pin."organization_id" = ${input.organizationId}
        AND pin."article_id" = ${input.articleId}::uuid
        AND pin."article_revision" = ${input.run.articleRevision}
      FOR UPDATE OF connection, connection_grant
    ), lease_authority AS MATERIALIZED (
      SELECT runner_authority."id"
      FROM runner_authority
      WHERE ${input.leaseId ?? null}::uuid IS NULL
        AND ${input.run.trigger} <> 'schedule'
      UNION ALL
      SELECT runner_authority."id"
      FROM runner_authority
      JOIN ${workspaceAnalysisRefreshLease} lease
        ON lease."organization_id" = ${input.organizationId}
       AND lease."id" = ${input.leaseId ?? null}::uuid
       AND lease."article_id" = ${input.articleId}::uuid
       AND lease."article_revision" = ${input.run.articleRevision}
       AND lease."runner_id" = runner_authority."id"
       AND lease."lease_capability_hash" = ${input.leaseCapabilityHash ?? null}
       AND lease."parameter_hash" = ${input.parameterHash}
       AND lease."expires_at" > now()
       AND lease."completed_at" IS NULL AND lease."revoked_at" IS NULL
      FOR UPDATE OF lease
    ), inserted AS MATERIALIZED (
      INSERT INTO ${workspaceAnalysisArticleRun}
        ("id", "organization_id", "article_id", "article_revision", "runner_id",
         "lease_id", "requested_by_member_id", "trigger", "state", "parameter_values",
         "parameter_hash", "definition_hash", "started_at")
      SELECT ${input.run.id}::uuid, ${input.organizationId}, ${input.articleId}::uuid,
        ${input.run.articleRevision}, runner_authority."id", ${input.leaseId ?? null}::uuid,
        authority."id", ${input.run.trigger}, 'running',
        ${JSON.stringify(input.run.parameterValues)}::jsonb, ${input.parameterHash},
        ${input.definitionHash}, now()
      FROM authority
      JOIN runner_authority ON TRUE
      JOIN article_authority ON TRUE
      JOIN lease_authority ON lease_authority."id" = runner_authority."id"
      WHERE (SELECT count(*) FROM connection_authority) = (
        SELECT count(*) FROM ${workspaceAnalysisArticleConnection} pin
        WHERE pin."organization_id" = ${input.organizationId}
          AND pin."article_id" = ${input.articleId}::uuid
          AND pin."article_revision" = ${input.run.articleRevision}
      )
      RETURNING *
    ), audit AS MATERIALIZED (
      INSERT INTO ${workspaceAuditEvent}
        ("organization_id", "actor_user_id", "action", "resource_type", "resource_id",
         "redacted_summary", "request_id")
      SELECT ${input.organizationId}, ${input.authority.userId}, 'analysis_article.run_start',
        'analysis_article_run', inserted."id"::text,
        jsonb_build_object('articleId', inserted."article_id", 'articleRevision',
          inserted."article_revision", 'trigger', inserted."trigger"), ${requestId}::uuid
      FROM inserted RETURNING "resource_id"
    )
    SELECT ${runProjection()} FROM inserted run
    JOIN audit ON audit."resource_id" = run."id"::text
  `);
  return result.rows[0] ?? null;
}

function receiptRows(receipts: readonly AnalysisQueryReceiptInput[]) {
  return receipts.map((receipt) => ({
    query_node_id: receipt.queryNodeId,
    connection_id: receipt.connectionId,
    connection_revision: receipt.connectionRevision,
    query_run_id: receipt.queryRunId,
    query_hash: receipt.queryHash,
    schema_fingerprint: receipt.schemaFingerprint,
    state: receipt.state,
    row_count: receipt.rowCount,
    byte_count: receipt.byteCount,
    duration_ms: receipt.durationMs,
  }));
}

function fragmentRows(fragments: readonly SealedAnalysisFragment[]) {
  return fragments.map((fragment) => ({
    block_id: fragment.blockId,
    ordinal: fragment.ordinal,
    data_key_id: fragment.dataKeyId,
    key_reference: fragment.keyReference,
    key_version: fragment.keyVersion,
    ciphertext: fragment.ciphertext,
    payload_hash: fragment.payloadHash,
    row_count: fragment.rowCount,
    plaintext_bytes: fragment.plaintextBytes,
    expires_at: fragment.expiresAt.toISOString(),
  }));
}

export async function commitAnalysisRunCompletion(input: {
  organizationId: string;
  articleId: string;
  runId: string;
  runnerId: string;
  completion: AnalysisRunCompletion;
  sealedFragments: readonly SealedAnalysisFragment[];
  authority: AnalysisRunAuthority;
}) {
  const receipts = receiptRows(input.completion.queryReceipts);
  const fragments = fragmentRows(input.sealedFragments);
  const schemaFingerprints = Object.fromEntries(
    input.completion.queryReceipts.map((receipt) => [receipt.queryNodeId, receipt.schemaFingerprint]),
  );
  const rowCount = input.completion.queryReceipts.reduce((sum, receipt) => sum + receipt.rowCount, 0);
  const byteCount = input.sealedFragments.reduce((sum, fragment) => sum + fragment.plaintextBytes, 0);
  const resultHash = input.completion.state === "succeeded"
    ? canonicalHash({
      receipts: input.completion.queryReceipts,
      fragments: input.sealedFragments.map((fragment) => ({
        blockId: fragment.blockId,
        ordinal: fragment.ordinal,
        payloadHash: fragment.payloadHash,
      })),
    })
    : null;
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
      JOIN authority_lock ON TRUE
      WHERE session."id" = ${input.authority.sessionId}
        AND session."user_id" = ${input.authority.userId}
        AND session."expires_at" > now()
        AND member."role" = ${input.authority.role}
        AND member."revocation_pending_at" IS NULL
        AND member."revocation_claim_id" IS NULL
      FOR UPDATE OF session, member
    ), current AS MATERIALIZED (
      SELECT run.*
      FROM ${workspaceAnalysisArticleRun} run
      JOIN ${workspaceAnalysisRunner} runner
        ON runner."organization_id" = run."organization_id"
       AND runner."id" = run."runner_id"
       AND runner."member_id" = ${input.authority.membershipId}
       AND runner."revoked_at" IS NULL
      JOIN authority ON TRUE
      WHERE run."organization_id" = ${input.organizationId}
        AND run."id" = ${input.runId}::uuid
        AND run."article_id" = ${input.articleId}::uuid
        AND run."runner_id" = ${input.runnerId}::uuid
        AND run."state" = 'running'
      FOR UPDATE OF run, runner
    ), requested_receipt AS MATERIALIZED (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(receipts)}::jsonb)
        AS requested(query_node_id text, connection_id uuid, connection_revision bigint,
          query_run_id uuid, query_hash text, schema_fingerprint text, state text,
          row_count bigint, byte_count bigint, duration_ms bigint)
    ), receipt_authority AS MATERIALIZED (
      SELECT requested.query_node_id
      FROM requested_receipt requested
      JOIN current ON TRUE
      JOIN ${workspaceAnalysisArticleConnection} pin
        ON pin."organization_id" = current."organization_id"
       AND pin."article_id" = current."article_id"
       AND pin."article_revision" = current."article_revision"
       AND pin."connection_id" = requested.connection_id
       AND pin."connection_revision" = requested.connection_revision
      JOIN ${workspaceConnection} connection
        ON connection."organization_id" = pin."organization_id"
       AND connection."id" = pin."connection_id"
       AND connection."revision" = pin."connection_revision"
       AND connection."deleted_at" IS NULL
       AND connection."revocation_pending_at" IS NULL
      JOIN ${workspaceConnectionGrant} connection_grant
        ON connection_grant."organization_id" = connection."organization_id"
       AND connection_grant."connection_id" = connection."id"
       AND connection_grant."member_id" = ${input.authority.membershipId}
       AND connection_grant."capability" IN ('use', 'manage')
      FOR UPDATE OF connection, connection_grant
    ), inserted_receipts AS MATERIALIZED (
      INSERT INTO ${workspaceAnalysisArticleQueryReceipt}
        ("organization_id", "run_id", "query_node_id", "connection_id",
         "connection_revision", "query_run_id", "query_hash", "schema_fingerprint",
         "state", "row_count", "byte_count", "duration_ms")
      SELECT ${input.organizationId}, current."id", requested.query_node_id,
        requested.connection_id, requested.connection_revision, requested.query_run_id,
        requested.query_hash, requested.schema_fingerprint, requested.state,
        requested.row_count, requested.byte_count, requested.duration_ms
      FROM current CROSS JOIN requested_receipt requested
      WHERE (SELECT count(*) FROM receipt_authority) = ${receipts.length}
      RETURNING "run_id"
    ), requested_fragment AS MATERIALIZED (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(fragments)}::jsonb)
        AS requested(block_id text, ordinal integer, data_key_id uuid, key_reference text,
          key_version text, ciphertext text, payload_hash text, row_count integer,
          plaintext_bytes integer, expires_at timestamptz)
    ), inserted_fragments AS MATERIALIZED (
      INSERT INTO ${workspaceAnalysisResultFragment}
        ("organization_id", "run_id", "block_id", "ordinal", "data_key_id",
         "key_reference", "key_version", "ciphertext", "payload_hash", "row_count",
         "plaintext_bytes", "expires_at")
      SELECT ${input.organizationId}, current."id", requested.block_id, requested.ordinal,
        requested.data_key_id, requested.key_reference, requested.key_version,
        requested.ciphertext, requested.payload_hash, requested.row_count,
        requested.plaintext_bytes, requested.expires_at
      FROM current CROSS JOIN requested_fragment requested
      WHERE (SELECT count(*) FROM receipt_authority) = ${receipts.length}
      RETURNING "run_id"
    ), updated AS MATERIALIZED (
      UPDATE ${workspaceAnalysisArticleRun} run
      SET "state" = ${input.completion.state},
        "schema_fingerprints" = ${JSON.stringify(schemaFingerprints)}::jsonb,
        "row_count" = ${rowCount}, "byte_count" = ${byteCount},
        "result_hash" = ${resultHash},
        "error_kind" = ${input.completion.error?.kind ?? null},
        "error_message" = ${input.completion.error?.message ?? null},
        "finished_at" = now()
      FROM current
      WHERE run."organization_id" = current."organization_id" AND run."id" = current."id"
        AND (SELECT count(*) FROM inserted_receipts) = ${receipts.length}
        AND (SELECT count(*) FROM inserted_fragments) = ${fragments.length}
      RETURNING run.*
    ), article_updated AS MATERIALIZED (
      UPDATE ${workspaceAnalysisArticle} article
      SET "latest_successful_run_id" = CASE
          WHEN ${input.completion.state} = 'succeeded'
            AND article."revision" = updated."article_revision" THEN updated."id"
          ELSE article."latest_successful_run_id"
        END,
        "updated_at" = CASE
          WHEN ${input.completion.state} = 'succeeded'
            AND article."revision" = updated."article_revision" THEN now()
          ELSE article."updated_at"
        END
      FROM updated
      WHERE article."organization_id" = updated."organization_id"
        AND article."id" = updated."article_id"
      RETURNING article."id"
    ), lease_updated AS MATERIALIZED (
      UPDATE ${workspaceAnalysisRefreshLease} lease
      SET "completed_at" = now()
      FROM updated
      WHERE lease."organization_id" = updated."organization_id"
        AND lease."id" = updated."lease_id"
      RETURNING lease."id"
    ), audit AS MATERIALIZED (
      INSERT INTO ${workspaceAuditEvent}
        ("organization_id", "actor_user_id", "action", "resource_type", "resource_id",
         "redacted_summary", "request_id")
      SELECT ${input.organizationId}, ${input.authority.userId}, 'analysis_article.run_complete',
        'analysis_article_run', updated."id"::text,
        jsonb_build_object('articleId', updated."article_id", 'articleRevision',
          updated."article_revision", 'state', updated."state", 'rowCount', updated."row_count",
          'byteCount', updated."byte_count"), ${requestId}::uuid
      FROM updated JOIN article_updated ON TRUE
      RETURNING "resource_id"
    )
    SELECT ${runProjection()} FROM updated run
    JOIN audit ON audit."resource_id" = run."id"::text
  `);
  return result.rows[0] ?? null;
}
