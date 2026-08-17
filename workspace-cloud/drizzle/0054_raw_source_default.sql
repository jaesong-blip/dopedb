-- GitHub source browsing replaces hosted graph construction as the free/default
-- path. Preserve every activated graph and head, but stop unfinished builds and
-- release their durable staging storage.
UPDATE "workspace_control"."knowledge_source_sync_job"
SET "state" = 'superseded',
    "failure_code" = 'knowledge_graphs_disabled',
    "claimed_at" = NULL,
    "lease_expires_at" = NULL,
    "worker_id" = NULL,
    "finished_at" = now(),
    "updated_at" = now()
WHERE "state" IN ('queued', 'claimed');
--> statement-breakpoint
DELETE FROM "workspace_control"."knowledge_code_index_activation_entity" entity
USING "workspace_control"."knowledge_source_sync_job" job
WHERE entity."job_id" = job."id"
  AND job."state" = 'superseded'
  AND job."failure_code" = 'knowledge_graphs_disabled';
--> statement-breakpoint
DELETE FROM "workspace_control"."knowledge_code_index_activation_fragment" fragment
USING "workspace_control"."knowledge_source_sync_job" job
WHERE fragment."job_id" = job."id"
  AND job."state" = 'superseded'
  AND job."failure_code" = 'knowledge_graphs_disabled';
--> statement-breakpoint
DELETE FROM "workspace_control"."knowledge_code_index_file" file
USING "workspace_control"."knowledge_source_sync_job" job
WHERE file."job_id" = job."id"
  AND job."state" = 'superseded'
  AND job."failure_code" = 'knowledge_graphs_disabled';
--> statement-breakpoint
UPDATE "workspace_control"."knowledge_source_event"
SET "state" = 'failed', "consumed_at" = now()
WHERE "state" IN ('pending', 'claimed');
--> statement-breakpoint
UPDATE "workspace_control"."knowledge_source"
SET "sync_state" = 'ready',
    "last_failure_code" = NULL,
    "last_reconciled_at" = now(),
    "updated_at" = now()
WHERE "provider" = 'github'
  AND "revoked_at" IS NULL
  AND "sync_state" IN ('pending', 'syncing', 'failed');
