CREATE TABLE "workspace_control"."knowledge_environment_connection" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"project_environment_id" uuid NOT NULL,
	"environment_revision" bigint NOT NULL,
	"connection_id" uuid NOT NULL,
	"connection_revision" bigint NOT NULL,
	"role" text NOT NULL,
	"alias" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "knowledge_environment_connection_revisions_positive" CHECK ("workspace_control"."knowledge_environment_connection"."environment_revision" >= 1 AND "workspace_control"."knowledge_environment_connection"."connection_revision" >= 1),
	CONSTRAINT "knowledge_environment_connection_labels" CHECK (char_length("workspace_control"."knowledge_environment_connection"."role") BETWEEN 1 AND 64
        AND char_length("workspace_control"."knowledge_environment_connection"."alias") BETWEEN 1 AND 128)
);
--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_environment_connection" ADD CONSTRAINT "knowledge_environment_connection_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "workspace_control"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_environment_connection" ADD CONSTRAINT "knowledge_environment_connection_project_environment_id_knowledge_project_environment_id_fk" FOREIGN KEY ("project_environment_id") REFERENCES "workspace_control"."knowledge_project_environment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_environment_connection" ADD CONSTRAINT "knowledge_environment_connection_connection_id_workspace_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "workspace_control"."workspace_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_environment_connection" ADD CONSTRAINT "knowledge_environment_connection_org_environment_fk" FOREIGN KEY ("organization_id","project_environment_id") REFERENCES "workspace_control"."knowledge_project_environment"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_environment_connection" ADD CONSTRAINT "knowledge_environment_connection_org_connection_fk" FOREIGN KEY ("organization_id","connection_id") REFERENCES "workspace_control"."workspace_connection"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_environment_connection_active_idx" ON "workspace_control"."knowledge_environment_connection" USING btree ("project_environment_id","connection_id") WHERE "workspace_control"."knowledge_environment_connection"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "knowledge_environment_connection_scope_idx" ON "workspace_control"."knowledge_environment_connection" USING btree ("organization_id","project_environment_id","revoked_at");