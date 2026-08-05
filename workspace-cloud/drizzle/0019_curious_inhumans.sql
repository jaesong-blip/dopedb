CREATE TABLE "workspace_control"."workspace_dashboard" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"sql" text NOT NULL,
	"visualization" jsonb NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"owner_member_id" text NOT NULL,
	"updated_by_member_id" text NOT NULL,
	"revision" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "workspace_dashboard_title_length" CHECK (char_length(btrim("workspace_control"."workspace_dashboard"."title")) BETWEEN 1 AND 120),
	CONSTRAINT "workspace_dashboard_description_length" CHECK (char_length("workspace_control"."workspace_dashboard"."description") <= 2000),
	CONSTRAINT "workspace_dashboard_sql_length" CHECK (octet_length("workspace_control"."workspace_dashboard"."sql") BETWEEN 1 AND 100000),
	CONSTRAINT "workspace_dashboard_state" CHECK ("workspace_control"."workspace_dashboard"."state" IN ('draft', 'published', 'archived')),
	CONSTRAINT "workspace_dashboard_revision" CHECK ("workspace_control"."workspace_dashboard"."revision" >= 1 AND "workspace_control"."workspace_dashboard"."revision" <= 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE "workspace_control"."workspace_dashboard_revision" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"dashboard_id" uuid NOT NULL,
	"revision" bigint NOT NULL,
	"base_revision" bigint,
	"operation" text NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"created_by_user_id" text,
	"created_by_member_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_dashboard_revision_number" CHECK ("workspace_control"."workspace_dashboard_revision"."revision" >= 1 AND "workspace_control"."workspace_dashboard_revision"."revision" <= 9007199254740991),
	CONSTRAINT "workspace_dashboard_revision_base" CHECK ("workspace_control"."workspace_dashboard_revision"."base_revision" IS NULL OR ("workspace_control"."workspace_dashboard_revision"."base_revision" >= 0 AND "workspace_control"."workspace_dashboard_revision"."base_revision" <= 9007199254740991)),
	CONSTRAINT "workspace_dashboard_revision_operation" CHECK ("workspace_control"."workspace_dashboard_revision"."operation" IN ('create', 'update', 'publish', 'archive', 'restore', 'transfer', 'delete', 'conflict_copy')),
	CONSTRAINT "workspace_dashboard_revision_payload_hash" CHECK ("workspace_control"."workspace_dashboard_revision"."payload_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_dashboard" ADD CONSTRAINT "workspace_dashboard_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "workspace_control"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_dashboard" ADD CONSTRAINT "workspace_dashboard_org_connection_fk" FOREIGN KEY ("organization_id","connection_id") REFERENCES "workspace_control"."workspace_connection"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_dashboard_revision" ADD CONSTRAINT "workspace_dashboard_revision_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "workspace_control"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_dashboard_revision" ADD CONSTRAINT "workspace_dashboard_revision_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "workspace_control"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_dashboard_org_id_idx" ON "workspace_control"."workspace_dashboard" USING btree ("organization_id","id");--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_dashboard_revision" ADD CONSTRAINT "workspace_dashboard_revision_org_dashboard_fk" FOREIGN KEY ("organization_id","dashboard_id") REFERENCES "workspace_control"."workspace_dashboard"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_dashboard_org_updated_idx" ON "workspace_control"."workspace_dashboard" USING btree ("organization_id","updated_at");--> statement-breakpoint
CREATE INDEX "workspace_dashboard_org_connection_idx" ON "workspace_control"."workspace_dashboard" USING btree ("organization_id","connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_dashboard_revision_org_dashboard_revision_idx" ON "workspace_control"."workspace_dashboard_revision" USING btree ("organization_id","dashboard_id","revision");--> statement-breakpoint
CREATE INDEX "workspace_dashboard_revision_org_dashboard_created_idx" ON "workspace_control"."workspace_dashboard_revision" USING btree ("organization_id","dashboard_id","created_at");
