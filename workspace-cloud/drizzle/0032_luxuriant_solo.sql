CREATE TABLE "workspace_control"."workspace_funnel_analysis" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"project_environment_id" uuid NOT NULL,
	"environment_revision" bigint NOT NULL,
	"source_knowledge_grant_id" uuid NOT NULL,
	"definition" jsonb NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"owner_member_id" text NOT NULL,
	"updated_by_member_id" text NOT NULL,
	"revision" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "workspace_funnel_analysis_environment_revision" CHECK ("workspace_control"."workspace_funnel_analysis"."environment_revision" >= 1),
	CONSTRAINT "workspace_funnel_analysis_state" CHECK ("workspace_control"."workspace_funnel_analysis"."state" IN ('draft', 'published', 'archived')),
	CONSTRAINT "workspace_funnel_analysis_revision" CHECK ("workspace_control"."workspace_funnel_analysis"."revision" >= 1 AND "workspace_control"."workspace_funnel_analysis"."revision" <= 9007199254740991),
	CONSTRAINT "workspace_funnel_analysis_definition_object" CHECK (jsonb_typeof("workspace_control"."workspace_funnel_analysis"."definition") = 'object')
);
--> statement-breakpoint
CREATE TABLE "workspace_control"."workspace_funnel_analysis_connection" (
	"organization_id" text NOT NULL,
	"analysis_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"connection_revision" bigint NOT NULL,
	"role" text NOT NULL,
	"alias" text NOT NULL,
	CONSTRAINT "workspace_funnel_analysis_connection_analysis_id_connection_id_pk" PRIMARY KEY("analysis_id","connection_id"),
	CONSTRAINT "workspace_funnel_analysis_connection_revision" CHECK ("workspace_control"."workspace_funnel_analysis_connection"."connection_revision" >= 1),
	CONSTRAINT "workspace_funnel_analysis_connection_labels" CHECK (char_length("workspace_control"."workspace_funnel_analysis_connection"."role") BETWEEN 1 AND 64
        AND char_length("workspace_control"."workspace_funnel_analysis_connection"."alias") BETWEEN 1 AND 128)
);
--> statement-breakpoint
CREATE TABLE "workspace_control"."workspace_funnel_analysis_graph" (
	"organization_id" text NOT NULL,
	"analysis_id" uuid NOT NULL,
	"graph_revision_id" uuid NOT NULL,
	CONSTRAINT "workspace_funnel_analysis_graph_analysis_id_graph_revision_id_pk" PRIMARY KEY("analysis_id","graph_revision_id")
);
--> statement-breakpoint
CREATE TABLE "workspace_control"."workspace_funnel_analysis_revision" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"analysis_id" uuid NOT NULL,
	"revision" bigint NOT NULL,
	"base_revision" bigint,
	"operation" text NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"created_by_user_id" text,
	"created_by_member_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_funnel_analysis_revision_number" CHECK ("workspace_control"."workspace_funnel_analysis_revision"."revision" >= 1 AND "workspace_control"."workspace_funnel_analysis_revision"."revision" <= 9007199254740991),
	CONSTRAINT "workspace_funnel_analysis_revision_operation" CHECK ("workspace_control"."workspace_funnel_analysis_revision"."operation" IN ('create', 'publish', 'archive', 'restore', 'conflict_copy')),
	CONSTRAINT "workspace_funnel_analysis_revision_payload_hash" CHECK ("workspace_control"."workspace_funnel_analysis_revision"."payload_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_funnel_analysis_org_id_idx" ON "workspace_control"."workspace_funnel_analysis" USING btree ("organization_id","id");--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_funnel_analysis" ADD CONSTRAINT "workspace_funnel_analysis_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "workspace_control"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_funnel_analysis" ADD CONSTRAINT "workspace_funnel_analysis_org_environment_fk" FOREIGN KEY ("organization_id","project_environment_id") REFERENCES "workspace_control"."knowledge_project_environment"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_funnel_analysis_connection" ADD CONSTRAINT "workspace_funnel_analysis_connection_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "workspace_control"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_funnel_analysis_connection" ADD CONSTRAINT "workspace_funnel_analysis_connection_org_analysis_fk" FOREIGN KEY ("organization_id","analysis_id") REFERENCES "workspace_control"."workspace_funnel_analysis"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_funnel_analysis_connection" ADD CONSTRAINT "workspace_funnel_analysis_connection_org_connection_fk" FOREIGN KEY ("organization_id","connection_id") REFERENCES "workspace_control"."workspace_connection"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_funnel_analysis_graph" ADD CONSTRAINT "workspace_funnel_analysis_graph_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "workspace_control"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_funnel_analysis_graph" ADD CONSTRAINT "workspace_funnel_analysis_graph_org_analysis_fk" FOREIGN KEY ("organization_id","analysis_id") REFERENCES "workspace_control"."workspace_funnel_analysis"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_funnel_analysis_graph" ADD CONSTRAINT "workspace_funnel_analysis_graph_org_graph_fk" FOREIGN KEY ("organization_id","graph_revision_id") REFERENCES "workspace_control"."knowledge_graph_revision"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_funnel_analysis_revision" ADD CONSTRAINT "workspace_funnel_analysis_revision_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "workspace_control"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_funnel_analysis_revision" ADD CONSTRAINT "workspace_funnel_analysis_revision_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "workspace_control"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_funnel_analysis_revision" ADD CONSTRAINT "workspace_funnel_analysis_revision_org_analysis_fk" FOREIGN KEY ("organization_id","analysis_id") REFERENCES "workspace_control"."workspace_funnel_analysis"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_funnel_analysis_environment_idx" ON "workspace_control"."workspace_funnel_analysis" USING btree ("organization_id","project_environment_id","updated_at");--> statement-breakpoint
CREATE INDEX "workspace_funnel_analysis_connection_org_idx" ON "workspace_control"."workspace_funnel_analysis_connection" USING btree ("organization_id","connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_funnel_analysis_revision_unique_idx" ON "workspace_control"."workspace_funnel_analysis_revision" USING btree ("organization_id","analysis_id","revision");
