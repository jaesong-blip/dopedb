CREATE TABLE "workspace_control"."knowledge_code_index_activation_entity" (
	"organization_id" text NOT NULL,
	"job_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"entity_kind" text NOT NULL,
	"entity_id" text NOT NULL,
	"batch_index" integer NOT NULL,
	"primary_definition" boolean DEFAULT false NOT NULL,
	"payload" jsonb NOT NULL,
	"canonical_payload" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_code_index_activation_entity_job_id_entity_kind_entity_id_pk" PRIMARY KEY("job_id","entity_kind","entity_id"),
	CONSTRAINT "knowledge_code_index_activation_entity_kind" CHECK ("workspace_control"."knowledge_code_index_activation_entity"."entity_kind" IN ('node', 'edge', 'evidence')),
	CONSTRAINT "knowledge_code_index_activation_entity_identity" CHECK ("workspace_control"."knowledge_code_index_activation_entity"."entity_id" ~ '^[0-9a-f]{64}$'
        AND "workspace_control"."knowledge_code_index_activation_entity"."batch_index" >= 0
        AND jsonb_typeof("workspace_control"."knowledge_code_index_activation_entity"."payload") = 'object'
        AND "workspace_control"."knowledge_code_index_activation_entity"."payload" ->> 'id' = "workspace_control"."knowledge_code_index_activation_entity"."entity_id"
        AND octet_length("workspace_control"."knowledge_code_index_activation_entity"."canonical_payload") BETWEEN 2 AND 2097152
        AND "workspace_control"."knowledge_code_index_activation_entity"."canonical_payload"::jsonb = "workspace_control"."knowledge_code_index_activation_entity"."payload"
        AND left("workspace_control"."knowledge_code_index_activation_entity"."canonical_payload", 1) = '{'
        AND right("workspace_control"."knowledge_code_index_activation_entity"."canonical_payload", 1) = '}'),
	CONSTRAINT "knowledge_code_index_activation_entity_primary" CHECK (NOT "workspace_control"."knowledge_code_index_activation_entity"."primary_definition" OR "workspace_control"."knowledge_code_index_activation_entity"."entity_kind" = 'node')
);
--> statement-breakpoint
CREATE TABLE "workspace_control"."knowledge_code_index_activation_fragment" (
	"organization_id" text NOT NULL,
	"job_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"batch_index" integer NOT NULL,
	"start_path" text NOT NULL,
	"end_path" text NOT NULL,
	"file_count" integer NOT NULL,
	"parsed_files" integer NOT NULL,
	"skipped_files" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_code_index_activation_fragment_job_id_batch_index_pk" PRIMARY KEY("job_id","batch_index"),
	CONSTRAINT "knowledge_code_index_activation_fragment_batch" CHECK ("workspace_control"."knowledge_code_index_activation_fragment"."batch_index" >= 0
        AND "workspace_control"."knowledge_code_index_activation_fragment"."file_count" BETWEEN 1 AND 64
        AND "workspace_control"."knowledge_code_index_activation_fragment"."parsed_files" >= 0
        AND "workspace_control"."knowledge_code_index_activation_fragment"."skipped_files" >= 0
        AND "workspace_control"."knowledge_code_index_activation_fragment"."parsed_files" + "workspace_control"."knowledge_code_index_activation_fragment"."skipped_files" = "workspace_control"."knowledge_code_index_activation_fragment"."file_count"),
	CONSTRAINT "knowledge_code_index_activation_fragment_paths" CHECK (char_length("workspace_control"."knowledge_code_index_activation_fragment"."start_path") BETWEEN 1 AND 4096
        AND char_length("workspace_control"."knowledge_code_index_activation_fragment"."end_path") BETWEEN 1 AND 4096)
);
--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_source_sync_job" ADD COLUMN "manifest" jsonb;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_source_sync_job" ADD COLUMN "source_revision_sha256" text;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_source_sync_job" ADD COLUMN "activation_graph_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_source_sync_job" ADD COLUMN "activation_parent_graph_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_source_sync_job" ADD COLUMN "activation_generated_at" timestamp with time zone;--> statement-breakpoint
-- Pre-migration jobs have no immutable manifest checkpoint. Supersede them and
-- remove partial file rows so reconciliation can enqueue an exact revision.
WITH superseded AS MATERIALIZED (
	UPDATE "workspace_control"."knowledge_source_sync_job" job
	SET "state" = 'superseded', "claimed_at" = NULL, "lease_expires_at" = NULL,
		"worker_id" = NULL, "failure_code" = 'durable_manifest_required',
		"finished_at" = now(), "updated_at" = now()
	WHERE job."state" IN ('queued', 'claimed')
	RETURNING job."id"
)
DELETE FROM "workspace_control"."knowledge_code_index_file" file
USING superseded
WHERE file."job_id" = superseded."id";--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_source_sync_job_org_id_source_idx" ON "workspace_control"."knowledge_source_sync_job" USING btree ("organization_id","id","source_id");--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_code_index_activation_entity" ADD CONSTRAINT "knowledge_code_index_activation_entity_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "workspace_control"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_code_index_activation_entity" ADD CONSTRAINT "knowledge_code_index_activation_entity_job_id_knowledge_source_sync_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "workspace_control"."knowledge_source_sync_job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_code_index_activation_entity" ADD CONSTRAINT "knowledge_code_index_activation_entity_source_id_knowledge_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "workspace_control"."knowledge_source"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_code_index_activation_entity" ADD CONSTRAINT "knowledge_code_index_activation_entity_org_job_fk" FOREIGN KEY ("organization_id","job_id") REFERENCES "workspace_control"."knowledge_source_sync_job"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_code_index_activation_entity" ADD CONSTRAINT "knowledge_code_index_activation_entity_org_source_fk" FOREIGN KEY ("organization_id","source_id") REFERENCES "workspace_control"."knowledge_source"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_code_index_activation_entity" ADD CONSTRAINT "knowledge_code_index_activation_entity_exact_job_fk" FOREIGN KEY ("organization_id","job_id","source_id") REFERENCES "workspace_control"."knowledge_source_sync_job"("organization_id","id","source_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_code_index_activation_fragment" ADD CONSTRAINT "knowledge_code_index_activation_fragment_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "workspace_control"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_code_index_activation_fragment" ADD CONSTRAINT "knowledge_code_index_activation_fragment_job_id_knowledge_source_sync_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "workspace_control"."knowledge_source_sync_job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_code_index_activation_fragment" ADD CONSTRAINT "knowledge_code_index_activation_fragment_source_id_knowledge_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "workspace_control"."knowledge_source"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_code_index_activation_fragment" ADD CONSTRAINT "knowledge_code_index_activation_fragment_org_job_fk" FOREIGN KEY ("organization_id","job_id") REFERENCES "workspace_control"."knowledge_source_sync_job"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_code_index_activation_fragment" ADD CONSTRAINT "knowledge_code_index_activation_fragment_org_source_fk" FOREIGN KEY ("organization_id","source_id") REFERENCES "workspace_control"."knowledge_source"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_code_index_activation_fragment" ADD CONSTRAINT "knowledge_code_index_activation_fragment_exact_job_fk" FOREIGN KEY ("organization_id","job_id","source_id") REFERENCES "workspace_control"."knowledge_source_sync_job"("organization_id","id","source_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_code_index_activation_entity_job_idx" ON "workspace_control"."knowledge_code_index_activation_entity" USING btree ("organization_id","job_id","entity_kind","entity_id");--> statement-breakpoint
CREATE INDEX "knowledge_code_index_activation_fragment_job_idx" ON "workspace_control"."knowledge_code_index_activation_fragment" USING btree ("organization_id","job_id","batch_index");--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_code_index_file" ADD CONSTRAINT "knowledge_code_index_file_exact_job_fk" FOREIGN KEY ("organization_id","job_id","source_id") REFERENCES "workspace_control"."knowledge_source_sync_job"("organization_id","id","source_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_source_sync_job" ADD CONSTRAINT "knowledge_source_sync_job_manifest" CHECK ("workspace_control"."knowledge_source_sync_job"."manifest" IS NULL OR jsonb_typeof("workspace_control"."knowledge_source_sync_job"."manifest") = 'array');--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_source_sync_job" ADD CONSTRAINT "knowledge_source_sync_job_source_revision" CHECK ("workspace_control"."knowledge_source_sync_job"."source_revision_sha256" IS NULL
        OR "workspace_control"."knowledge_source_sync_job"."source_revision_sha256" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_source_sync_job" ADD CONSTRAINT "knowledge_source_sync_job_activation_identity" CHECK (("workspace_control"."knowledge_source_sync_job"."activation_graph_revision_id" IS NOT NULL
          AND "workspace_control"."knowledge_source_sync_job"."activation_generated_at" IS NOT NULL)
        OR ("workspace_control"."knowledge_source_sync_job"."activation_graph_revision_id" IS NULL
          AND "workspace_control"."knowledge_source_sync_job"."activation_parent_graph_revision_id" IS NULL
          AND "workspace_control"."knowledge_source_sync_job"."activation_generated_at" IS NULL));--> statement-breakpoint
-- Cross-runtime canonical JSON contract used for immutable graph hashes.
CREATE OR REPLACE FUNCTION "workspace_control"."knowledge_canonical_json"(value jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
DECLARE
	result text;
BEGIN
	CASE jsonb_typeof(value)
		WHEN 'object' THEN
			SELECT '{' || COALESCE(string_agg(
				to_jsonb(entry.key)::text || ':' || "workspace_control"."knowledge_canonical_json"(entry.item),
				',' ORDER BY convert_to(entry.key, 'UTF8')
			), '') || '}'
			INTO result
			FROM jsonb_each(value) AS entry(key, item);
		WHEN 'array' THEN
			SELECT '[' || COALESCE(string_agg(
				"workspace_control"."knowledge_canonical_json"(entry.item),
				',' ORDER BY entry.ordinality
			), '') || ']'
			INTO result
			FROM jsonb_array_elements(value) WITH ORDINALITY AS entry(item, ordinality);
		ELSE
			result := value::text;
	END CASE;
	RETURN result;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "workspace_control"."knowledge_canonical_json"(jsonb) FROM PUBLIC;
