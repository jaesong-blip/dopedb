CREATE TABLE "workspace_control"."knowledge_environment_head" (
	"organization_id" text NOT NULL,
	"project_environment_id" uuid PRIMARY KEY NOT NULL,
	"graph_revision_id" uuid NOT NULL,
	"environment_revision" bigint NOT NULL,
	"activated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_environment_head_graph_revision_id_unique" UNIQUE("graph_revision_id"),
	CONSTRAINT "knowledge_environment_head_revision_positive" CHECK ("workspace_control"."knowledge_environment_head"."environment_revision" >= 1)
);
--> statement-breakpoint
CREATE TABLE "workspace_control"."knowledge_github_installation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"installation_id" bigint NOT NULL,
	"account_id" text NOT NULL,
	"account_login" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_github_installation_id_positive" CHECK ("workspace_control"."knowledge_github_installation"."installation_id" >= 1),
	CONSTRAINT "knowledge_github_installation_status" CHECK ("workspace_control"."knowledge_github_installation"."status" IN ('active', 'suspended', 'revoked')),
	CONSTRAINT "knowledge_github_installation_account_length" CHECK (char_length("workspace_control"."knowledge_github_installation"."account_id") BETWEEN 1 AND 128
        AND char_length("workspace_control"."knowledge_github_installation"."account_login") BETWEEN 1 AND 255)
);
--> statement-breakpoint
CREATE TABLE "workspace_control"."knowledge_github_setup_state" (
	"state_hash" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_control"."knowledge_grant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"member_id" text NOT NULL,
	"project_id" uuid NOT NULL,
	"project_environment_id" uuid NOT NULL,
	"environment_revision" bigint NOT NULL,
	"graph_revision_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_grant_environment_revision_positive" CHECK ("workspace_control"."knowledge_grant"."environment_revision" >= 1)
);
--> statement-breakpoint
CREATE TABLE "workspace_control"."knowledge_graph_revision" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"source_id" uuid NOT NULL,
	"project_environment_id" uuid NOT NULL,
	"environment_revision" bigint NOT NULL,
	"parent_graph_revision_id" uuid,
	"source_revision_sha256" text NOT NULL,
	"artifact_sha256" text NOT NULL,
	"artifact" jsonb NOT NULL,
	"generated_at" timestamp with time zone NOT NULL,
	"staged_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_graph_revision_environment_positive" CHECK ("workspace_control"."knowledge_graph_revision"."environment_revision" >= 1),
	CONSTRAINT "knowledge_graph_revision_hashes" CHECK ("workspace_control"."knowledge_graph_revision"."source_revision_sha256" ~ '^[0-9a-f]{64}$'
        AND "workspace_control"."knowledge_graph_revision"."artifact_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "knowledge_graph_revision_artifact_object" CHECK (jsonb_typeof("workspace_control"."knowledge_graph_revision"."artifact") = 'object')
);
--> statement-breakpoint
CREATE TABLE "workspace_control"."knowledge_mapping_proposal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"project_environment_id" uuid NOT NULL,
	"graph_revision_id" uuid NOT NULL,
	"schema_fingerprint" text NOT NULL,
	"from_node_id" text NOT NULL,
	"target_kind" text NOT NULL,
	"target_identity" text NOT NULL,
	"state" text DEFAULT 'proposed' NOT NULL,
	"proposed_by_member_id" text,
	"decided_by_member_id" text,
	"proposed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "knowledge_mapping_hashes" CHECK ("workspace_control"."knowledge_mapping_proposal"."schema_fingerprint" ~ '^[0-9a-f]{64}$'
        AND "workspace_control"."knowledge_mapping_proposal"."from_node_id" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "knowledge_mapping_state" CHECK ("workspace_control"."knowledge_mapping_proposal"."state" IN ('proposed', 'approved', 'rejected', 'stale')),
	CONSTRAINT "knowledge_mapping_target_length" CHECK (char_length("workspace_control"."knowledge_mapping_proposal"."target_kind") BETWEEN 1 AND 128
        AND char_length("workspace_control"."knowledge_mapping_proposal"."target_identity") BETWEEN 1 AND 2048)
);
--> statement-breakpoint
CREATE TABLE "workspace_control"."knowledge_project" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"revision" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_project_name_length" CHECK (char_length("workspace_control"."knowledge_project"."name") BETWEEN 1 AND 512),
	CONSTRAINT "knowledge_project_revision_positive" CHECK ("workspace_control"."knowledge_project"."revision" >= 1)
);
--> statement-breakpoint
CREATE TABLE "workspace_control"."knowledge_project_environment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"production" boolean DEFAULT false NOT NULL,
	"revision" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_environment_name_length" CHECK (char_length("workspace_control"."knowledge_project_environment"."name") BETWEEN 1 AND 512),
	CONSTRAINT "knowledge_environment_revision_positive" CHECK ("workspace_control"."knowledge_project_environment"."revision" >= 1)
);
--> statement-breakpoint
CREATE TABLE "workspace_control"."knowledge_source" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" uuid NOT NULL,
	"project_environment_id" uuid NOT NULL,
	"environment_revision" bigint NOT NULL,
	"provider" text NOT NULL,
	"display_name" text NOT NULL,
	"visibility" text NOT NULL,
	"github_installation_id" uuid,
	"repository_id" text,
	"repository_full_name" text,
	"ref_name" text,
	"commit_sha" text,
	"root_fingerprint" text,
	"snapshot_sha256" text,
	"sync_state" text DEFAULT 'pending' NOT NULL,
	"sync_revision" bigint DEFAULT 1 NOT NULL,
	"last_failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "knowledge_source_provider" CHECK ("workspace_control"."knowledge_source"."provider" IN ('github', 'local_folder')),
	CONSTRAINT "knowledge_source_visibility" CHECK ("workspace_control"."knowledge_source"."visibility" IN ('local_only', 'shared_graph')),
	CONSTRAINT "knowledge_source_name_length" CHECK (char_length("workspace_control"."knowledge_source"."display_name") BETWEEN 1 AND 512),
	CONSTRAINT "knowledge_source_environment_revision_positive" CHECK ("workspace_control"."knowledge_source"."environment_revision" >= 1),
	CONSTRAINT "knowledge_source_sync_revision_positive" CHECK ("workspace_control"."knowledge_source"."sync_revision" >= 1),
	CONSTRAINT "knowledge_source_sync_state" CHECK ("workspace_control"."knowledge_source"."sync_state" IN ('pending', 'syncing', 'ready', 'stale', 'failed', 'revoked')),
	CONSTRAINT "knowledge_source_provider_shape" CHECK ((
        "workspace_control"."knowledge_source"."provider" = 'github'
        AND "workspace_control"."knowledge_source"."github_installation_id" IS NOT NULL
        AND "workspace_control"."knowledge_source"."repository_id" IS NOT NULL
        AND "workspace_control"."knowledge_source"."repository_full_name" IS NOT NULL
        AND "workspace_control"."knowledge_source"."ref_name" IS NOT NULL
        AND "workspace_control"."knowledge_source"."commit_sha" ~ '^[0-9a-f]{40}$'
        AND "workspace_control"."knowledge_source"."root_fingerprint" IS NULL
        AND "workspace_control"."knowledge_source"."snapshot_sha256" IS NULL
      ) OR (
        "workspace_control"."knowledge_source"."provider" = 'local_folder'
        AND "workspace_control"."knowledge_source"."github_installation_id" IS NULL
        AND "workspace_control"."knowledge_source"."repository_id" IS NULL
        AND "workspace_control"."knowledge_source"."repository_full_name" IS NULL
        AND "workspace_control"."knowledge_source"."ref_name" IS NULL
        AND "workspace_control"."knowledge_source"."commit_sha" IS NULL
        AND "workspace_control"."knowledge_source"."root_fingerprint" ~ '^[0-9a-f]{64}$'
        AND "workspace_control"."knowledge_source"."snapshot_sha256" ~ '^[0-9a-f]{64}$'
      )),
	CONSTRAINT "knowledge_source_local_share_only" CHECK ("workspace_control"."knowledge_source"."provider" <> 'local_folder' OR "workspace_control"."knowledge_source"."visibility" = 'shared_graph')
);
--> statement-breakpoint
CREATE TABLE "workspace_control"."knowledge_source_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"source_id" uuid NOT NULL,
	"delivery_id" text NOT NULL,
	"event_kind" text NOT NULL,
	"before_commit_sha" text,
	"after_commit_sha" text,
	"changed_files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "knowledge_source_event_kind" CHECK ("workspace_control"."knowledge_source_event"."event_kind" IN ('push', 'installation', 'repository')),
	CONSTRAINT "knowledge_source_event_state" CHECK ("workspace_control"."knowledge_source_event"."state" IN ('pending', 'claimed', 'consumed', 'failed')),
	CONSTRAINT "knowledge_source_event_commits" CHECK (("workspace_control"."knowledge_source_event"."before_commit_sha" IS NULL OR "workspace_control"."knowledge_source_event"."before_commit_sha" ~ '^[0-9a-f]{40}$')
        AND ("workspace_control"."knowledge_source_event"."after_commit_sha" IS NULL OR "workspace_control"."knowledge_source_event"."after_commit_sha" ~ '^[0-9a-f]{40}$')),
	CONSTRAINT "knowledge_source_event_files_array" CHECK (jsonb_typeof("workspace_control"."knowledge_source_event"."changed_files") = 'array')
);
--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_environment_head" ADD CONSTRAINT "knowledge_environment_head_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "workspace_control"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_environment_head" ADD CONSTRAINT "knowledge_environment_head_project_environment_id_knowledge_project_environment_id_fk" FOREIGN KEY ("project_environment_id") REFERENCES "workspace_control"."knowledge_project_environment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_environment_head" ADD CONSTRAINT "knowledge_environment_head_graph_revision_id_knowledge_graph_revision_id_fk" FOREIGN KEY ("graph_revision_id") REFERENCES "workspace_control"."knowledge_graph_revision"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_environment_head" ADD CONSTRAINT "knowledge_environment_head_org_environment_fk" FOREIGN KEY ("organization_id","project_environment_id") REFERENCES "workspace_control"."knowledge_project_environment"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_environment_head" ADD CONSTRAINT "knowledge_environment_head_org_graph_fk" FOREIGN KEY ("organization_id","graph_revision_id") REFERENCES "workspace_control"."knowledge_graph_revision"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_github_installation" ADD CONSTRAINT "knowledge_github_installation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "workspace_control"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_github_installation" ADD CONSTRAINT "knowledge_github_installation_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "workspace_control"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_github_setup_state" ADD CONSTRAINT "knowledge_github_setup_state_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "workspace_control"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_github_setup_state" ADD CONSTRAINT "knowledge_github_setup_state_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "workspace_control"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_grant" ADD CONSTRAINT "knowledge_grant_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "workspace_control"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_grant" ADD CONSTRAINT "knowledge_grant_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "workspace_control"."member"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_grant" ADD CONSTRAINT "knowledge_grant_project_id_knowledge_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "workspace_control"."knowledge_project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_grant" ADD CONSTRAINT "knowledge_grant_project_environment_id_knowledge_project_environment_id_fk" FOREIGN KEY ("project_environment_id") REFERENCES "workspace_control"."knowledge_project_environment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_grant" ADD CONSTRAINT "knowledge_grant_graph_revision_id_knowledge_graph_revision_id_fk" FOREIGN KEY ("graph_revision_id") REFERENCES "workspace_control"."knowledge_graph_revision"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_grant" ADD CONSTRAINT "knowledge_grant_org_member_fk" FOREIGN KEY ("organization_id","member_id") REFERENCES "workspace_control"."member"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_grant" ADD CONSTRAINT "knowledge_grant_org_project_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "workspace_control"."knowledge_project"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_grant" ADD CONSTRAINT "knowledge_grant_org_environment_fk" FOREIGN KEY ("organization_id","project_environment_id") REFERENCES "workspace_control"."knowledge_project_environment"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_grant" ADD CONSTRAINT "knowledge_grant_org_graph_fk" FOREIGN KEY ("organization_id","graph_revision_id") REFERENCES "workspace_control"."knowledge_graph_revision"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_graph_revision" ADD CONSTRAINT "knowledge_graph_revision_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "workspace_control"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_graph_revision" ADD CONSTRAINT "knowledge_graph_revision_source_id_knowledge_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "workspace_control"."knowledge_source"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_graph_revision" ADD CONSTRAINT "knowledge_graph_revision_project_environment_id_knowledge_project_environment_id_fk" FOREIGN KEY ("project_environment_id") REFERENCES "workspace_control"."knowledge_project_environment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_graph_revision" ADD CONSTRAINT "knowledge_graph_revision_org_source_fk" FOREIGN KEY ("organization_id","source_id") REFERENCES "workspace_control"."knowledge_source"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_graph_revision" ADD CONSTRAINT "knowledge_graph_revision_org_environment_fk" FOREIGN KEY ("organization_id","project_environment_id") REFERENCES "workspace_control"."knowledge_project_environment"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_graph_revision" ADD CONSTRAINT "knowledge_graph_revision_org_parent_fk" FOREIGN KEY ("organization_id","parent_graph_revision_id") REFERENCES "workspace_control"."knowledge_graph_revision"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_mapping_proposal" ADD CONSTRAINT "knowledge_mapping_proposal_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "workspace_control"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_mapping_proposal" ADD CONSTRAINT "knowledge_mapping_proposal_project_environment_id_knowledge_project_environment_id_fk" FOREIGN KEY ("project_environment_id") REFERENCES "workspace_control"."knowledge_project_environment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_mapping_proposal" ADD CONSTRAINT "knowledge_mapping_proposal_graph_revision_id_knowledge_graph_revision_id_fk" FOREIGN KEY ("graph_revision_id") REFERENCES "workspace_control"."knowledge_graph_revision"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_mapping_proposal" ADD CONSTRAINT "knowledge_mapping_proposal_proposed_by_member_id_member_id_fk" FOREIGN KEY ("proposed_by_member_id") REFERENCES "workspace_control"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_mapping_proposal" ADD CONSTRAINT "knowledge_mapping_proposal_decided_by_member_id_member_id_fk" FOREIGN KEY ("decided_by_member_id") REFERENCES "workspace_control"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_project" ADD CONSTRAINT "knowledge_project_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "workspace_control"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_project_environment" ADD CONSTRAINT "knowledge_project_environment_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "workspace_control"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_project_environment" ADD CONSTRAINT "knowledge_project_environment_project_id_knowledge_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "workspace_control"."knowledge_project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_project_environment" ADD CONSTRAINT "knowledge_environment_org_project_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "workspace_control"."knowledge_project"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_source" ADD CONSTRAINT "knowledge_source_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "workspace_control"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_source" ADD CONSTRAINT "knowledge_source_project_id_knowledge_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "workspace_control"."knowledge_project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_source" ADD CONSTRAINT "knowledge_source_project_environment_id_knowledge_project_environment_id_fk" FOREIGN KEY ("project_environment_id") REFERENCES "workspace_control"."knowledge_project_environment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_source" ADD CONSTRAINT "knowledge_source_github_installation_id_knowledge_github_installation_id_fk" FOREIGN KEY ("github_installation_id") REFERENCES "workspace_control"."knowledge_github_installation"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_source" ADD CONSTRAINT "knowledge_source_org_project_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "workspace_control"."knowledge_project"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_source" ADD CONSTRAINT "knowledge_source_org_environment_fk" FOREIGN KEY ("organization_id","project_environment_id") REFERENCES "workspace_control"."knowledge_project_environment"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_source" ADD CONSTRAINT "knowledge_source_org_github_installation_fk" FOREIGN KEY ("organization_id","github_installation_id") REFERENCES "workspace_control"."knowledge_github_installation"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_source_event" ADD CONSTRAINT "knowledge_source_event_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "workspace_control"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_source_event" ADD CONSTRAINT "knowledge_source_event_source_id_knowledge_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "workspace_control"."knowledge_source"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_source_event" ADD CONSTRAINT "knowledge_source_event_org_source_fk" FOREIGN KEY ("organization_id","source_id") REFERENCES "workspace_control"."knowledge_source"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_github_installation_org_id_idx" ON "workspace_control"."knowledge_github_installation" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_github_installation_org_external_idx" ON "workspace_control"."knowledge_github_installation" USING btree ("organization_id","installation_id");--> statement-breakpoint
CREATE INDEX "knowledge_github_setup_state_expiry_idx" ON "workspace_control"."knowledge_github_setup_state" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "knowledge_grant_member_active_idx" ON "workspace_control"."knowledge_grant" USING btree ("organization_id","member_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_graph_revision_org_id_idx" ON "workspace_control"."knowledge_graph_revision" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "knowledge_graph_revision_environment_idx" ON "workspace_control"."knowledge_graph_revision" USING btree ("organization_id","project_environment_id","staged_at");--> statement-breakpoint
CREATE INDEX "knowledge_mapping_review_idx" ON "workspace_control"."knowledge_mapping_proposal" USING btree ("organization_id","project_environment_id","state","proposed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_project_org_id_idx" ON "workspace_control"."knowledge_project" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_project_org_name_idx" ON "workspace_control"."knowledge_project" USING btree ("organization_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_environment_org_id_idx" ON "workspace_control"."knowledge_project_environment" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_environment_project_name_idx" ON "workspace_control"."knowledge_project_environment" USING btree ("project_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_source_org_id_idx" ON "workspace_control"."knowledge_source" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "knowledge_source_environment_idx" ON "workspace_control"."knowledge_source" USING btree ("organization_id","project_environment_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_source_event_delivery_idx" ON "workspace_control"."knowledge_source_event" USING btree ("delivery_id","source_id");--> statement-breakpoint
CREATE INDEX "knowledge_source_event_pending_idx" ON "workspace_control"."knowledge_source_event" USING btree ("organization_id","source_id","state","created_at");--> statement-breakpoint
CREATE FUNCTION "workspace_control"."reject_knowledge_graph_revision_update"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'knowledge graph revisions are immutable' USING ERRCODE = '55000';
END;
$function$;--> statement-breakpoint
CREATE TRIGGER "knowledge_graph_revision_reject_update"
BEFORE UPDATE ON "workspace_control"."knowledge_graph_revision"
FOR EACH ROW EXECUTE FUNCTION "workspace_control"."reject_knowledge_graph_revision_update"();
