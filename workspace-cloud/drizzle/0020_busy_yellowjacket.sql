CREATE TABLE "workspace_control"."workspace_report" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"title" text NOT NULL,
	"question" text NOT NULL,
	"conclusion" text NOT NULL,
	"preflight_warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"claims" jsonb NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"source" text NOT NULL,
	"owner_member_id" text NOT NULL,
	"updated_by_member_id" text NOT NULL,
	"revision" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "workspace_report_title_length" CHECK (char_length(btrim("workspace_control"."workspace_report"."title")) BETWEEN 1 AND 120),
	CONSTRAINT "workspace_report_question_length" CHECK (char_length(btrim("workspace_control"."workspace_report"."question")) BETWEEN 1 AND 8000),
	CONSTRAINT "workspace_report_conclusion_length" CHECK (char_length(btrim("workspace_control"."workspace_report"."conclusion")) BETWEEN 1 AND 20000),
	CONSTRAINT "workspace_report_warnings_array" CHECK (jsonb_typeof("workspace_control"."workspace_report"."preflight_warnings") = 'array'),
	CONSTRAINT "workspace_report_claims_array" CHECK (jsonb_typeof("workspace_control"."workspace_report"."claims") = 'array'),
	CONSTRAINT "workspace_report_state" CHECK ("workspace_control"."workspace_report"."state" IN ('draft', 'review', 'published', 'archived')),
	CONSTRAINT "workspace_report_source" CHECK ("workspace_control"."workspace_report"."source" IN ('human', 'agent_proposal')),
	CONSTRAINT "workspace_report_revision" CHECK ("workspace_control"."workspace_report"."revision" >= 1 AND "workspace_control"."workspace_report"."revision" <= 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE "workspace_control"."workspace_report_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"report_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"query_run_id" uuid NOT NULL,
	"sql" text NOT NULL,
	"query_hash" text NOT NULL,
	"executed_at" timestamp with time zone NOT NULL,
	"added_at_revision" bigint NOT NULL,
	"created_by_user_id" text,
	"created_by_member_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_report_evidence_sql_length" CHECK (octet_length("workspace_control"."workspace_report_evidence"."sql") BETWEEN 1 AND 20000),
	CONSTRAINT "workspace_report_evidence_query_hash" CHECK ("workspace_control"."workspace_report_evidence"."query_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "workspace_report_evidence_revision" CHECK ("workspace_control"."workspace_report_evidence"."added_at_revision" >= 1 AND "workspace_control"."workspace_report_evidence"."added_at_revision" <= 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE "workspace_control"."workspace_report_revision" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"report_id" uuid NOT NULL,
	"revision" bigint NOT NULL,
	"base_revision" bigint,
	"operation" text NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"created_by_user_id" text,
	"created_by_member_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_report_revision_number" CHECK ("workspace_control"."workspace_report_revision"."revision" >= 1 AND "workspace_control"."workspace_report_revision"."revision" <= 9007199254740991),
	CONSTRAINT "workspace_report_revision_base" CHECK ("workspace_control"."workspace_report_revision"."base_revision" IS NULL OR ("workspace_control"."workspace_report_revision"."base_revision" >= 0 AND "workspace_control"."workspace_report_revision"."base_revision" <= 9007199254740991)),
	CONSTRAINT "workspace_report_revision_operation" CHECK ("workspace_control"."workspace_report_revision"."operation" IN ('create', 'propose', 'update', 'submit_review', 'return_draft', 'publish', 'archive', 'restore', 'transfer', 'append_evidence', 'delete')),
	CONSTRAINT "workspace_report_revision_payload_hash" CHECK ("workspace_control"."workspace_report_revision"."payload_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_report" ADD CONSTRAINT "workspace_report_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "workspace_control"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_report" ADD CONSTRAINT "workspace_report_org_connection_fk" FOREIGN KEY ("organization_id","connection_id") REFERENCES "workspace_control"."workspace_connection"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_report_org_id_idx" ON "workspace_control"."workspace_report" USING btree ("organization_id","id");--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_report_evidence" ADD CONSTRAINT "workspace_report_evidence_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "workspace_control"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_report_evidence" ADD CONSTRAINT "workspace_report_evidence_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "workspace_control"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_report_evidence" ADD CONSTRAINT "workspace_report_evidence_org_report_fk" FOREIGN KEY ("organization_id","report_id") REFERENCES "workspace_control"."workspace_report"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_report_evidence" ADD CONSTRAINT "workspace_report_evidence_org_connection_fk" FOREIGN KEY ("organization_id","connection_id") REFERENCES "workspace_control"."workspace_connection"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_report_revision" ADD CONSTRAINT "workspace_report_revision_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "workspace_control"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_report_revision" ADD CONSTRAINT "workspace_report_revision_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "workspace_control"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_report_revision" ADD CONSTRAINT "workspace_report_revision_org_report_fk" FOREIGN KEY ("organization_id","report_id") REFERENCES "workspace_control"."workspace_report"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_report_org_updated_idx" ON "workspace_control"."workspace_report" USING btree ("organization_id","updated_at");--> statement-breakpoint
CREATE INDEX "workspace_report_org_connection_idx" ON "workspace_control"."workspace_report" USING btree ("organization_id","connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_report_evidence_org_report_id_idx" ON "workspace_control"."workspace_report_evidence" USING btree ("organization_id","report_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_report_evidence_org_report_run_idx" ON "workspace_control"."workspace_report_evidence" USING btree ("organization_id","report_id","query_run_id");--> statement-breakpoint
CREATE INDEX "workspace_report_evidence_org_report_created_idx" ON "workspace_control"."workspace_report_evidence" USING btree ("organization_id","report_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_report_revision_org_report_revision_idx" ON "workspace_control"."workspace_report_revision" USING btree ("organization_id","report_id","revision");--> statement-breakpoint
CREATE INDEX "workspace_report_revision_org_report_created_idx" ON "workspace_control"."workspace_report_revision" USING btree ("organization_id","report_id","created_at");--> statement-breakpoint
CREATE FUNCTION "workspace_control"."reject_workspace_report_immutable_update"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'workspace report evidence and revisions are immutable'
    USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "workspace_report_evidence_immutable_update"
BEFORE UPDATE ON "workspace_control"."workspace_report_evidence"
FOR EACH ROW
EXECUTE FUNCTION "workspace_control"."reject_workspace_report_immutable_update"();--> statement-breakpoint
CREATE TRIGGER "workspace_report_revision_immutable_update"
BEFORE UPDATE ON "workspace_control"."workspace_report_revision"
FOR EACH ROW
EXECUTE FUNCTION "workspace_control"."reject_workspace_report_immutable_update"();
