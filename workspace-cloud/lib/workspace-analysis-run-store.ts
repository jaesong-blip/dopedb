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
  AnalysisResultFragmentReference,
  AnalysisQueryReceiptInput,
  AnalysisRunCompletion,
  AnalysisRunRequest,
} from "./workspace-analysis-runs";
import { analysisRunResultHash } from "./workspace-analysis-runs";

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
    run."article_revision"::double precision AS "articleRevision",
    run."runner_id"::text AS "runnerId",
    run."runner_capability_generation"::double precision AS "runnerCapabilityGeneration",
    run."lease_id"::text AS "leaseId", run."trigger" AS "trigger",
    run."state" AS "state", run."parameter_values" AS "parameterValues",
    run."parameter_hash" AS "parameterHash", run."definition_hash" AS "definitionHash",
    run."schema_fingerprints" AS "schemaFingerprints", run."row_count"::integer AS "rowCount",
    run."byte_count"::integer AS "byteCount", run."result_hash" AS "resultHash",
    run."error_kind" AS "errorKind", run."error_message" AS "errorMessage",
    CASE WHEN run."cancel_requested_at" IS NULL THEN NULL ELSE
      to_char(run."cancel_requested_at" AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS "cancelRequestedAt",
    run."cancel_requested_by_member_id" AS "cancelRequestedByMemberId",
    CASE WHEN run."started_at" IS NULL THEN NULL ELSE
      to_char(run."started_at" AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS "startedAt",
    CASE WHEN run."finished_at" IS NULL THEN NULL ELSE
      to_char(run."finished_at" AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS "finishedAt",
    to_char(run."created_at" AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt"`;
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
  runnerCapabilityHash: string;
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
      SELECT runner."id", runner."runner_capability_generation"
      FROM ${workspaceAnalysisRunner} runner
      JOIN authority ON runner."member_id" = authority."id"
      WHERE runner."organization_id" = ${input.organizationId}
        AND runner."id" = ${input.run.runnerId}::uuid
        AND runner."revoked_at" IS NULL
        AND runner."runner_capability_hash" = ${input.runnerCapabilityHash}
        AND runner."runner_capability_generation" IS NOT NULL
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
    ), lease_lock AS MATERIALIZED (
      SELECT lease."runner_id"
      FROM ${workspaceAnalysisRefreshLease} lease
      JOIN runner_authority ON runner_authority."id" = lease."runner_id"
      WHERE lease."organization_id" = ${input.organizationId}
        AND lease."id" = ${input.leaseId ?? null}::uuid
        AND lease."article_id" = ${input.articleId}::uuid
        AND lease."article_revision" = ${input.run.articleRevision}
        AND lease."lease_capability_hash" = ${input.leaseCapabilityHash ?? null}
        AND lease."runner_capability_generation" = runner_authority."runner_capability_generation"
        AND lease."parameter_hash" = ${input.parameterHash}
        AND lease."expires_at" > now()
        AND lease."completed_at" IS NULL AND lease."revoked_at" IS NULL
      FOR UPDATE OF lease
    ), lease_authority AS MATERIALIZED (
      SELECT runner_authority."id"
      FROM runner_authority
      WHERE (${input.leaseId ?? null}::uuid IS NULL
          AND ${input.run.trigger} <> 'schedule')
        OR EXISTS (
          SELECT 1 FROM lease_lock WHERE lease_lock."runner_id" = runner_authority."id"
        )
    ), inserted AS MATERIALIZED (
      INSERT INTO ${workspaceAnalysisArticleRun}
        ("id", "organization_id", "article_id", "article_revision", "runner_id",
         "runner_capability_generation", "lease_id", "requested_by_member_id", "trigger",
         "state", "parameter_values", "parameter_hash", "definition_hash", "started_at")
      SELECT ${input.run.id}::uuid, ${input.organizationId}, ${input.articleId}::uuid,
        ${input.run.articleRevision}, runner_authority."id",
        runner_authority."runner_capability_generation", ${input.leaseId ?? null}::uuid,
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

/**
 * Cheap, side-effect-free authority check performed before KMS work. The write
 * transaction below deliberately repeats every condition and remains canonical.
 */
export async function canStageAnalysisRunFragment(input: {
  organizationId: string;
  articleId: string;
  runId: string;
  runnerId: string;
  runnerCapabilityHash: string;
  authority: AnalysisRunAuthority;
}) {
  const result = await db.execute<{ allowed: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1
      FROM "workspace_control"."session" session
      JOIN "workspace_control"."member" member
        ON member."id" = ${input.authority.membershipId}
       AND member."organization_id" = ${input.organizationId}
       AND member."user_id" = ${input.authority.userId}
      JOIN ${workspaceAnalysisArticleRun} run
        ON run."organization_id" = member."organization_id"
       AND run."article_id" = ${input.articleId}::uuid
       AND run."id" = ${input.runId}::uuid
       AND run."runner_id" = ${input.runnerId}::uuid
       AND run."state" = 'running'
       AND run."cancel_requested_at" IS NULL
      JOIN ${workspaceAnalysisRunner} runner
        ON runner."organization_id" = run."organization_id"
       AND runner."id" = run."runner_id"
       AND runner."member_id" = member."id"
       AND runner."revoked_at" IS NULL
       AND runner."runner_capability_hash" = ${input.runnerCapabilityHash}
       AND runner."runner_capability_generation" = run."runner_capability_generation"
      JOIN ${workspaceAnalysisArticle} article
        ON article."organization_id" = run."organization_id"
       AND article."id" = run."article_id"
       AND article."deleted_at" IS NULL
      JOIN ${workspaceAnalysisArticleRevision} revision
        ON revision."organization_id" = run."organization_id"
       AND revision."article_id" = run."article_id"
       AND revision."revision" = run."article_revision"
      WHERE session."id" = ${input.authority.sessionId}
        AND session."user_id" = ${input.authority.userId}
        AND session."expires_at" > now()
        AND member."role" = ${input.authority.role}
        AND member."revocation_pending_at" IS NULL
        AND member."revocation_claim_id" IS NULL
        AND (article."live_revision" = run."article_revision"
          OR (article."revision" = run."article_revision"
            AND article."state" = 'review'
            AND revision."payload" #>> '{definition,refresh,shareReviewedResults}' = 'true'))
    ) AS "allowed"
  `);
  return result.rows[0]?.allowed === true;
}

export async function stageAnalysisRunFragment(input: {
  organizationId: string;
  articleId: string;
  runId: string;
  runnerId: string;
  runnerCapabilityHash: string;
  fragment: SealedAnalysisFragment;
  authority: AnalysisRunAuthority;
}) {
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
      SELECT run."id"
      FROM ${workspaceAnalysisArticleRun} run
      JOIN ${workspaceAnalysisRunner} runner
        ON runner."organization_id" = run."organization_id"
       AND runner."id" = run."runner_id"
       AND runner."member_id" = ${input.authority.membershipId}
       AND runner."revoked_at" IS NULL
       AND runner."runner_capability_hash" = ${input.runnerCapabilityHash}
       AND runner."runner_capability_generation" = run."runner_capability_generation"
      JOIN authority ON TRUE
      JOIN ${workspaceAnalysisArticle} article
        ON article."organization_id" = run."organization_id"
       AND article."id" = run."article_id"
       AND article."deleted_at" IS NULL
      JOIN ${workspaceAnalysisArticleRevision} revision
        ON revision."organization_id" = run."organization_id"
       AND revision."article_id" = run."article_id"
       AND revision."revision" = run."article_revision"
      WHERE run."organization_id" = ${input.organizationId}
        AND run."article_id" = ${input.articleId}::uuid
        AND run."id" = ${input.runId}::uuid
        AND run."runner_id" = ${input.runnerId}::uuid
        AND run."state" = 'running'
        AND run."cancel_requested_at" IS NULL
        AND (article."live_revision" = run."article_revision"
          OR (article."revision" = run."article_revision"
            AND article."state" = 'review'
            AND revision."payload" #>> '{definition,refresh,shareReviewedResults}' = 'true'))
      FOR UPDATE OF run, runner, article, revision
    ), inserted AS MATERIALIZED (
      INSERT INTO ${workspaceAnalysisResultFragment}
        ("organization_id", "run_id", "block_id", "ordinal", "data_key_id",
         "key_reference", "key_version", "ciphertext", "payload_hash", "row_count",
         "plaintext_bytes", "expires_at")
      SELECT ${input.organizationId}, current."id", ${input.fragment.blockId},
        ${input.fragment.ordinal}, ${input.fragment.dataKeyId}, ${input.fragment.keyReference},
        ${input.fragment.keyVersion}, ${input.fragment.ciphertext},
        ${input.fragment.payloadHash}, ${input.fragment.rowCount},
        ${input.fragment.plaintextBytes}, ${input.fragment.expiresAt.toISOString()}::timestamptz
      FROM current
      WHERE (SELECT count(*) FROM ${workspaceAnalysisResultFragment} staged
          WHERE staged."organization_id" = ${input.organizationId}
            AND staged."run_id" = current."id") < 256
        AND COALESCE((SELECT sum(staged."plaintext_bytes")
          FROM ${workspaceAnalysisResultFragment} staged
          WHERE staged."organization_id" = ${input.organizationId}
            AND staged."run_id" = current."id"), 0) + ${input.fragment.plaintextBytes}
          <= 16777216
      ON CONFLICT ("organization_id", "run_id", "block_id", "ordinal") DO NOTHING
      RETURNING "block_id" AS "blockId", "ordinal", "payload_hash" AS "payloadHash"
    ), existing AS MATERIALIZED (
      SELECT fragment."block_id" AS "blockId", fragment."ordinal",
        fragment."payload_hash" AS "payloadHash"
      FROM ${workspaceAnalysisResultFragment} fragment
      JOIN current ON current."id" = fragment."run_id"
      WHERE fragment."organization_id" = ${input.organizationId}
        AND fragment."block_id" = ${input.fragment.blockId}
        AND fragment."ordinal" = ${input.fragment.ordinal}
        AND fragment."payload_hash" = ${input.fragment.payloadHash}
        AND fragment."expires_at" > now()
    ), audit AS MATERIALIZED (
      INSERT INTO ${workspaceAuditEvent}
        ("organization_id", "actor_user_id", "action", "resource_type", "resource_id",
         "redacted_summary", "request_id")
      SELECT ${input.organizationId}, ${input.authority.userId},
        'analysis_article.result_fragment_staged', 'analysis_article_run', current."id"::text,
        jsonb_build_object('articleId', ${input.articleId}::text, 'blockId',
          ${input.fragment.blockId}::text, 'ordinal', ${input.fragment.ordinal}::integer),
        ${requestId}::uuid
      FROM current
      WHERE EXISTS (SELECT 1 FROM inserted)
      RETURNING "resource_id"
    )
    SELECT "blockId", "ordinal", "payloadHash" FROM inserted
    UNION ALL
    SELECT "blockId", "ordinal", "payloadHash" FROM existing
    LIMIT 1
  `);
  return result.rows[0] ?? null;
}

export async function commitAnalysisRunCompletion(input: {
  organizationId: string;
  articleId: string;
  runId: string;
  runnerId: string;
  runnerCapabilityHash: string;
  completion: AnalysisRunCompletion;
  fragmentManifest: readonly AnalysisResultFragmentReference[];
  authority: AnalysisRunAuthority;
}) {
  const receipts = receiptRows(input.completion.queryReceipts);
  const fragments = input.fragmentManifest.map((fragment) => ({
    block_id: fragment.blockId,
    ordinal: fragment.ordinal,
    payload_hash: fragment.payloadHash,
  }));
  const schemaFingerprints = Object.fromEntries(
    input.completion.state === "succeeded"
      ? input.completion.queryReceipts.map(
        (receipt) => [receipt.queryNodeId, receipt.schemaFingerprint],
      )
      : [],
  );
  const rowCount = input.completion.state === "succeeded"
    ? input.completion.queryReceipts.reduce((sum, receipt) => sum + receipt.rowCount, 0)
    : 0;
  const resultHash = input.completion.state === "succeeded"
    ? analysisRunResultHash(input.completion.queryReceipts, input.fragmentManifest)
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
    ), requested_fragment AS MATERIALIZED (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(fragments)}::jsonb)
        AS requested(block_id text, ordinal integer, payload_hash text)
    ), current AS MATERIALIZED (
      SELECT run.*
      FROM ${workspaceAnalysisArticleRun} run
      JOIN ${workspaceAnalysisRunner} runner
        ON runner."organization_id" = run."organization_id"
       AND runner."id" = run."runner_id"
       AND runner."member_id" = ${input.authority.membershipId}
       AND runner."revoked_at" IS NULL
       AND runner."runner_capability_hash" = ${input.runnerCapabilityHash}
       AND runner."runner_capability_generation" = run."runner_capability_generation"
      JOIN authority ON TRUE
      JOIN ${workspaceAnalysisArticle} article
        ON article."organization_id" = run."organization_id"
       AND article."id" = run."article_id"
       AND (article."deleted_at" IS NULL OR ${input.completion.state} <> 'succeeded')
      JOIN ${workspaceAnalysisArticleRevision} revision
        ON revision."organization_id" = run."organization_id"
       AND revision."article_id" = run."article_id"
       AND revision."revision" = run."article_revision"
      WHERE run."organization_id" = ${input.organizationId}
        AND run."id" = ${input.runId}::uuid
        AND run."article_id" = ${input.articleId}::uuid
        AND run."runner_id" = ${input.runnerId}::uuid
        AND run."state" = 'running'
        AND (run."cancel_requested_at" IS NULL OR ${input.completion.state} <> 'succeeded')
        AND (
          ${fragments.length} = 0
          OR article."live_revision" = run."article_revision"
          OR (article."revision" = run."article_revision"
            AND article."state" = 'review'
            AND revision."payload" #>> '{definition,refresh,shareReviewedResults}' = 'true')
        )
        AND (
          ${input.completion.state} <> 'succeeded'
          OR ${fragments.length} > 0
          OR NOT (
            article."live_revision" = run."article_revision"
            OR (article."revision" = run."article_revision"
              AND article."state" = 'review'
              AND revision."payload" #>> '{definition,refresh,shareReviewedResults}' = 'true')
          )
          OR NOT EXISTS (
            SELECT 1
            FROM jsonb_array_elements(
              COALESCE(revision."payload" #> '{definition,blocks}', '[]'::jsonb)
            ) block
            WHERE block -> 'sourceNodeId' <> 'null'::jsonb
          )
        )
        AND (
          (${input.completion.state} <> 'succeeded'
            AND NOT EXISTS (SELECT 1 FROM requested_fragment))
          OR (${input.completion.state} = 'succeeded'
            AND NOT EXISTS (
              SELECT 1
              FROM jsonb_array_elements(
                COALESCE(revision."payload" #> '{definition,blocks}', '[]'::jsonb)
              ) block
              WHERE block ->> 'sourceNodeId' IS NOT NULL
                AND NOT EXISTS (
                  SELECT 1 FROM requested_fragment requested
                  WHERE requested.block_id = block ->> 'id'
                )
            )
            AND NOT EXISTS (
              SELECT 1 FROM requested_fragment requested
              WHERE NOT EXISTS (
                SELECT 1
                FROM jsonb_array_elements(
                  COALESCE(revision."payload" #> '{definition,blocks}', '[]'::jsonb)
                ) block
                WHERE block ->> 'sourceNodeId' IS NOT NULL
                  AND block ->> 'id' = requested.block_id
              )
            )
            AND NOT EXISTS (
              SELECT 1
              FROM requested_fragment requested
              GROUP BY requested.block_id
              HAVING min(requested.ordinal) <> 0
                OR max(requested.ordinal) <> count(DISTINCT requested.ordinal) - 1
                OR count(*) <> count(DISTINCT requested.ordinal)
            ))
        )
      FOR UPDATE OF run, runner, article, revision
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
    ), verified_fragments AS MATERIALIZED (
      SELECT fragment."run_id", fragment."plaintext_bytes"
      FROM current CROSS JOIN requested_fragment requested
      JOIN ${workspaceAnalysisResultFragment} fragment
        ON fragment."organization_id" = current."organization_id"
       AND fragment."run_id" = current."id"
       AND fragment."block_id" = requested.block_id
       AND fragment."ordinal" = requested.ordinal
       AND fragment."payload_hash" = requested.payload_hash
       AND fragment."expires_at" > now()
    ), evidence_eligible AS MATERIALIZED (
      SELECT current."id"
      FROM current
      WHERE (
          ${input.completion.state} <> 'succeeded'
          OR (SELECT count(*) FROM receipt_authority) = ${receipts.length}
        )
        AND (
          ${input.completion.state} <> 'succeeded'
          OR (
            (SELECT count(*) FROM verified_fragments) = ${fragments.length}
            AND (SELECT count(*) FROM ${workspaceAnalysisResultFragment} stored
              WHERE stored."organization_id" = current."organization_id"
                AND stored."run_id" = current."id"
                AND stored."expires_at" > now()) = ${fragments.length}
            AND COALESCE((SELECT sum("plaintext_bytes") FROM verified_fragments), 0)
              <= 16777216
          )
        )
    ), discarded_fragments AS MATERIALIZED (
      DELETE FROM ${workspaceAnalysisResultFragment} discarded
      USING current JOIN evidence_eligible ON evidence_eligible."id" = current."id"
      WHERE discarded."organization_id" = current."organization_id"
        AND discarded."run_id" = evidence_eligible."id"
        AND ${input.completion.state} <> 'succeeded'
      RETURNING discarded."run_id"
    ), eligible AS MATERIALIZED (
      SELECT evidence_eligible."id"
      FROM evidence_eligible
      WHERE ${input.completion.state} = 'succeeded'
        OR (SELECT count(*) FROM discarded_fragments) >= 0
    ), inserted_receipts AS MATERIALIZED (
      INSERT INTO ${workspaceAnalysisArticleQueryReceipt}
        ("organization_id", "run_id", "query_node_id", "connection_id",
         "connection_revision", "query_run_id", "query_hash", "schema_fingerprint",
         "state", "row_count", "byte_count", "duration_ms")
      SELECT ${input.organizationId}, eligible."id", requested.query_node_id,
        requested.connection_id, requested.connection_revision, requested.query_run_id,
        requested.query_hash, requested.schema_fingerprint, requested.state,
        requested.row_count, requested.byte_count, requested.duration_ms
      FROM eligible CROSS JOIN requested_receipt requested
      WHERE ${input.completion.state} = 'succeeded'
      RETURNING "run_id"
    ), updated AS MATERIALIZED (
      UPDATE ${workspaceAnalysisArticleRun} run
      SET "state" = ${input.completion.state},
        "schema_fingerprints" = ${JSON.stringify(schemaFingerprints)}::jsonb,
        "row_count" = ${rowCount}, "byte_count" = COALESCE(
          (SELECT sum("plaintext_bytes") FROM verified_fragments), 0
        ),
        "result_hash" = ${resultHash},
        "error_kind" = ${input.completion.error?.kind ?? null},
        "error_message" = ${input.completion.error?.message ?? null},
        "finished_at" = now()
      FROM current JOIN eligible ON eligible."id" = current."id"
      WHERE run."organization_id" = current."organization_id" AND run."id" = current."id"
        AND (
          ${input.completion.state} <> 'succeeded'
          OR (SELECT count(*) FROM inserted_receipts) = ${receipts.length}
        )
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
  if (result.rows[0]) return result.rows[0];
  return replayAnalysisRunCompletion({
    ...input,
    receipts,
    fragments,
    schemaFingerprints,
    rowCount,
    resultHash,
  });
}

async function replayAnalysisRunCompletion(input: {
  organizationId: string;
  articleId: string;
  runId: string;
  runnerId: string;
  runnerCapabilityHash: string;
  completion: AnalysisRunCompletion;
  fragmentManifest: readonly AnalysisResultFragmentReference[];
  authority: AnalysisRunAuthority;
  receipts: ReturnType<typeof receiptRows>;
  fragments: Array<{ block_id: string; ordinal: number; payload_hash: string }>;
  schemaFingerprints: Record<string, string>;
  rowCount: number;
  resultHash: string | null;
}) {
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
    ), requested_receipt AS MATERIALIZED (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(input.receipts)}::jsonb)
        AS requested(query_node_id text, connection_id uuid, connection_revision bigint,
          query_run_id uuid, query_hash text, schema_fingerprint text, state text,
          row_count bigint, byte_count bigint, duration_ms bigint)
    ), requested_fragment AS MATERIALIZED (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(input.fragments)}::jsonb)
        AS requested(block_id text, ordinal integer, payload_hash text)
    ), replay AS MATERIALIZED (
      SELECT run.*
      FROM ${workspaceAnalysisArticleRun} run
      JOIN ${workspaceAnalysisRunner} runner
        ON runner."organization_id" = run."organization_id"
       AND runner."id" = run."runner_id"
       AND runner."member_id" = ${input.authority.membershipId}
       AND runner."revoked_at" IS NULL
       AND runner."runner_capability_hash" = ${input.runnerCapabilityHash}
       AND runner."runner_capability_generation" = run."runner_capability_generation"
      JOIN authority ON TRUE
      JOIN ${workspaceAnalysisArticleRevision} revision
        ON revision."organization_id" = run."organization_id"
       AND revision."article_id" = run."article_id"
       AND revision."revision" = run."article_revision"
      WHERE run."organization_id" = ${input.organizationId}
        AND run."article_id" = ${input.articleId}::uuid
        AND run."id" = ${input.runId}::uuid
        AND run."runner_id" = ${input.runnerId}::uuid
        AND run."state" = ${input.completion.state}
        AND run."finished_at" IS NOT NULL
        AND run."schema_fingerprints" = ${JSON.stringify(input.schemaFingerprints)}::jsonb
        AND run."row_count" = ${input.rowCount}
        AND run."result_hash" IS NOT DISTINCT FROM ${input.resultHash}
        AND run."error_kind" IS NOT DISTINCT FROM ${input.completion.error?.kind ?? null}
        AND run."error_message" IS NOT DISTINCT FROM ${input.completion.error?.message ?? null}
        AND (
          (${input.completion.state} <> 'succeeded'
            AND NOT EXISTS (SELECT 1 FROM requested_fragment))
          OR (${input.completion.state} = 'succeeded'
            AND NOT EXISTS (
              SELECT 1
              FROM jsonb_array_elements(
                COALESCE(revision."payload" #> '{definition,blocks}', '[]'::jsonb)
              ) block
              WHERE block ->> 'sourceNodeId' IS NOT NULL
                AND NOT EXISTS (
                  SELECT 1 FROM requested_fragment requested
                  WHERE requested.block_id = block ->> 'id'
                )
            )
            AND NOT EXISTS (
              SELECT 1 FROM requested_fragment requested
              WHERE NOT EXISTS (
                SELECT 1
                FROM jsonb_array_elements(
                  COALESCE(revision."payload" #> '{definition,blocks}', '[]'::jsonb)
                ) block
                WHERE block ->> 'sourceNodeId' IS NOT NULL
                  AND block ->> 'id' = requested.block_id
              )
            )
            AND NOT EXISTS (
              SELECT 1
              FROM requested_fragment requested
              GROUP BY requested.block_id
              HAVING min(requested.ordinal) <> 0
                OR max(requested.ordinal) <> count(DISTINCT requested.ordinal) - 1
                OR count(*) <> count(DISTINCT requested.ordinal)
            ))
        )
        AND (SELECT count(*) FROM ${workspaceAnalysisArticleQueryReceipt} stored
          WHERE stored."organization_id" = run."organization_id"
            AND stored."run_id" = run."id") = CASE
              WHEN ${input.completion.state} = 'succeeded' THEN ${input.receipts.length}
              ELSE 0
            END
        AND (SELECT count(*)
          FROM requested_receipt requested
          JOIN ${workspaceAnalysisArticleQueryReceipt} stored
            ON stored."organization_id" = run."organization_id"
           AND stored."run_id" = run."id"
           AND stored."query_node_id" = requested.query_node_id
           AND stored."connection_id" = requested.connection_id
           AND stored."connection_revision" = requested.connection_revision
           AND stored."query_run_id" = requested.query_run_id
           AND stored."query_hash" = requested.query_hash
           AND stored."schema_fingerprint" = requested.schema_fingerprint
           AND stored."state" = requested.state
           AND stored."row_count" = requested.row_count
           AND stored."byte_count" = requested.byte_count
           AND stored."duration_ms" = requested.duration_ms) = CASE
             WHEN ${input.completion.state} = 'succeeded' THEN ${input.receipts.length}
             ELSE 0
           END
        AND (SELECT count(*) FROM ${workspaceAnalysisResultFragment} stored
          WHERE stored."organization_id" = run."organization_id"
            AND stored."run_id" = run."id"
            AND stored."expires_at" > now()) = ${input.fragments.length}
        AND (SELECT count(*)
          FROM requested_fragment requested
          JOIN ${workspaceAnalysisResultFragment} stored
            ON stored."organization_id" = run."organization_id"
           AND stored."run_id" = run."id"
           AND stored."block_id" = requested.block_id
           AND stored."ordinal" = requested.ordinal
           AND stored."payload_hash" = requested.payload_hash
           AND stored."expires_at" > now()) = ${input.fragments.length}
        AND run."byte_count" = COALESCE((
          SELECT sum(stored."plaintext_bytes")
          FROM ${workspaceAnalysisResultFragment} stored
          WHERE stored."organization_id" = run."organization_id"
            AND stored."run_id" = run."id"
            AND stored."expires_at" > now()
        ), 0)
      FOR UPDATE OF run, runner, revision
    )
    SELECT ${runProjection()} FROM replay run
  `);
  return result.rows[0] ?? null;
}
