CREATE TABLE "workspace_control"."workspace_signal_rule_revision" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"rule_id" uuid NOT NULL,
	"revision" bigint NOT NULL,
	"base_revision" bigint,
	"operation" text NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"created_by_member_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_signal_rule_revision_number" CHECK ("workspace_control"."workspace_signal_rule_revision"."revision" >= 1 AND "workspace_control"."workspace_signal_rule_revision"."revision" <= 9007199254740991),
	CONSTRAINT "workspace_signal_rule_revision_operation" CHECK ("workspace_control"."workspace_signal_rule_revision"."operation" IN ('create', 'update', 'enable', 'pause', 'disable', 'runner_change')),
	CONSTRAINT "workspace_signal_rule_revision_hash" CHECK ("workspace_control"."workspace_signal_rule_revision"."payload_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "workspace_signal_rule_revision_payload" CHECK (jsonb_typeof("workspace_control"."workspace_signal_rule_revision"."payload") = 'object')
);
--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_signal_rule_revision" ADD CONSTRAINT "workspace_signal_rule_revision_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "workspace_control"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_signal_rule_revision" ADD CONSTRAINT "workspace_signal_rule_revision_org_rule_fk" FOREIGN KEY ("organization_id","rule_id") REFERENCES "workspace_control"."workspace_signal_rule"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_signal_rule_revision" ADD CONSTRAINT "workspace_signal_rule_revision_org_member_fk" FOREIGN KEY ("organization_id","created_by_member_id") REFERENCES "workspace_control"."member"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_signal_rule_revision_unique_idx" ON "workspace_control"."workspace_signal_rule_revision" USING btree ("organization_id","rule_id","revision");--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_signal_evaluation_receipt" ADD CONSTRAINT "workspace_signal_receipt_org_rule_revision_fk" FOREIGN KEY ("organization_id","rule_id","rule_revision") REFERENCES "workspace_control"."workspace_signal_rule_revision"("organization_id","rule_id","revision") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_signal_evaluation_receipt" ADD CONSTRAINT "workspace_signal_receipt_org_environment_fk" FOREIGN KEY ("organization_id","project_environment_id") REFERENCES "workspace_control"."knowledge_project_environment"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_signal_rule" ADD CONSTRAINT "workspace_signal_rule_org_approver_fk" FOREIGN KEY ("organization_id","production_approved_by_member_id") REFERENCES "workspace_control"."member"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_signal_runner_lease" ADD CONSTRAINT "workspace_signal_runner_lease_org_rule_revision_fk" FOREIGN KEY ("organization_id","rule_id","rule_revision") REFERENCES "workspace_control"."workspace_signal_rule_revision"("organization_id","rule_id","revision") ON DELETE restrict ON UPDATE no action;