CREATE TABLE "workspace_control"."workspace_analysis_article" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"project_environment_id" uuid NOT NULL,
	"environment_revision" bigint NOT NULL,
	"source_knowledge_grant_id" uuid,
	"definition" jsonb NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"owner_member_id" text NOT NULL,
	"updated_by_member_id" text NOT NULL,
	"revision" bigint DEFAULT 1 NOT NULL,
	"latest_successful_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "workspace_analysis_article_revisions" CHECK ("workspace_control"."workspace_analysis_article"."environment_revision" >= 1
        AND "workspace_control"."workspace_analysis_article"."revision" >= 1
        AND "workspace_control"."workspace_analysis_article"."revision" <= 9007199254740991),
	CONSTRAINT "workspace_analysis_article_state" CHECK ("workspace_control"."workspace_analysis_article"."state" IN ('draft', 'review', 'live', 'archived')),
	CONSTRAINT "workspace_analysis_article_definition" CHECK (jsonb_typeof("workspace_control"."workspace_analysis_article"."definition") = 'object')
);
--> statement-breakpoint
CREATE TABLE "workspace_control"."workspace_analysis_article_connection" (
	"organization_id" text NOT NULL,
	"article_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"connection_revision" bigint NOT NULL,
	"role" text NOT NULL,
	"alias" text NOT NULL,
	CONSTRAINT "workspace_analysis_article_connection_article_id_connection_id_pk" PRIMARY KEY("article_id","connection_id"),
	CONSTRAINT "workspace_analysis_article_connection_revision" CHECK ("workspace_control"."workspace_analysis_article_connection"."connection_revision" >= 1),
	CONSTRAINT "workspace_analysis_article_connection_text" CHECK ("workspace_control"."workspace_analysis_article_connection"."role" ~ '^[A-Za-z][A-Za-z0-9_-]{0,63}$'
        AND char_length("workspace_control"."workspace_analysis_article_connection"."alias") BETWEEN 1 AND 128)
);
--> statement-breakpoint
CREATE TABLE "workspace_control"."workspace_analysis_article_graph" (
	"organization_id" text NOT NULL,
	"article_id" uuid NOT NULL,
	"graph_revision_id" uuid NOT NULL,
	CONSTRAINT "workspace_analysis_article_graph_article_id_graph_revision_id_pk" PRIMARY KEY("article_id","graph_revision_id")
);
--> statement-breakpoint
CREATE TABLE "workspace_control"."workspace_analysis_article_query_receipt" (
	"organization_id" text NOT NULL,
	"run_id" uuid NOT NULL,
	"query_node_id" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"connection_revision" bigint NOT NULL,
	"query_run_id" uuid NOT NULL,
	"query_hash" text NOT NULL,
	"schema_fingerprint" text NOT NULL,
	"state" text NOT NULL,
	"row_count" bigint NOT NULL,
	"byte_count" bigint NOT NULL,
	"duration_ms" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_analysis_article_query_receipt_run_id_query_node_id_pk" PRIMARY KEY("run_id","query_node_id"),
	CONSTRAINT "workspace_analysis_query_receipt_node" CHECK ("workspace_control"."workspace_analysis_article_query_receipt"."query_node_id" ~ '^[A-Za-z][A-Za-z0-9_-]{0,63}$'),
	CONSTRAINT "workspace_analysis_query_receipt_hashes" CHECK ("workspace_control"."workspace_analysis_article_query_receipt"."query_hash" ~ '^[0-9a-f]{64}$'
        AND "workspace_control"."workspace_analysis_article_query_receipt"."schema_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "workspace_analysis_query_receipt_state" CHECK ("workspace_control"."workspace_analysis_article_query_receipt"."state" IN ('succeeded', 'failed', 'cancelled', 'stale')),
	CONSTRAINT "workspace_analysis_query_receipt_numbers" CHECK ("workspace_control"."workspace_analysis_article_query_receipt"."connection_revision" >= 1 AND "workspace_control"."workspace_analysis_article_query_receipt"."row_count" >= 0
        AND "workspace_control"."workspace_analysis_article_query_receipt"."byte_count" >= 0 AND "workspace_control"."workspace_analysis_article_query_receipt"."duration_ms" >= 0)
);
--> statement-breakpoint
CREATE TABLE "workspace_control"."workspace_analysis_article_revision" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"article_id" uuid NOT NULL,
	"revision" bigint NOT NULL,
	"base_revision" bigint,
	"operation" text NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"created_by_user_id" text,
	"created_by_member_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_analysis_article_revision_numbers" CHECK ("workspace_control"."workspace_analysis_article_revision"."revision" >= 1
        AND "workspace_control"."workspace_analysis_article_revision"."revision" <= 9007199254740991
        AND ("workspace_control"."workspace_analysis_article_revision"."base_revision" IS NULL OR "workspace_control"."workspace_analysis_article_revision"."base_revision" >= 0)),
	CONSTRAINT "workspace_analysis_article_revision_operation" CHECK ("workspace_control"."workspace_analysis_article_revision"."operation" IN (
        'create', 'propose', 'update', 'submit_review', 'return_draft',
        'publish_live', 'archive', 'restore', 'transfer', 'delete', 'migrate'
      )),
	CONSTRAINT "workspace_analysis_article_revision_payload" CHECK (jsonb_typeof("workspace_control"."workspace_analysis_article_revision"."payload") = 'object'
        AND "workspace_control"."workspace_analysis_article_revision"."payload_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "workspace_control"."workspace_analysis_article_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"article_id" uuid NOT NULL,
	"article_revision" bigint NOT NULL,
	"runner_id" uuid NOT NULL,
	"lease_id" uuid,
	"requested_by_member_id" text,
	"trigger" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"parameter_values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"parameter_hash" text NOT NULL,
	"definition_hash" text NOT NULL,
	"schema_fingerprints" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"row_count" bigint DEFAULT 0 NOT NULL,
	"byte_count" bigint DEFAULT 0 NOT NULL,
	"result_hash" text,
	"error_kind" text,
	"error_message" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_analysis_article_run_state" CHECK ("workspace_control"."workspace_analysis_article_run"."state" IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'stale')),
	CONSTRAINT "workspace_analysis_article_run_trigger" CHECK ("workspace_control"."workspace_analysis_article_run"."trigger" IN ('manual', 'schedule', 'signal', 'publication')),
	CONSTRAINT "workspace_analysis_article_run_hashes" CHECK ("workspace_control"."workspace_analysis_article_run"."parameter_hash" ~ '^[0-9a-f]{64}$'
        AND "workspace_control"."workspace_analysis_article_run"."definition_hash" ~ '^[0-9a-f]{64}$'
        AND ("workspace_control"."workspace_analysis_article_run"."result_hash" IS NULL OR "workspace_control"."workspace_analysis_article_run"."result_hash" ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "workspace_analysis_article_run_numbers" CHECK ("workspace_control"."workspace_analysis_article_run"."article_revision" >= 1 AND "workspace_control"."workspace_analysis_article_run"."row_count" >= 0 AND "workspace_control"."workspace_analysis_article_run"."byte_count" >= 0),
	CONSTRAINT "workspace_analysis_article_run_json" CHECK (jsonb_typeof("workspace_control"."workspace_analysis_article_run"."parameter_values") = 'object'
        AND jsonb_typeof("workspace_control"."workspace_analysis_article_run"."schema_fingerprints") = 'object'),
	CONSTRAINT "workspace_analysis_article_run_terminal" CHECK (("workspace_control"."workspace_analysis_article_run"."state" IN ('queued', 'running') AND "workspace_control"."workspace_analysis_article_run"."finished_at" IS NULL)
        OR ("workspace_control"."workspace_analysis_article_run"."state" IN ('succeeded', 'failed', 'cancelled', 'stale')
          AND "workspace_control"."workspace_analysis_article_run"."finished_at" IS NOT NULL)),
	CONSTRAINT "workspace_analysis_article_run_error" CHECK (("workspace_control"."workspace_analysis_article_run"."error_kind" IS NULL AND "workspace_control"."workspace_analysis_article_run"."error_message" IS NULL)
        OR ("workspace_control"."workspace_analysis_article_run"."error_kind" IS NOT NULL AND "workspace_control"."workspace_analysis_article_run"."error_message" IS NOT NULL
          AND char_length("workspace_control"."workspace_analysis_article_run"."error_kind") BETWEEN 1 AND 128
          AND char_length("workspace_control"."workspace_analysis_article_run"."error_message") BETWEEN 1 AND 2000))
);
--> statement-breakpoint
CREATE TABLE "workspace_control"."workspace_analysis_publication" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"article_id" uuid NOT NULL,
	"article_revision" bigint NOT NULL,
	"source_run_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"visibility" text DEFAULT 'unlisted' NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"snapshot" jsonb NOT NULL,
	"snapshot_hash" text NOT NULL,
	"approved_by_member_id" text NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "workspace_analysis_publication_slug" CHECK ("workspace_control"."workspace_analysis_publication"."slug" ~ '^[a-z0-9][a-z0-9-]{7,127}$'),
	CONSTRAINT "workspace_analysis_publication_visibility" CHECK ("workspace_control"."workspace_analysis_publication"."visibility" IN ('unlisted', 'public')),
	CONSTRAINT "workspace_analysis_publication_snapshot" CHECK (jsonb_typeof("workspace_control"."workspace_analysis_publication"."snapshot") = 'object'
        AND "workspace_control"."workspace_analysis_publication"."snapshot_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "workspace_analysis_publication_text" CHECK (char_length(btrim("workspace_control"."workspace_analysis_publication"."title")) BETWEEN 1 AND 160
        AND char_length("workspace_control"."workspace_analysis_publication"."description") <= 2000)
);
--> statement-breakpoint
CREATE TABLE "workspace_control"."workspace_analysis_refresh_lease" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"article_id" uuid NOT NULL,
	"article_revision" bigint NOT NULL,
	"runner_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"parameter_hash" text NOT NULL,
	"lease_capability_hash" text NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_analysis_refresh_lease_hashes" CHECK ("workspace_control"."workspace_analysis_refresh_lease"."parameter_hash" ~ '^[0-9a-f]{64}$'
        AND "workspace_control"."workspace_analysis_refresh_lease"."lease_capability_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "workspace_analysis_refresh_lease_time" CHECK ("workspace_control"."workspace_analysis_refresh_lease"."article_revision" >= 1 AND "workspace_control"."workspace_analysis_refresh_lease"."expires_at" > "workspace_control"."workspace_analysis_refresh_lease"."scheduled_at")
);
--> statement-breakpoint
CREATE TABLE "workspace_control"."workspace_analysis_result_fragment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"run_id" uuid NOT NULL,
	"block_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"data_key_id" uuid NOT NULL,
	"key_reference" text NOT NULL,
	"key_version" text NOT NULL,
	"ciphertext" text NOT NULL,
	"payload_hash" text NOT NULL,
	"row_count" integer NOT NULL,
	"plaintext_bytes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_analysis_result_fragment_block" CHECK ("workspace_control"."workspace_analysis_result_fragment"."block_id" ~ '^[A-Za-z][A-Za-z0-9_-]{0,63}$'),
	CONSTRAINT "workspace_analysis_result_fragment_hash" CHECK ("workspace_control"."workspace_analysis_result_fragment"."payload_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "workspace_analysis_result_fragment_bounds" CHECK ("workspace_control"."workspace_analysis_result_fragment"."ordinal" BETWEEN 0 AND 255
        AND "workspace_control"."workspace_analysis_result_fragment"."row_count" BETWEEN 0 AND 5000
        AND "workspace_control"."workspace_analysis_result_fragment"."plaintext_bytes" BETWEEN 2 AND 1048576),
	CONSTRAINT "workspace_analysis_result_fragment_key" CHECK ("workspace_control"."workspace_analysis_result_fragment"."key_reference" = 'workspace-data-key'
        AND "workspace_control"."workspace_analysis_result_fragment"."key_version" ~ '^v[1-9][0-9]*$')
);
--> statement-breakpoint
CREATE TABLE "workspace_control"."workspace_analysis_runner" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"member_id" text NOT NULL,
	"device_id" text NOT NULL,
	"display_name" text NOT NULL,
	"background_allowed" boolean DEFAULT false NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "workspace_analysis_runner_text" CHECK (char_length("workspace_control"."workspace_analysis_runner"."device_id") BETWEEN 1 AND 256
        AND char_length("workspace_control"."workspace_analysis_runner"."display_name") BETWEEN 1 AND 256)
);
--> statement-breakpoint
CREATE TABLE "workspace_control"."workspace_analysis_signal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"article_id" uuid NOT NULL,
	"article_revision" bigint NOT NULL,
	"block_id" text NOT NULL,
	"definition" jsonb NOT NULL,
	"owner_member_id" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"revision" bigint DEFAULT 1 NOT NULL,
	"last_evaluated_run_id" uuid,
	"last_observed_state" text DEFAULT 'unknown' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "workspace_analysis_signal_block" CHECK ("workspace_control"."workspace_analysis_signal"."block_id" ~ '^[A-Za-z][A-Za-z0-9_-]{0,63}$'),
	CONSTRAINT "workspace_analysis_signal_definition" CHECK (jsonb_typeof("workspace_control"."workspace_analysis_signal"."definition") = 'object'),
	CONSTRAINT "workspace_analysis_signal_state" CHECK ("workspace_control"."workspace_analysis_signal"."last_observed_state" IN ('unknown', 'normal', 'firing', 'recovered', 'no_data', 'error', 'stale')),
	CONSTRAINT "workspace_analysis_signal_revision" CHECK ("workspace_control"."workspace_analysis_signal"."article_revision" >= 1 AND "workspace_control"."workspace_analysis_signal"."revision" >= 1)
);
--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_article" ADD CONSTRAINT "workspace_analysis_article_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "workspace_control"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_article" ADD CONSTRAINT "workspace_analysis_article_org_environment_fk" FOREIGN KEY ("organization_id","project_environment_id") REFERENCES "workspace_control"."knowledge_project_environment"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_article" ADD CONSTRAINT "workspace_analysis_article_org_grant_fk" FOREIGN KEY ("organization_id","source_knowledge_grant_id") REFERENCES "workspace_control"."knowledge_grant"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_article_connection" ADD CONSTRAINT "workspace_analysis_article_connection_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "workspace_control"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_article_connection" ADD CONSTRAINT "workspace_analysis_article_connection_org_article_fk" FOREIGN KEY ("organization_id","article_id") REFERENCES "workspace_control"."workspace_analysis_article"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_article_connection" ADD CONSTRAINT "workspace_analysis_article_connection_org_connection_fk" FOREIGN KEY ("organization_id","connection_id") REFERENCES "workspace_control"."workspace_connection"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_article_graph" ADD CONSTRAINT "workspace_analysis_article_graph_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "workspace_control"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_article_graph" ADD CONSTRAINT "workspace_analysis_article_graph_org_article_fk" FOREIGN KEY ("organization_id","article_id") REFERENCES "workspace_control"."workspace_analysis_article"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_article_graph" ADD CONSTRAINT "workspace_analysis_article_graph_org_graph_fk" FOREIGN KEY ("organization_id","graph_revision_id") REFERENCES "workspace_control"."knowledge_graph_revision"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_article_query_receipt" ADD CONSTRAINT "workspace_analysis_article_query_receipt_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "workspace_control"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_article_query_receipt" ADD CONSTRAINT "workspace_analysis_query_receipt_org_run_fk" FOREIGN KEY ("organization_id","run_id") REFERENCES "workspace_control"."workspace_analysis_article_run"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_article_query_receipt" ADD CONSTRAINT "workspace_analysis_query_receipt_org_connection_fk" FOREIGN KEY ("organization_id","connection_id") REFERENCES "workspace_control"."workspace_connection"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_article_revision" ADD CONSTRAINT "workspace_analysis_article_revision_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "workspace_control"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_article_revision" ADD CONSTRAINT "workspace_analysis_article_revision_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "workspace_control"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_article_revision" ADD CONSTRAINT "workspace_analysis_article_revision_org_article_fk" FOREIGN KEY ("organization_id","article_id") REFERENCES "workspace_control"."workspace_analysis_article"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_article_run" ADD CONSTRAINT "workspace_analysis_article_run_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "workspace_control"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_article_run" ADD CONSTRAINT "workspace_analysis_article_run_org_revision_fk" FOREIGN KEY ("organization_id","article_id","article_revision") REFERENCES "workspace_control"."workspace_analysis_article_revision"("organization_id","article_id","revision") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_article_run" ADD CONSTRAINT "workspace_analysis_article_run_org_runner_fk" FOREIGN KEY ("organization_id","runner_id") REFERENCES "workspace_control"."workspace_analysis_runner"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_article_run" ADD CONSTRAINT "workspace_analysis_article_run_org_lease_fk" FOREIGN KEY ("organization_id","lease_id") REFERENCES "workspace_control"."workspace_analysis_refresh_lease"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_article_run" ADD CONSTRAINT "workspace_analysis_article_run_org_requester_fk" FOREIGN KEY ("organization_id","requested_by_member_id") REFERENCES "workspace_control"."member"("organization_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_publication" ADD CONSTRAINT "workspace_analysis_publication_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "workspace_control"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_publication" ADD CONSTRAINT "workspace_analysis_publication_org_revision_fk" FOREIGN KEY ("organization_id","article_id","article_revision") REFERENCES "workspace_control"."workspace_analysis_article_revision"("organization_id","article_id","revision") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_publication" ADD CONSTRAINT "workspace_analysis_publication_org_run_fk" FOREIGN KEY ("organization_id","source_run_id") REFERENCES "workspace_control"."workspace_analysis_article_run"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_publication" ADD CONSTRAINT "workspace_analysis_publication_org_approver_fk" FOREIGN KEY ("organization_id","approved_by_member_id") REFERENCES "workspace_control"."member"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_refresh_lease" ADD CONSTRAINT "workspace_analysis_refresh_lease_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "workspace_control"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_refresh_lease" ADD CONSTRAINT "workspace_analysis_refresh_lease_org_revision_fk" FOREIGN KEY ("organization_id","article_id","article_revision") REFERENCES "workspace_control"."workspace_analysis_article_revision"("organization_id","article_id","revision") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_refresh_lease" ADD CONSTRAINT "workspace_analysis_refresh_lease_org_runner_fk" FOREIGN KEY ("organization_id","runner_id") REFERENCES "workspace_control"."workspace_analysis_runner"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_result_fragment" ADD CONSTRAINT "workspace_analysis_result_fragment_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "workspace_control"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_result_fragment" ADD CONSTRAINT "workspace_analysis_result_fragment_org_run_fk" FOREIGN KEY ("organization_id","run_id") REFERENCES "workspace_control"."workspace_analysis_article_run"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_result_fragment" ADD CONSTRAINT "workspace_analysis_result_fragment_org_data_key_fk" FOREIGN KEY ("organization_id","data_key_id") REFERENCES "workspace_control"."workspace_data_key"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_runner" ADD CONSTRAINT "workspace_analysis_runner_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "workspace_control"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_runner" ADD CONSTRAINT "workspace_analysis_runner_org_member_fk" FOREIGN KEY ("organization_id","member_id") REFERENCES "workspace_control"."member"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_signal" ADD CONSTRAINT "workspace_analysis_signal_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "workspace_control"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_signal" ADD CONSTRAINT "workspace_analysis_signal_org_revision_fk" FOREIGN KEY ("organization_id","article_id","article_revision") REFERENCES "workspace_control"."workspace_analysis_article_revision"("organization_id","article_id","revision") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_signal" ADD CONSTRAINT "workspace_analysis_signal_org_owner_fk" FOREIGN KEY ("organization_id","owner_member_id") REFERENCES "workspace_control"."member"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_signal" ADD CONSTRAINT "workspace_analysis_signal_org_run_fk" FOREIGN KEY ("organization_id","last_evaluated_run_id") REFERENCES "workspace_control"."workspace_analysis_article_run"("organization_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_analysis_article_org_id_idx" ON "workspace_control"."workspace_analysis_article" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "workspace_analysis_article_environment_idx" ON "workspace_control"."workspace_analysis_article" USING btree ("organization_id","project_environment_id","state","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_analysis_article_connection_role_idx" ON "workspace_control"."workspace_analysis_article_connection" USING btree ("article_id","role");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_analysis_query_receipt_run_query_idx" ON "workspace_control"."workspace_analysis_article_query_receipt" USING btree ("organization_id","run_id","query_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_analysis_article_revision_unique_idx" ON "workspace_control"."workspace_analysis_article_revision" USING btree ("organization_id","article_id","revision");--> statement-breakpoint
CREATE INDEX "workspace_analysis_article_revision_history_idx" ON "workspace_control"."workspace_analysis_article_revision" USING btree ("organization_id","article_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_analysis_article_run_org_id_idx" ON "workspace_control"."workspace_analysis_article_run" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "workspace_analysis_article_run_article_idx" ON "workspace_control"."workspace_analysis_article_run" USING btree ("organization_id","article_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_analysis_publication_org_id_idx" ON "workspace_control"."workspace_analysis_publication" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_analysis_publication_slug_idx" ON "workspace_control"."workspace_analysis_publication" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "workspace_analysis_publication_article_idx" ON "workspace_control"."workspace_analysis_publication" USING btree ("organization_id","article_id","published_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_analysis_refresh_lease_org_id_idx" ON "workspace_control"."workspace_analysis_refresh_lease" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_analysis_refresh_lease_idempotency_idx" ON "workspace_control"."workspace_analysis_refresh_lease" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "workspace_analysis_refresh_lease_due_idx" ON "workspace_control"."workspace_analysis_refresh_lease" USING btree ("organization_id","runner_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_analysis_result_fragment_unique_idx" ON "workspace_control"."workspace_analysis_result_fragment" USING btree ("organization_id","run_id","block_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_analysis_runner_org_id_idx" ON "workspace_control"."workspace_analysis_runner" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_analysis_runner_org_device_idx" ON "workspace_control"."workspace_analysis_runner" USING btree ("organization_id","device_id");--> statement-breakpoint
CREATE INDEX "workspace_analysis_runner_member_idx" ON "workspace_control"."workspace_analysis_runner" USING btree ("organization_id","member_id","revoked_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_analysis_signal_org_id_idx" ON "workspace_control"."workspace_analysis_signal" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "workspace_analysis_signal_article_idx" ON "workspace_control"."workspace_analysis_signal" USING btree ("organization_id","article_id","enabled");