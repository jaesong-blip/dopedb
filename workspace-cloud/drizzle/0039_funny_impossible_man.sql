CREATE TABLE "workspace_control"."knowledge_code_index_file" (
	"organization_id" text NOT NULL,
	"job_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"commit_sha" text NOT NULL,
	"path" text NOT NULL,
	"blob_sha" text NOT NULL,
	"bytes" integer NOT NULL,
	"language" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"analysis" jsonb,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_code_index_file_job_id_path_pk" PRIMARY KEY("job_id","path"),
	CONSTRAINT "knowledge_code_index_file_commit" CHECK ("workspace_control"."knowledge_code_index_file"."commit_sha" ~ '^[0-9a-f]{40}$' AND "workspace_control"."knowledge_code_index_file"."blob_sha" ~ '^[0-9a-f]{40}$'),
	CONSTRAINT "knowledge_code_index_file_path" CHECK (char_length("workspace_control"."knowledge_code_index_file"."path") BETWEEN 1 AND 4096
        AND "workspace_control"."knowledge_code_index_file"."path" !~ '(^/|\\|(^|/)\.\.?(/|$)|//)'),
	CONSTRAINT "knowledge_code_index_file_bytes" CHECK ("workspace_control"."knowledge_code_index_file"."bytes" BETWEEN 0 AND 1048576),
	CONSTRAINT "knowledge_code_index_file_state" CHECK ("workspace_control"."knowledge_code_index_file"."state" IN ('pending', 'ready', 'skipped')),
	CONSTRAINT "knowledge_code_index_file_analysis" CHECK (("workspace_control"."knowledge_code_index_file"."state" = 'ready' AND jsonb_typeof("workspace_control"."knowledge_code_index_file"."analysis") = 'object')
        OR ("workspace_control"."knowledge_code_index_file"."state" <> 'ready' AND "workspace_control"."knowledge_code_index_file"."analysis" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "workspace_control"."knowledge_source_sync_job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"source_id" uuid NOT NULL,
	"desired_commit_sha" text NOT NULL,
	"source_sync_revision" bigint NOT NULL,
	"trigger_event_id" uuid,
	"phase" text DEFAULT 'manifest' NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"total_files" integer DEFAULT 0 NOT NULL,
	"processed_files" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"worker_id" text,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "knowledge_source_sync_job_state" CHECK ("workspace_control"."knowledge_source_sync_job"."state" IN ('queued', 'claimed', 'succeeded', 'failed', 'superseded')),
	CONSTRAINT "knowledge_source_sync_job_phase" CHECK ("workspace_control"."knowledge_source_sync_job"."phase" IN ('manifest', 'indexing', 'activating')),
	CONSTRAINT "knowledge_source_sync_job_commit" CHECK ("workspace_control"."knowledge_source_sync_job"."desired_commit_sha" ~ '^[0-9a-f]{40}$'),
	CONSTRAINT "knowledge_source_sync_job_revision_positive" CHECK ("workspace_control"."knowledge_source_sync_job"."source_sync_revision" >= 1),
	CONSTRAINT "knowledge_source_sync_job_attempt" CHECK ("workspace_control"."knowledge_source_sync_job"."attempt" >= 0 AND "workspace_control"."knowledge_source_sync_job"."attempt" <= 20),
	CONSTRAINT "knowledge_source_sync_job_progress" CHECK ("workspace_control"."knowledge_source_sync_job"."total_files" >= 0
        AND "workspace_control"."knowledge_source_sync_job"."processed_files" >= 0
        AND "workspace_control"."knowledge_source_sync_job"."processed_files" <= "workspace_control"."knowledge_source_sync_job"."total_files"),
	CONSTRAINT "knowledge_source_sync_job_claim_shape" CHECK ((
        "workspace_control"."knowledge_source_sync_job"."state" = 'claimed'
        AND "workspace_control"."knowledge_source_sync_job"."claimed_at" IS NOT NULL
        AND "workspace_control"."knowledge_source_sync_job"."lease_expires_at" IS NOT NULL
        AND "workspace_control"."knowledge_source_sync_job"."worker_id" IS NOT NULL
      ) OR "workspace_control"."knowledge_source_sync_job"."state" <> 'claimed')
);
--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_source" DROP CONSTRAINT "knowledge_source_local_share_only";--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_source" DROP CONSTRAINT "knowledge_source_provider";--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_source" DROP CONSTRAINT "knowledge_source_visibility";--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_source" DROP CONSTRAINT "knowledge_source_provider_shape";--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_source" ADD COLUMN "last_reconciled_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_source_sync_job_org_id_idx" ON "workspace_control"."knowledge_source_sync_job" USING btree ("organization_id","id");--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_code_index_file" ADD CONSTRAINT "knowledge_code_index_file_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "workspace_control"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_code_index_file" ADD CONSTRAINT "knowledge_code_index_file_job_id_knowledge_source_sync_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "workspace_control"."knowledge_source_sync_job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_code_index_file" ADD CONSTRAINT "knowledge_code_index_file_source_id_knowledge_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "workspace_control"."knowledge_source"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_code_index_file" ADD CONSTRAINT "knowledge_code_index_file_org_job_fk" FOREIGN KEY ("organization_id","job_id") REFERENCES "workspace_control"."knowledge_source_sync_job"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_code_index_file" ADD CONSTRAINT "knowledge_code_index_file_org_source_fk" FOREIGN KEY ("organization_id","source_id") REFERENCES "workspace_control"."knowledge_source"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_source_sync_job" ADD CONSTRAINT "knowledge_source_sync_job_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "workspace_control"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_source_sync_job" ADD CONSTRAINT "knowledge_source_sync_job_source_id_knowledge_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "workspace_control"."knowledge_source"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_source_sync_job" ADD CONSTRAINT "knowledge_source_sync_job_trigger_event_id_knowledge_source_event_id_fk" FOREIGN KEY ("trigger_event_id") REFERENCES "workspace_control"."knowledge_source_event"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_source_sync_job" ADD CONSTRAINT "knowledge_source_sync_job_org_source_fk" FOREIGN KEY ("organization_id","source_id") REFERENCES "workspace_control"."knowledge_source"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_code_index_file_pending_idx" ON "workspace_control"."knowledge_code_index_file" USING btree ("job_id","state","path");--> statement-breakpoint
CREATE INDEX "knowledge_code_index_file_reuse_idx" ON "workspace_control"."knowledge_code_index_file" USING btree ("organization_id","source_id","blob_sha","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_source_sync_job_revision_idx" ON "workspace_control"."knowledge_source_sync_job" USING btree ("source_id","desired_commit_sha");--> statement-breakpoint
CREATE INDEX "knowledge_source_sync_job_claim_idx" ON "workspace_control"."knowledge_source_sync_job" USING btree ("state","available_at","created_at");--> statement-breakpoint
CREATE INDEX "knowledge_source_sync_job_source_idx" ON "workspace_control"."knowledge_source_sync_job" USING btree ("organization_id","source_id","created_at");--> statement-breakpoint
DELETE FROM "workspace_control"."knowledge_source"
WHERE "provider" <> 'github';--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_source" DROP COLUMN "root_fingerprint";--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_source" DROP COLUMN "snapshot_sha256";--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_source" ADD CONSTRAINT "knowledge_source_provider" CHECK ("workspace_control"."knowledge_source"."provider" = 'github');--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_source" ADD CONSTRAINT "knowledge_source_visibility" CHECK ("workspace_control"."knowledge_source"."visibility" = 'shared_graph');--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_source" ADD CONSTRAINT "knowledge_source_provider_shape" CHECK ((
        "workspace_control"."knowledge_source"."provider" = 'github'
        AND "workspace_control"."knowledge_source"."github_installation_id" IS NOT NULL
        AND "workspace_control"."knowledge_source"."repository_id" IS NOT NULL
        AND "workspace_control"."knowledge_source"."repository_full_name" IS NOT NULL
        AND "workspace_control"."knowledge_source"."ref_name" IS NOT NULL
        AND "workspace_control"."knowledge_source"."commit_sha" ~ '^[0-9a-f]{40}$'
      ));--> statement-breakpoint
UPDATE "workspace_control"."knowledge_source" source
SET "sync_state" = 'pending',
	"last_failure_code" = NULL,
	"updated_at" = now()
FROM "workspace_control"."knowledge_github_installation" installation
WHERE installation."organization_id" = source."organization_id"
	AND installation."id" = source."github_installation_id"
	AND installation."status" = 'active'
	AND source."revoked_at" IS NULL;--> statement-breakpoint
INSERT INTO "workspace_control"."knowledge_source_sync_job" (
	"organization_id", "source_id", "desired_commit_sha", "source_sync_revision"
)
SELECT source."organization_id", source."id", source."commit_sha", source."sync_revision"
FROM "workspace_control"."knowledge_source" source
JOIN "workspace_control"."knowledge_github_installation" installation
	ON installation."organization_id" = source."organization_id"
	AND installation."id" = source."github_installation_id"
	AND installation."status" = 'active'
WHERE source."revoked_at" IS NULL
ON CONFLICT ("source_id", "desired_commit_sha") DO NOTHING;
