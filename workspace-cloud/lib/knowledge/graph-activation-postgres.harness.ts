import { createHash, randomUUID } from "node:crypto";

import postgres from "postgres";
import { describe, expect, it, vi } from "vitest";
import { activateKnowledgeGraph, type KnowledgeSqlQuery } from "./graph-activation-core";
import { canonicalKnowledgeJson } from "./canonical-json";

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
vi.mock("./github-app", async (importOriginal) => {
  const original = await importOriginal<typeof import("./github-app")>();
  return {
    ...original,
    githubSourceManifest: async (_installationId: bigint, _repository: string, commit: string) => [{
      path: "src/main.ts",
      blobSha: commit,
      bytes: 100,
    }],
  };
});

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
      const canonicalVector = {
        z: [{ "β": 2, a: 1 }, "한글"],
        a: { "😀": true, "": null, 2: "two", 10: "ten" },
      };
      const [databaseCanonical] = await client<Array<{ canonical: string; sha: string }>>`
        SELECT "workspace_control"."knowledge_canonical_json"(${JSON.stringify(canonicalVector)}::text::jsonb)
            AS "canonical",
          encode(digest(convert_to(
            "workspace_control"."knowledge_canonical_json"(${JSON.stringify(canonicalVector)}::text::jsonb),
            'UTF8'
          ), 'sha256'), 'hex') AS "sha"
      `;
      expect(databaseCanonical).toEqual({
        canonical: canonicalKnowledgeJson(canonicalVector),
        sha: createHash("sha256").update(canonicalKnowledgeJson(canonicalVector)).digest("hex"),
      });
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
      const emptySourceId = randomUUID();
      const emptyJobId = randomUUID();
      const emptyCommitSha = "e".repeat(40);
      await client`
        INSERT INTO "workspace_control"."knowledge_source" (
          "id", "organization_id", "project_id", "project_environment_id",
          "environment_revision", "display_name", "provider",
          "visibility", "github_installation_id", "repository_id",
          "repository_full_name", "ref_name", "commit_sha", "sync_state"
        ) VALUES (
          ${emptySourceId}, ${organizationId}, ${projectId}, ${environmentId}, 1,
          'json-choi/empty', 'github', 'shared_graph',
          ${installationRowId}, '1002', 'json-choi/empty', 'main', ${emptyCommitSha}, 'pending'
        )
      `;
      await client`
        INSERT INTO "workspace_control"."knowledge_source_sync_job" (
          "id", "organization_id", "source_id", "desired_commit_sha",
          "source_sync_revision", "phase", "state", "manifest", "total_files",
          "processed_files", "source_revision_sha256"
        ) VALUES (
          ${emptyJobId}, ${organizationId}, ${emptySourceId}, ${emptyCommitSha},
          1, 'activating', 'queued', '[]'::jsonb, 0, 0,
          ${createHash("sha256").update("").digest("hex")}
        )
      `;
      const { processCodeIndexQueue } = await import("./code-indexer");
      let activationError: unknown;
      const activationQuery: KnowledgeSqlQuery = async (text, parameters) => {
        try {
          return await queryAdapter(client)(text, parameters);
        } catch (error) {
          activationError = error;
          throw error;
        }
      };
      expect(await processCodeIndexQueue({
        maxSteps: 1,
        deadlineMs: 29_999,
        query: activationQuery,
      })).toEqual({ completed: 0, advanced: 0, failed: 0, yielded: 1 });
      const [yieldedActivation] = await client<Array<{
        state: string;
        activationGraphRevisionId: string | null;
      }>>`
        SELECT "state", "activation_graph_revision_id"::text AS "activationGraphRevisionId"
        FROM "workspace_control"."knowledge_source_sync_job"
        WHERE "id" = ${emptyJobId}
      `;
      expect(yieldedActivation).toEqual({ state: "queued", activationGraphRevisionId: null });
      expect(await processCodeIndexQueue({
        maxSteps: 1,
        deadlineMs: 40_000,
        query: activationQuery,
      })).toEqual({ completed: 0, advanced: 1, failed: 0, yielded: 0 });

      // A head that changes after the durable activation identity was captured
      // must win the CAS. The staged candidate stays retryable and the last-good
      // head remains untouched.
      const competingGraphRevisionId = randomUUID();
      await client`
        INSERT INTO "workspace_control"."knowledge_graph_revision" (
          "id", "organization_id", "source_id", "project_environment_id",
          "environment_revision", "source_revision_sha256", "artifact_sha256",
          "artifact", "generated_at"
        ) VALUES (
          ${competingGraphRevisionId}, ${organizationId}, ${emptySourceId}, ${environmentId},
          1, ${"c".repeat(64)}, ${"d".repeat(64)}, '{}'::jsonb, now()
        )
      `;
      await client`
        INSERT INTO "workspace_control"."knowledge_environment_head" (
          "organization_id", "project_environment_id", "source_id",
          "graph_revision_id", "environment_revision"
        ) VALUES (
          ${organizationId}, ${environmentId}, ${emptySourceId},
          ${competingGraphRevisionId}, 1
        )
      `;
      expect(await processCodeIndexQueue({
        maxSteps: 1,
        deadlineMs: 40_000,
        query: activationQuery,
      })).toEqual({ completed: 0, advanced: 0, failed: 1, yielded: 0 });
      const [staleActivation] = await client<Array<{
        graphRevisionId: string;
        jobState: string;
        failureCode: string;
        candidateRevisions: number;
      }>>`
        SELECT head."graph_revision_id"::text AS "graphRevisionId",
          job."state" AS "jobState", job."failure_code" AS "failureCode",
          count(revision."id") FILTER (
            WHERE revision."id" = job."activation_graph_revision_id"
          )::int AS "candidateRevisions"
        FROM "workspace_control"."knowledge_source_sync_job" job
        JOIN "workspace_control"."knowledge_environment_head" head
          ON head."source_id" = job."source_id"
        LEFT JOIN "workspace_control"."knowledge_graph_revision" revision
          ON revision."source_id" = job."source_id"
        WHERE job."id" = ${emptyJobId}
        GROUP BY head."graph_revision_id", job."state", job."failure_code"
      `;
      expect(staleActivation).toEqual({
        graphRevisionId: competingGraphRevisionId,
        jobState: "queued",
        failureCode: "code_index_parent_stale",
        candidateRevisions: 0,
      });
      await client`
        DELETE FROM "workspace_control"."knowledge_environment_head"
        WHERE "source_id" = ${emptySourceId}
      `;
      await client`
        UPDATE "workspace_control"."knowledge_source_sync_job"
        SET "available_at" = now()
        WHERE "id" = ${emptyJobId}
      `;
      const activatedEmptyQueue = await processCodeIndexQueue({
        maxSteps: 1,
        deadlineMs: 40_000,
        query: activationQuery,
      });
      if (activationError) throw activationError;
      if (activatedEmptyQueue.failed > 0) {
        const [failedActivation] = await client<Array<{ failureCode: string }>>`
          SELECT "failure_code" AS "failureCode"
          FROM "workspace_control"."knowledge_source_sync_job" WHERE "id" = ${emptyJobId}
        `;
        throw new Error(`staged activation failed: ${failedActivation?.failureCode}`);
      }
      expect(activatedEmptyQueue).toEqual({ completed: 1, advanced: 0, failed: 0, yielded: 0 });
      const [emptyActivation] = await client<Array<{
        jobState: string;
        syncState: string;
        graphRevisionId: string;
        artifactSha256: string;
        calculatedSha256: string;
      }>>`
        SELECT job."state" AS "jobState", source."sync_state" AS "syncState",
          head."graph_revision_id"::text AS "graphRevisionId",
          revision."artifact_sha256" AS "artifactSha256",
          encode(digest(convert_to(
            "workspace_control"."knowledge_canonical_json"(revision."artifact"), 'UTF8'
          ), 'sha256'), 'hex') AS "calculatedSha256"
        FROM "workspace_control"."knowledge_source_sync_job" job
        JOIN "workspace_control"."knowledge_source" source ON source."id" = job."source_id"
        JOIN "workspace_control"."knowledge_environment_head" head ON head."source_id" = source."id"
        JOIN "workspace_control"."knowledge_graph_revision" revision
          ON revision."id" = head."graph_revision_id"
        WHERE job."id" = ${emptyJobId}
      `;
      expect(emptyActivation?.jobState).toBe("succeeded");
      expect(emptyActivation?.syncState).toBe("ready");
      expect(emptyActivation?.graphRevisionId).toBeTypeOf("string");
      expect(emptyActivation?.artifactSha256).toBe(emptyActivation?.calculatedSha256);

      const indexedSourceId = randomUUID();
      const indexedJobId = randomUUID();
      const indexedCommitSha = "f".repeat(40);
      const indexedBlobSha = "1".repeat(40);
      const { analyzeCodeFile, codeIndexSourceRevisionSha256 } = await import("./code-index-core");
      const indexedAnalysis = analyzeCodeFile(
        "src/main.ts",
        Buffer.from("export function main() { return true }"),
      );
      const indexedManifest = [{ path: "src/main.ts", blobSha: indexedBlobSha, bytes: 39 }];
      await client`
        INSERT INTO "workspace_control"."knowledge_source" (
          "id", "organization_id", "project_id", "project_environment_id",
          "environment_revision", "display_name", "provider", "visibility",
          "github_installation_id", "repository_id", "repository_full_name",
          "ref_name", "commit_sha", "sync_state"
        ) VALUES (
          ${indexedSourceId}, ${organizationId}, ${projectId}, ${environmentId}, 1,
          'json-choi/indexed', 'github', 'shared_graph', ${installationRowId},
          '1003', 'json-choi/indexed', 'main', ${indexedCommitSha}, 'pending'
        )
      `;
      await client`
        INSERT INTO "workspace_control"."knowledge_source_sync_job" (
          "id", "organization_id", "source_id", "desired_commit_sha",
          "source_sync_revision", "phase", "state", "manifest", "total_files",
          "processed_files", "source_revision_sha256"
        ) VALUES (
          ${indexedJobId}, ${organizationId}, ${indexedSourceId}, ${indexedCommitSha},
          1, 'activating', 'queued', ${JSON.stringify(indexedManifest)}::text::jsonb,
          1, 1, ${codeIndexSourceRevisionSha256(indexedManifest)}
        )
      `;
      await client`
        INSERT INTO "workspace_control"."knowledge_code_index_file" (
          "organization_id", "job_id", "source_id", "commit_sha", "path",
          "blob_sha", "bytes", "language", "state", "analysis"
        ) VALUES (
          ${organizationId}, ${indexedJobId}, ${indexedSourceId}, ${indexedCommitSha},
          'src/main.ts', ${indexedBlobSha}, 39, 'typescript', 'ready',
          ${JSON.stringify(indexedAnalysis)}::text::jsonb
        )
      `;
      for (const expected of [
        { completed: 0, advanced: 1, failed: 0, yielded: 0 },
        { completed: 0, advanced: 1, failed: 0, yielded: 0 },
        { completed: 1, advanced: 0, failed: 0, yielded: 0 },
      ]) {
        const result = await processCodeIndexQueue({
          maxSteps: 1,
          deadlineMs: 40_000,
          query: activationQuery,
        });
        if (result.failed > 0) {
          const [failedActivation] = await client<Array<{
            failureCode: string;
            phase: string;
            state: string;
          }>>`
            SELECT "failure_code" AS "failureCode", "phase", "state"
            FROM "workspace_control"."knowledge_source_sync_job"
            WHERE "id" = ${indexedJobId}
          `;
          throw new Error(
            `indexed activation failed in ${failedActivation?.phase}/${failedActivation?.state}: ${failedActivation?.failureCode}`,
          );
        }
        expect(result).toEqual(expected);
      }
      const [indexedActivation] = await client<Array<{
        nodes: number;
        artifactSha256: string;
        calculatedSha256: string;
      }>>`
        SELECT jsonb_array_length(revision."artifact" -> 'nodes')::int AS "nodes",
          revision."artifact_sha256" AS "artifactSha256",
          encode(digest(convert_to(
            "workspace_control"."knowledge_canonical_json"(revision."artifact"), 'UTF8'
          ), 'sha256'), 'hex') AS "calculatedSha256"
        FROM "workspace_control"."knowledge_environment_head" head
        JOIN "workspace_control"."knowledge_graph_revision" revision
          ON revision."id" = head."graph_revision_id"
        WHERE head."source_id" = ${indexedSourceId}
      `;
      expect(indexedActivation?.nodes).toBeGreaterThanOrEqual(2);
      expect(indexedActivation?.artifactSha256).toBe(indexedActivation?.calculatedSha256);
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
      expect(claimed?.manifest).toEqual([{
        path: "src/main.ts",
        blobSha: commitSha,
        bytes: 100,
      }]);
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
      await client`
        INSERT INTO "workspace_control"."knowledge_code_index_activation_fragment" (
          "organization_id", "job_id", "source_id", "batch_index",
          "start_path", "end_path", "file_count", "parsed_files", "skipped_files"
        ) VALUES (
          ${organizationId}, ${claimed!.id}, ${sourceId}, 0,
          'src/main.ts', 'src/main.ts', 1, 1, 0
        )
      `;
      const stagedEntityId = "f".repeat(64);
      await client`
        INSERT INTO "workspace_control"."knowledge_code_index_activation_entity" (
          "organization_id", "job_id", "source_id", "entity_kind", "entity_id",
          "batch_index", "primary_definition", "payload", "canonical_payload"
        ) VALUES (
          ${organizationId}, ${claimed!.id}, ${sourceId}, 'node', ${stagedEntityId},
          0, true, ${JSON.stringify({
            id: stagedEntityId,
            kind: "file",
            name: "main.ts",
            qualifiedName: "src/main.ts",
          })}::text::jsonb,
          ${canonicalKnowledgeJson({
            id: stagedEntityId,
            kind: "file",
            name: "main.ts",
            qualifiedName: "src/main.ts",
          })}
        )
      `;
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
        fragments: number;
        entities: number;
      }>>`
        SELECT job."state", job."attempt", job."failure_code" AS "failureCode",
          source."sync_state" AS "syncState", count(DISTINCT fragment."batch_index")::int AS "fragments",
          count(DISTINCT entity."entity_id")::int AS "entities"
        FROM "workspace_control"."knowledge_source_sync_job" job
        JOIN "workspace_control"."knowledge_source" source
          ON source."id" = job."source_id"
        LEFT JOIN "workspace_control"."knowledge_code_index_activation_fragment" fragment
          ON fragment."job_id" = job."id"
        LEFT JOIN "workspace_control"."knowledge_code_index_activation_entity" entity
          ON entity."job_id" = job."id"
        WHERE job."id" = ${claimed!.id}
        GROUP BY job."state", job."attempt", job."failure_code", source."sync_state"
      `;
      expect(retried).toEqual({
        state: "queued",
        attempt: 1,
        failureCode: "fixture_retry",
        syncState: "pending",
        fragments: 1,
        entities: 1,
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
        fragments: number;
        entities: number;
        syncState: string;
      }>>`
        SELECT job."state", count(DISTINCT file."path")::int AS "files",
          count(DISTINCT fragment."batch_index")::int AS "fragments",
          count(DISTINCT entity."entity_id")::int AS "entities",
          source."sync_state" AS "syncState"
        FROM "workspace_control"."knowledge_source_sync_job" job
        JOIN "workspace_control"."knowledge_source" source
          ON source."id" = job."source_id"
        LEFT JOIN "workspace_control"."knowledge_code_index_file" file
          ON file."job_id" = job."id"
        LEFT JOIN "workspace_control"."knowledge_code_index_activation_fragment" fragment
          ON fragment."job_id" = job."id"
        LEFT JOIN "workspace_control"."knowledge_code_index_activation_entity" entity
          ON entity."job_id" = job."id"
        WHERE job."id" = ${claimed!.id}
        GROUP BY job."state", source."sync_state"
      `;
      expect(terminal).toEqual({
        state: "failed",
        files: 0,
        fragments: 0,
        entities: 0,
        syncState: "failed",
      });
    } finally {
      queueHarness.query = null;
      await client`
        DELETE FROM "workspace_control"."organization" WHERE "id" = ${organizationId}
      `.catch(() => undefined);
      await client.end({ timeout: 5 });
    }
  });
});
