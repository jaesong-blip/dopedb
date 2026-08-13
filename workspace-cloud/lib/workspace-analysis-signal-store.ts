// Atomic, revision-pinned Signal persistence for Analysis Articles. Signal
// evaluation happens on the member-owned Desktop runner; the cloud accepts only
// categorical receipts bound to an exact successful run and never receives a
// metric value.
import "server-only";

import { sql } from "drizzle-orm";

import { db } from "./db";
import { revocationGateLockKey } from "./revocation-gates";
import {
  workspaceAnalysisArticle,
  workspaceAnalysisArticleConnection,
  workspaceAnalysisArticleRevision,
  workspaceAnalysisArticleRun,
  workspaceAnalysisResultFragment,
  workspaceAnalysisRunner,
  workspaceAnalysisSignal,
  workspaceAnalysisSignalNotification,
  workspaceAnalysisSignalReceipt,
  workspaceAnalysisSignalRevision,
  workspaceAuditEvent,
  workspaceConnection,
  workspaceConnectionGrant,
} from "./schema";
import {
  analysisSignalVersionPayload,
  type AnalysisSignalCreate,
  type AnalysisSignalReceipt,
} from "./workspace-analysis-signals";
import { canonicalHash } from "./workspace-versioning";

export type AnalysisSignalAuthority = Readonly<{
  sessionId: string;
  userId: string;
  membershipId: string;
  role: string;
}>;

export type AnalysisSignalOperation = "update" | "enable" | "disable" | "delete";

type RawRow = Record<string, unknown>;

function lockKey(input: { organizationId: string; authority: AnalysisSignalAuthority }) {
  return revocationGateLockKey({
    kind: "member",
    organizationId: input.organizationId,
    memberId: input.authority.membershipId,
    userId: input.authority.userId,
  });
}

function signalProjection() {
  return sql`
    signal."id"::text AS "id", signal."article_id"::text AS "articleId",
    signal."article_revision" AS "articleRevision", signal."block_id" AS "blockId",
    signal."definition" AS "definition", signal."owner_member_id" AS "ownerMemberId",
    signal."enabled" AS "enabled", signal."revision" AS "revision",
    signal."last_evaluated_run_id"::text AS "lastEvaluatedRunId",
    signal."last_observed_state" AS "lastObservedState",
    signal."created_at" AS "createdAt", signal."updated_at" AS "updatedAt",
    signal."deleted_at" AS "deletedAt"`;
}

function recipientIds(signal: AnalysisSignalCreate) {
  return signal.definition.recipientMemberIds;
}

export async function commitAnalysisSignalCreate(input: {
  organizationId: string;
  articleId: string;
  signal: AnalysisSignalCreate;
  authority: AnalysisSignalAuthority;
}) {
  const payload = analysisSignalVersionPayload(input.signal);
  const recipients = recipientIds(input.signal);
  const requestId = crypto.randomUUID();
  const result = await db.execute<RawRow>(sql`
    WITH authority_lock AS MATERIALIZED (
      SELECT pg_advisory_xact_lock(hashtextextended(${lockKey(input)}, 0))
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
        AND member."role" IN ('editor', 'admin', 'owner')
        AND member."revocation_pending_at" IS NULL
        AND member."revocation_claim_id" IS NULL
      FOR UPDATE OF session, member
    ), article_authority AS MATERIALIZED (
      SELECT article."id"
      FROM ${workspaceAnalysisArticle} article
      JOIN ${workspaceAnalysisArticleRevision} revision
        ON revision."organization_id" = article."organization_id"
       AND revision."article_id" = article."id"
       AND revision."revision" = ${input.signal.articleRevision}
      JOIN authority ON TRUE
      WHERE article."organization_id" = ${input.organizationId}
        AND article."id" = ${input.articleId}::uuid
        AND article."live_revision" = ${input.signal.articleRevision}
        AND article."deleted_at" IS NULL
        AND EXISTS (
          SELECT 1
          FROM jsonb_array_elements(revision."payload" #> '{definition,blocks}') block
          WHERE block->>'id' = ${input.signal.blockId}
            AND block->>'kind' = 'metric'
        )
      FOR UPDATE OF article, revision
    ), requested_recipient AS MATERIALIZED (
      SELECT value AS member_id
      FROM jsonb_array_elements_text(${JSON.stringify(recipients)}::jsonb)
    ), recipient_authority AS MATERIALIZED (
      SELECT member."id"
      FROM "workspace_control"."member" member
      JOIN requested_recipient requested ON requested.member_id = member."id"
      JOIN authority ON TRUE
      WHERE member."organization_id" = ${input.organizationId}
        AND member."revocation_pending_at" IS NULL
        AND member."revocation_claim_id" IS NULL
      FOR UPDATE OF member
    ), inserted AS MATERIALIZED (
      INSERT INTO ${workspaceAnalysisSignal}
        ("id", "organization_id", "article_id", "article_revision", "block_id",
         "definition", "owner_member_id", "enabled", "revision")
      SELECT ${input.signal.id}::uuid, ${input.organizationId}, article_authority."id",
        ${input.signal.articleRevision}, ${input.signal.blockId},
        ${JSON.stringify(input.signal.definition)}::jsonb, authority."id",
        ${input.signal.enabled}, 1
      FROM authority JOIN article_authority ON TRUE
      WHERE (SELECT count(*) FROM recipient_authority) = ${recipients.length}
      RETURNING *
    ), revision_inserted AS MATERIALIZED (
      INSERT INTO ${workspaceAnalysisSignalRevision}
        ("organization_id", "signal_id", "revision", "base_revision", "operation",
         "payload", "payload_hash", "created_by_member_id")
      SELECT ${input.organizationId}, inserted."id", 1, NULL, 'create',
        ${JSON.stringify(payload)}::jsonb, ${canonicalHash(payload)}, authority."id"
      FROM inserted JOIN authority ON TRUE
      RETURNING "signal_id"
    ), audit AS MATERIALIZED (
      INSERT INTO ${workspaceAuditEvent}
        ("organization_id", "actor_user_id", "action", "resource_type", "resource_id",
         "redacted_summary", "request_id")
      SELECT ${input.organizationId}, ${input.authority.userId}, 'analysis_signal.created',
        'analysis_signal', inserted."id"::text,
        jsonb_build_object('articleId', inserted."article_id", 'articleRevision',
          inserted."article_revision", 'blockId', inserted."block_id",
          'enabled', inserted."enabled"), ${requestId}::uuid
      FROM inserted JOIN revision_inserted ON revision_inserted."signal_id" = inserted."id"
      RETURNING "resource_id"
    )
    SELECT ${signalProjection()} FROM inserted signal
    JOIN audit ON audit."resource_id" = signal."id"::text
  `);
  return result.rows[0] ?? null;
}

export async function commitAnalysisSignalMutation(input: {
  organizationId: string;
  articleId: string;
  signal: AnalysisSignalCreate;
  expectedRevision: number;
  operation: AnalysisSignalOperation;
  authority: AnalysisSignalAuthority;
}) {
  const deleted = input.operation === "delete";
  const payload = analysisSignalVersionPayload({ ...input.signal, deleted });
  const recipients = recipientIds(input.signal);
  const resetEvaluation = input.operation === "update" || input.operation === "enable";
  const requestId = crypto.randomUUID();
  const result = await db.execute<RawRow>(sql`
    WITH authority_lock AS MATERIALIZED (
      SELECT pg_advisory_xact_lock(hashtextextended(${lockKey(input)}, 0))
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
        AND member."role" IN ('editor', 'admin', 'owner')
        AND member."revocation_pending_at" IS NULL
        AND member."revocation_claim_id" IS NULL
      FOR UPDATE OF session, member
    ), current AS MATERIALIZED (
      SELECT signal.*
      FROM ${workspaceAnalysisSignal} signal
      JOIN authority ON TRUE
      WHERE signal."organization_id" = ${input.organizationId}
        AND signal."id" = ${input.signal.id}::uuid
        AND signal."article_id" = ${input.articleId}::uuid
        AND signal."revision" = ${input.expectedRevision}
        AND signal."deleted_at" IS NULL
      FOR UPDATE OF signal
    ), article_authority AS MATERIALIZED (
      SELECT article."id"
      FROM ${workspaceAnalysisArticle} article
      JOIN ${workspaceAnalysisArticleRevision} revision
        ON revision."organization_id" = article."organization_id"
       AND revision."article_id" = article."id"
       AND revision."revision" = ${input.signal.articleRevision}
      JOIN current ON current."article_id" = article."id"
      WHERE article."organization_id" = ${input.organizationId}
        AND article."live_revision" = ${input.signal.articleRevision}
        AND article."deleted_at" IS NULL
        AND EXISTS (
          SELECT 1
          FROM jsonb_array_elements(revision."payload" #> '{definition,blocks}') block
          WHERE block->>'id' = ${input.signal.blockId}
            AND block->>'kind' = 'metric'
        )
      FOR UPDATE OF article, revision
    ), requested_recipient AS MATERIALIZED (
      SELECT value AS member_id
      FROM jsonb_array_elements_text(${JSON.stringify(recipients)}::jsonb)
    ), recipient_authority AS MATERIALIZED (
      SELECT member."id"
      FROM "workspace_control"."member" member
      JOIN requested_recipient requested ON requested.member_id = member."id"
      JOIN authority ON TRUE
      WHERE member."organization_id" = ${input.organizationId}
        AND member."revocation_pending_at" IS NULL
        AND member."revocation_claim_id" IS NULL
      FOR UPDATE OF member
    ), updated AS MATERIALIZED (
      UPDATE ${workspaceAnalysisSignal} signal SET
        "article_revision" = ${input.signal.articleRevision},
        "block_id" = ${input.signal.blockId},
        "definition" = ${JSON.stringify(input.signal.definition)}::jsonb,
        "enabled" = ${input.signal.enabled},
        "revision" = current."revision" + 1,
        "last_evaluated_run_id" = CASE WHEN ${resetEvaluation} THEN NULL
          ELSE current."last_evaluated_run_id" END,
        "last_observed_state" = CASE WHEN ${resetEvaluation} THEN 'unknown'
          ELSE current."last_observed_state" END,
        "updated_at" = now(),
        "deleted_at" = CASE WHEN ${deleted} THEN now() ELSE NULL END
      FROM current JOIN article_authority ON TRUE
      WHERE signal."organization_id" = current."organization_id"
        AND signal."id" = current."id"
        AND (SELECT count(*) FROM recipient_authority) = ${recipients.length}
      RETURNING signal.*
    ), revision_inserted AS MATERIALIZED (
      INSERT INTO ${workspaceAnalysisSignalRevision}
        ("organization_id", "signal_id", "revision", "base_revision", "operation",
         "payload", "payload_hash", "created_by_member_id")
      SELECT ${input.organizationId}, updated."id", updated."revision",
        ${input.expectedRevision}, ${input.operation}, ${JSON.stringify(payload)}::jsonb,
        ${canonicalHash(payload)}, authority."id"
      FROM updated JOIN authority ON TRUE
      RETURNING "signal_id"
    ), audit AS MATERIALIZED (
      INSERT INTO ${workspaceAuditEvent}
        ("organization_id", "actor_user_id", "action", "resource_type", "resource_id",
         "redacted_summary", "request_id")
      SELECT ${input.organizationId}, ${input.authority.userId},
        ${`analysis_signal.${input.operation}`}, 'analysis_signal', updated."id"::text,
        jsonb_build_object('articleId', updated."article_id", 'revision',
          updated."revision", 'enabled', updated."enabled"), ${requestId}::uuid
      FROM updated JOIN revision_inserted ON revision_inserted."signal_id" = updated."id"
      RETURNING "resource_id"
    )
    SELECT ${signalProjection()} FROM updated signal
    JOIN audit ON audit."resource_id" = signal."id"::text
  `);
  return result.rows[0] ?? null;
}

export async function commitAnalysisSignalReceipt(input: {
  organizationId: string;
  articleId: string;
  signalId: string;
  runnerId: string;
  runnerCapabilityHash: string;
  expectedSchemaFingerprint: string;
  receipt: AnalysisSignalReceipt;
  authority: AnalysisSignalAuthority;
}) {
  const requestId = crypto.randomUUID();
  const result = await db.execute<RawRow>(sql`
    WITH authority_lock AS MATERIALIZED (
      SELECT pg_advisory_xact_lock(hashtextextended(${lockKey(input)}, 0))
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
      SELECT signal.*
      FROM ${workspaceAnalysisSignal} signal
      JOIN authority ON TRUE
      WHERE signal."organization_id" = ${input.organizationId}
        AND signal."id" = ${input.signalId}::uuid
        AND signal."article_id" = ${input.articleId}::uuid
        AND signal."revision" = ${input.receipt.signalRevision}
        AND signal."enabled" = TRUE
        AND signal."deleted_at" IS NULL
      FOR UPDATE OF signal
    ), runner_authority AS MATERIALIZED (
      SELECT runner."id", runner."runner_capability_generation"
      FROM ${workspaceAnalysisRunner} runner
      JOIN authority ON runner."member_id" = authority."id"
      WHERE runner."organization_id" = ${input.organizationId}
        AND runner."id" = ${input.runnerId}::uuid
        AND runner."revoked_at" IS NULL
        AND runner."runner_capability_hash" = ${input.runnerCapabilityHash}
        AND runner."runner_capability_generation" IS NOT NULL
      FOR UPDATE OF runner
    ), run_authority AS MATERIALIZED (
      SELECT run."id", run."result_hash"
      FROM ${workspaceAnalysisArticleRun} run
      JOIN current ON current."article_id" = run."article_id"
        AND current."article_revision" = run."article_revision"
      JOIN runner_authority ON runner_authority."id" = run."runner_id"
      WHERE run."organization_id" = ${input.organizationId}
        AND run."id" = ${input.receipt.runId}::uuid
        AND run."runner_capability_generation" = runner_authority."runner_capability_generation"
        AND ${input.receipt.schemaFingerprint} = ${input.expectedSchemaFingerprint}
        AND (
          (${input.receipt.observedState} IN ('normal', 'firing', 'no_data')
            AND run."state" = 'succeeded'
            AND run."result_hash" = ${input.receipt.resultHash}
            AND EXISTS (
              SELECT 1 FROM ${workspaceAnalysisResultFragment} fragment
              WHERE fragment."organization_id" = run."organization_id"
                AND fragment."run_id" = run."id"
                AND fragment."block_id" = current."block_id"
                AND fragment."expires_at" > now()
            ))
          OR (${input.receipt.observedState} IN ('error', 'stale')
            AND run."state" IN ('failed', 'cancelled', 'stale')
            AND ${input.receipt.resultHash}::text IS NULL)
        )
      FOR UPDATE OF run
    ), connection_authority AS MATERIALIZED (
      SELECT pin."connection_id"
      FROM current
      JOIN ${workspaceAnalysisArticleConnection} pin
        ON pin."organization_id" = current."organization_id"
       AND pin."article_id" = current."article_id"
       AND pin."article_revision" = current."article_revision"
      JOIN ${workspaceConnection} connection
        ON connection."organization_id" = pin."organization_id"
       AND connection."id" = pin."connection_id"
       AND connection."revision" = pin."connection_revision"
       AND connection."deleted_at" IS NULL
       AND connection."revocation_pending_at" IS NULL
      JOIN ${workspaceConnectionGrant} access_grant
        ON access_grant."organization_id" = connection."organization_id"
       AND access_grant."connection_id" = connection."id"
       AND access_grant."member_id" = ${input.authority.membershipId}
       AND access_grant."capability" IN ('use', 'manage')
      FOR UPDATE OF connection, access_grant
    ), previous AS MATERIALIZED (
      SELECT receipt."state", receipt."created_at"
      FROM ${workspaceAnalysisSignalReceipt} receipt
      JOIN current ON current."id" = receipt."signal_id"
      WHERE receipt."organization_id" = ${input.organizationId}
      ORDER BY receipt."transition_sequence" DESC LIMIT 1
    ), normal_streak AS MATERIALIZED (
      SELECT count(*)::integer AS count
      FROM ${workspaceAnalysisSignalReceipt} receipt
      JOIN current ON current."id" = receipt."signal_id"
      WHERE receipt."organization_id" = ${input.organizationId}
        AND receipt."observed_state" = 'normal'
        AND NOT EXISTS (
          SELECT 1 FROM ${workspaceAnalysisSignalReceipt} newer
          WHERE newer."organization_id" = receipt."organization_id"
            AND newer."signal_id" = receipt."signal_id"
            AND newer."transition_sequence" > receipt."transition_sequence"
            AND newer."observed_state" <> 'normal'
        )
    ), observed_streak AS MATERIALIZED (
      SELECT count(*)::integer AS count
      FROM ${workspaceAnalysisSignalReceipt} receipt
      JOIN current ON current."id" = receipt."signal_id"
      WHERE receipt."organization_id" = ${input.organizationId}
        AND receipt."observed_state" = ${input.receipt.observedState}
        AND NOT EXISTS (
          SELECT 1 FROM ${workspaceAnalysisSignalReceipt} newer
          WHERE newer."organization_id" = receipt."organization_id"
            AND newer."signal_id" = receipt."signal_id"
            AND newer."transition_sequence" > receipt."transition_sequence"
            AND newer."observed_state" <> ${input.receipt.observedState}
        )
    ), gated_observation AS MATERIALIZED (
      SELECT CASE
        WHEN current."definition" #>> '{condition,kind}' = 'missing_data'
          AND ${input.receipt.observedState} = 'no_data'
          AND observed_streak.count + 1
            < (current."definition" #>> '{condition,count}')::integer
          THEN COALESCE(NULLIF(current."last_observed_state", 'unknown'), 'normal')
        WHEN current."definition" #>> '{condition,kind}' = 'consecutive_failure'
          AND ${input.receipt.observedState} = 'error'
          AND observed_streak.count + 1
            < (current."definition" #>> '{condition,count}')::integer
          THEN COALESCE(NULLIF(current."last_observed_state", 'unknown'), 'normal')
        ELSE ${input.receipt.observedState}
      END AS state
      FROM current CROSS JOIN observed_streak
    ), transition AS MATERIALIZED (
      SELECT CASE
        WHEN gated_observation.state = 'normal'
          AND current."last_observed_state" IN ('firing', 'no_data', 'error', 'stale')
          AND normal_streak.count + 1 >= (current."definition"->>'rearmAfterNormalCount')::integer
          THEN 'recovered'
        WHEN gated_observation.state = 'normal'
          AND current."last_observed_state" IN ('firing', 'no_data', 'error', 'stale')
          THEN current."last_observed_state"
        ELSE gated_observation.state
      END AS state,
      COALESCE((SELECT max(receipt."transition_sequence")
        FROM ${workspaceAnalysisSignalReceipt} receipt
        WHERE receipt."organization_id" = ${input.organizationId}
          AND receipt."signal_id" = current."id"), 0) + 1 AS sequence
      FROM current CROSS JOIN normal_streak CROSS JOIN gated_observation
    ), inserted AS MATERIALIZED (
      INSERT INTO ${workspaceAnalysisSignalReceipt}
        ("id", "organization_id", "signal_id", "signal_revision", "run_id",
         "runner_id", "observed_state", "state", "result_hash", "schema_fingerprint",
         "dedupe_key", "transition_sequence", "error_kind", "evaluated_at")
      SELECT ${input.receipt.id}::uuid, ${input.organizationId}, current."id",
        current."revision", run_authority."id", runner_authority."id",
        ${input.receipt.observedState}, transition.state, ${input.receipt.resultHash},
        ${input.receipt.schemaFingerprint}, ${input.receipt.dedupeKey}, transition.sequence,
        ${input.receipt.errorKind}, ${input.receipt.evaluatedAt}
      FROM current CROSS JOIN runner_authority CROSS JOIN run_authority CROSS JOIN transition
      WHERE (SELECT count(*) FROM connection_authority) = (
        SELECT count(*) FROM ${workspaceAnalysisArticleConnection} pin
        WHERE pin."organization_id" = ${input.organizationId}
          AND pin."article_id" = ${input.articleId}::uuid
          AND pin."article_revision" = current."article_revision"
      )
      RETURNING *
    ), updated AS MATERIALIZED (
      UPDATE ${workspaceAnalysisSignal} signal SET
        "last_evaluated_run_id" = inserted."run_id",
        "last_observed_state" = inserted."state",
        "updated_at" = now()
      FROM inserted
      WHERE signal."organization_id" = inserted."organization_id"
        AND signal."id" = inserted."signal_id"
      RETURNING signal."id", signal."definition"
    ), notify AS MATERIALIZED (
      SELECT inserted."id" AS receipt_id, recipient.value AS recipient_member_id,
        channel.value AS channel
      FROM inserted JOIN updated ON updated."id" = inserted."signal_id"
      CROSS JOIN LATERAL jsonb_array_elements_text(
        updated."definition"->'recipientMemberIds') recipient(value)
      CROSS JOIN LATERAL jsonb_array_elements_text(updated."definition"->'channels') channel(value)
      WHERE inserted."state" IN ('firing', 'recovered', 'no_data', 'error', 'stale')
        AND (
          inserted."state" IS DISTINCT FROM (SELECT previous.state FROM previous)
          OR NOT EXISTS (
            SELECT 1 FROM ${workspaceAnalysisSignalReceipt} recent
            WHERE recent."organization_id" = ${input.organizationId}
              AND recent."signal_id" = inserted."signal_id"
              AND recent."id" <> inserted."id"
              AND recent."state" = inserted."state"
              AND recent."created_at" > now()
                - make_interval(secs => (updated."definition"->>'cooldownSeconds')::integer)
          )
        )
    ), notifications AS MATERIALIZED (
      INSERT INTO ${workspaceAnalysisSignalNotification}
        ("organization_id", "receipt_id", "recipient_member_id", "channel")
      SELECT ${input.organizationId}, notify.receipt_id, notify.recipient_member_id, notify.channel
      FROM notify
      JOIN "workspace_control"."member" recipient
        ON recipient."organization_id" = ${input.organizationId}
       AND recipient."id" = notify.recipient_member_id
       AND recipient."revocation_pending_at" IS NULL
      RETURNING "receipt_id"
    ), audit AS MATERIALIZED (
      INSERT INTO ${workspaceAuditEvent}
        ("organization_id", "actor_user_id", "action", "resource_type", "resource_id",
         "redacted_summary", "request_id")
      SELECT ${input.organizationId}, ${input.authority.userId}, 'analysis_signal.evaluated',
        'analysis_signal_receipt', inserted."id"::text,
        jsonb_build_object('signalId', inserted."signal_id", 'signalRevision',
          inserted."signal_revision", 'runId', inserted."run_id", 'state', inserted."state"),
        ${requestId}::uuid
      FROM inserted
      RETURNING "resource_id"
    )
    SELECT inserted."id"::text AS "id", inserted."signal_id"::text AS "signalId",
      inserted."signal_revision" AS "signalRevision", inserted."run_id"::text AS "runId",
      inserted."runner_id"::text AS "runnerId", inserted."observed_state" AS "observedState",
      inserted."state" AS "state", inserted."result_hash" AS "resultHash",
      inserted."schema_fingerprint" AS "schemaFingerprint",
      inserted."transition_sequence" AS "transitionSequence",
      inserted."error_kind" AS "errorKind", inserted."evaluated_at" AS "evaluatedAt",
      inserted."created_at" AS "createdAt",
      (SELECT count(*) FROM notifications) AS "notificationCount"
    FROM inserted JOIN audit ON audit."resource_id" = inserted."id"::text
  `);
  return result.rows[0] ?? null;
}
