import { createHash, randomUUID } from "node:crypto";

import postgres from "postgres";
import { describe, expect, it, vi } from "vitest";
import { activateKnowledgeGraph, type KnowledgeSqlQuery } from "./graph-activation-core";

const queueHarness = vi.hoisted(() => ({
  query: null as null | ((text: string, parameters: unknown[]) => Promise<unknown[]>),
}));
vi.mock("server-only", () => ({}));
vi.mock("../db", () => ({
  neonSql: {
    query: (text: string, parameters: unknown[]) => {
      if (!queueHarness.query) throw new Error("Knowledge queue harness is not connected");
      return queueHarness.query(text, parameters);
    },
  },
}));

const dedicatedDatabaseUrl = process.env.PROVIDER_IMPORT_TEST_DATABASE_URL?.trim() ?? "";
const dedicatedDatabaseSentinel = process.env.PROVIDER_IMPORT_TEST_DATABASE_SENTINEL?.trim() ?? "";
const requested = process.env.WORKSPACE_CLOUD_RUN_POSTGRES_IMPORT_HARNESS === "1";
const enabled = requested
  && process.env.PROVIDER_IMPORT_TEST_DATABASE_ISOLATED === "1"
  && dedicatedDatabaseUrl.length > 0
  && dedicatedDatabaseSentinel.length >= 16;

function queryAdapter(client: ReturnType<typeof postgres>): KnowledgeSqlQuery {
  return async (text, parameters) => await client.unsafe(
    text,
    parameters as never[],
  ) as unknown as readonly Record<string, unknown>[];
}

function artifact(input: {
  graphRevisionId: string;
  sourceId: string;
  projectId: string;
  environmentId: string;
  repository: string;
  commitSha: string;
  parentGraphRevisionId: string | null;
}) {
  return {
    schemaVersion: 1,
    graphRevisionId: input.graphRevisionId,
    environmentRevision: 1,
    binding: {
      sourceId: input.sourceId,
      projectId: input.projectId,
      projectEnvironmentId: input.environmentId,
      provider: "github",
      displayName: input.repository,
      visibility: "shared_graph",
      revision: {
        kind: "github",
        repository_id: "1001",
        repository: input.repository,
        ref_name: "main",
        commit_sha: input.commitSha,
      },
    },
    sourceRevisionSha256: createHash("sha256").update(input.commitSha).digest("hex"),
    parentGraphRevisionId: input.parentGraphRevisionId,
    extractor: {
      id: "dopedb.code-index",
      version: "1.0.0",
      sourceSha256: "b".repeat(64),
    },
    generatedAt: "2026-08-11T00:00:00Z",
    health: { complete: true, parsedFiles: 1, skippedFiles: 0, failedFiles: 0 },
    changedFiles: ["src/main.ts"],
    nodes: [],
    edges: [],
    evidence: [],
  };
}

describe.runIf(enabled)("Project Knowledge PostgreSQL activation contract", () => {
  it("atomically advances the exact source job and preserves the last-good head", async () => {
    const client = postgres(dedicatedDatabaseUrl, { max: 2, prepare: false });
    const organizationId = randomUUID();
    const projectId = randomUUID();
    const environmentId = randomUUID();
    const installationRowId = randomUUID();
    const sourceId = randomUUID();
    const eventId = randomUUID();
    const jobId = randomUUID();
    const graphRevisionId = randomUUID();
    const workerId = randomUUID();
    const commitSha = "a".repeat(40);
    const repository = "json-choi/dopedb";
    try {
      const sentinel = await client<{ confirmed: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM "provider_harness"."isolated_database_sentinel"
          WHERE "marker" = ${dedicatedDatabaseSentinel}
        ) AS "confirmed"
      `;
      expect(sentinel[0]?.confirmed).toBe(true);
      await client.begin(async (transaction) => {
        await transaction`
          INSERT INTO "workspace_control"."organization" ("id", "name", "slug")
          VALUES (${organizationId}, 'Knowledge fixture', ${`knowledge-${organizationId}`})
        `;
        await transaction`
          INSERT INTO "workspace_control"."knowledge_project"
            ("id", "organization_id", "name")
          VALUES (${projectId}, ${organizationId}, 'Fixture')
        `;
        await transaction`
          INSERT INTO "workspace_control"."knowledge_project_environment"
            ("id", "organization_id", "project_id", "name", "production", "risk_class")
          VALUES (${environmentId}, ${organizationId}, ${projectId}, 'main', false, 'development')
        `;
        await transaction`
          INSERT INTO "workspace_control"."knowledge_github_installation"
            ("id", "organization_id", "installation_id", "account_id", "account_login")
          VALUES (${installationRowId}, ${organizationId}, 101, '101', 'fixture')
        `;
        await transaction`
          INSERT INTO "workspace_control"."knowledge_source" (
            "id", "organization_id", "project_id", "project_environment_id",
            "environment_revision", "provider", "display_name", "visibility",
            "github_installation_id", "repository_id", "repository_full_name",
            "ref_name", "commit_sha", "sync_state"
          ) VALUES (
            ${sourceId}, ${organizationId}, ${projectId}, ${environmentId}, 1,
            'github', ${repository}, 'shared_graph', ${installationRowId}, '1001',
            ${repository}, 'main', ${commitSha}, 'syncing'
          )
        `;
        await transaction`
          INSERT INTO "workspace_control"."knowledge_source_event" (
            "id", "organization_id", "source_id", "delivery_id", "event_kind",
            "before_commit_sha", "after_commit_sha", "changed_files"
          ) VALUES (
            ${eventId}, ${organizationId}, ${sourceId}, ${randomUUID()}, 'push',
            ${"0".repeat(40)}, ${commitSha}, '["src/main.ts"]'::jsonb
          )
        `;
        await transaction`
          INSERT INTO "workspace_control"."knowledge_source_sync_job" (
            "id", "organization_id", "source_id", "desired_commit_sha",
            "source_sync_revision", "trigger_event_id", "state", "attempt",
            "claimed_at", "lease_expires_at", "worker_id"
          ) VALUES (
            ${jobId}, ${organizationId}, ${sourceId}, ${commitSha}, 1, ${eventId},
            'claimed', 1, now(), now() + interval '10 minutes', ${workerId}
          )
        `;
      });

      const candidate = artifact({
        graphRevisionId,
        sourceId,
        projectId,
        environmentId,
        repository,
        commitSha,
        parentGraphRevisionId: null,
      });
      const activated = await activateKnowledgeGraph({
        query: queryAdapter(client),
        organizationId,
        sourceId,
        artifact: candidate,
        jobId,
        workerId,
      });
      expect(activated?.graphRevisionId).toBe(graphRevisionId);
      const [state] = await client<Array<{
        syncState: string;
        graphRevisionId: string;
        jobState: string;
        eventState: string;
      }>>`
        SELECT source."sync_state" AS "syncState",
          head."graph_revision_id"::text AS "graphRevisionId",
          job."state" AS "jobState",
          event."state" AS "eventState"
        FROM "workspace_control"."knowledge_source" source
        JOIN "workspace_control"."knowledge_environment_head" head
          ON head."source_id" = source."id"
        JOIN "workspace_control"."knowledge_source_sync_job" job
          ON job."source_id" = source."id"
        JOIN "workspace_control"."knowledge_source_event" event
          ON event."source_id" = source."id"
        WHERE source."id" = ${sourceId}
      `;
      expect(state).toEqual({
        syncState: "ready",
        graphRevisionId,
        jobState: "succeeded",
        eventState: "consumed",
      });

      const stale = artifact({
        graphRevisionId: randomUUID(),
        sourceId,
        projectId,
        environmentId,
        repository,
        commitSha,
        parentGraphRevisionId: randomUUID(),
      });
      const rejected = await activateKnowledgeGraph({
        query: queryAdapter(client),
        organizationId,
        sourceId,
        artifact: stale,
        jobId: randomUUID(),
        workerId: randomUUID(),
      });
      expect(rejected).toBeNull();
      const [head] = await client<Array<{ graphRevisionId: string }>>`
        SELECT "graph_revision_id"::text AS "graphRevisionId"
        FROM "workspace_control"."knowledge_environment_head"
        WHERE "source_id" = ${sourceId}
      `;
      expect(head?.graphRevisionId).toBe(graphRevisionId);

      queueHarness.query = async (text, parameters) => await client.unsafe(
        text,
        parameters as never[],
      ) as unknown as unknown[];
      const {
        recordGithubKnowledgePush,
        reconcileGithubKnowledgeCommit,
      } = await import("./sync-queue");
      const nextCommitSha = "c".repeat(40);
      const deliveryId = randomUUID();
      const firstPush = await recordGithubKnowledgePush({
        organizationId,
        sourceId,
        deliveryId,
        beforeCommitSha: commitSha,
        afterCommitSha: nextCommitSha,
        changedFiles: ["src/next.ts"],
      });
      const duplicatePush = await recordGithubKnowledgePush({
        organizationId,
        sourceId,
        deliveryId,
        beforeCommitSha: commitSha,
        afterCommitSha: nextCommitSha,
        changedFiles: ["src/next.ts"],
      });
      expect(firstPush?.eventId).toBeTypeOf("string");
      expect(duplicatePush).toBeNull();
      await reconcileGithubKnowledgeCommit({
        organizationId,
        sourceId,
        observedCommitSha: nextCommitSha,
      });
      const [queued] = await client<Array<{
        syncRevision: number;
        jobs: number;
        events: number;
      }>>`
        SELECT source."sync_revision"::int AS "syncRevision",
          count(DISTINCT job."id") FILTER (
            WHERE job."desired_commit_sha" = ${nextCommitSha}
          )::int AS "jobs",
          count(DISTINCT event."id") FILTER (
            WHERE event."delivery_id" = ${deliveryId}
          )::int AS "events"
        FROM "workspace_control"."knowledge_source" source
        LEFT JOIN "workspace_control"."knowledge_source_sync_job" job
          ON job."source_id" = source."id"
        LEFT JOIN "workspace_control"."knowledge_source_event" event
          ON event."source_id" = source."id"
        WHERE source."id" = ${sourceId}
        GROUP BY source."sync_revision"
      `;
      expect(queued).toEqual({ syncRevision: 2, jobs: 1, events: 1 });
      await recordGithubKnowledgePush({
        organizationId,
        sourceId,
        deliveryId: randomUUID(),
        beforeCommitSha: nextCommitSha,
        afterCommitSha: commitSha,
        changedFiles: ["src/main.ts"],
      });
      const [requeued] = await client<Array<{
        sourceSyncRevision: number;
        jobSyncRevision: number;
        state: string;
        attempt: number;
      }>>`
        SELECT source."sync_revision"::int AS "sourceSyncRevision",
          job."source_sync_revision"::int AS "jobSyncRevision",
          job."state", job."attempt"
        FROM "workspace_control"."knowledge_source" source
        JOIN "workspace_control"."knowledge_source_sync_job" job
          ON job."source_id" = source."id"
         AND job."desired_commit_sha" = ${commitSha}
        WHERE source."id" = ${sourceId}
      `;
      expect(requeued).toEqual({
        sourceSyncRevision: 3,
        jobSyncRevision: 3,
        state: "queued",
        attempt: 0,
      });
      const staleDeliveryId = randomUUID();
      const stalePush = await recordGithubKnowledgePush({
        organizationId,
        sourceId,
        deliveryId: staleDeliveryId,
        beforeCommitSha: nextCommitSha,
        afterCommitSha: "d".repeat(40),
        changedFiles: ["src/stale.ts"],
      });
      expect(stalePush).toEqual({
        eventId: expect.any(String),
        jobId: null,
      });
      const [staleState] = await client<Array<{
        commitSha: string;
        syncRevision: number;
        eventState: string;
      }>>`
        SELECT source."commit_sha" AS "commitSha",
          source."sync_revision"::int AS "syncRevision",
          event."state" AS "eventState"
        FROM "workspace_control"."knowledge_source" source
        JOIN "workspace_control"."knowledge_source_event" event
          ON event."source_id" = source."id"
         AND event."delivery_id" = ${staleDeliveryId}
        WHERE source."id" = ${sourceId}
      `;
      expect(staleState).toEqual({
        commitSha,
        syncRevision: 3,
        eventState: "failed",
      });
      const {
        claimCodeIndexJob,
        failCodeIndexJob,
        insertCodeIndexManifestBatch,
        CodeIndexFailure,
      } = await import("./code-indexer");
      const queueWorkerId = randomUUID();
      const queueQuery = queryAdapter(client);
      const claimed = await claimCodeIndexJob(queueQuery, queueWorkerId);
      expect(claimed?.desiredCommitSha).toBe(commitSha);
      expect(claimed?.attempt).toBe(0);
      await insertCodeIndexManifestBatch(queueQuery, claimed!, queueWorkerId, [{
        path: "src/main.ts",
        blobSha: "d".repeat(40),
        bytes: 100,
        language: "typescript",
        initialState: "pending",
        failureCode: null,
      }]);
      await insertCodeIndexManifestBatch(queueQuery, claimed!, randomUUID(), [{
        path: "src/rejected.ts",
        blobSha: "e".repeat(40),
        bytes: 100,
        language: "typescript",
        initialState: "pending",
        failureCode: null,
      }]);
      const [manifestState] = await client<Array<{ files: number }>>`
        SELECT count(*)::int AS "files"
        FROM "workspace_control"."knowledge_code_index_file"
        WHERE "job_id" = ${claimed!.id}
      `;
      expect(manifestState?.files).toBe(1);
      await failCodeIndexJob(
        queueQuery,
        claimed!,
        queueWorkerId,
        new CodeIndexFailure("fixture_retry", true),
      );
      const [retried] = await client<Array<{
        state: string;
        attempt: number;
        failureCode: string;
        syncState: string;
      }>>`
        SELECT job."state", job."attempt", job."failure_code" AS "failureCode",
          source."sync_state" AS "syncState"
        FROM "workspace_control"."knowledge_source_sync_job" job
        JOIN "workspace_control"."knowledge_source" source
          ON source."id" = job."source_id"
        WHERE job."id" = ${claimed!.id}
      `;
      expect(retried).toEqual({
        state: "queued",
        attempt: 1,
        failureCode: "fixture_retry",
        syncState: "pending",
      });
      await client`
        UPDATE "workspace_control"."knowledge_source_sync_job"
        SET "available_at" = now()
        WHERE "id" = ${claimed!.id}
      `;
      const terminalWorkerId = randomUUID();
      const reclaimed = await claimCodeIndexJob(queueQuery, terminalWorkerId);
      expect(reclaimed?.id).toBe(claimed!.id);
      await failCodeIndexJob(
        queueQuery,
        reclaimed!,
        terminalWorkerId,
        new CodeIndexFailure("fixture_terminal", false),
      );
      const [terminal] = await client<Array<{
        state: string;
        files: number;
        syncState: string;
      }>>`
        SELECT job."state", count(file."path")::int AS "files",
          source."sync_state" AS "syncState"
        FROM "workspace_control"."knowledge_source_sync_job" job
        JOIN "workspace_control"."knowledge_source" source
          ON source."id" = job."source_id"
        LEFT JOIN "workspace_control"."knowledge_code_index_file" file
          ON file."job_id" = job."id"
        WHERE job."id" = ${claimed!.id}
        GROUP BY job."state", source."sync_state"
      `;
      expect(terminal).toEqual({ state: "failed", files: 0, syncState: "failed" });
    } finally {
      queueHarness.query = null;
      await client`
        DELETE FROM "workspace_control"."organization" WHERE "id" = ${organizationId}
      `.catch(() => undefined);
      await client.end({ timeout: 5 });
    }
  });
});
