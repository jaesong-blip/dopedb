CREATE TABLE "workspace_control"."workspace_signal_evaluation_receipt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"rule_id" uuid NOT NULL,
	"rule_revision" bigint NOT NULL,
	"runner_id" uuid NOT NULL,
	"lease_id" uuid NOT NULL,
	"project_environment_id" uuid NOT NULL,
	"environment_revision" bigint NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"evaluated_at" timestamp with time zone NOT NULL,
	"state" text NOT NULL,
	"query_run_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"connection_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"duration_ms" bigint NOT NULL,
	"row_count_category" text NOT NULL,
	"schema_fingerprint" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"transition_sequence" bigint NOT NULL,
	"error_kind" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_signal_receipt_state" CHECK ("workspace_control"."workspace_signal_evaluation_receipt"."state" IN ('normal', 'firing', 'recovered', 'no_data', 'error', 'stale', 'runner_offline')),
	CONSTRAINT "workspace_signal_receipt_numbers" CHECK ("workspace_control"."workspace_signal_evaluation_receipt"."rule_revision" >= 1 AND "workspace_control"."workspace_signal_evaluation_receipt"."environment_revision" >= 1
        AND "workspace_control"."workspace_signal_evaluation_receipt"."duration_ms" >= 0 AND "workspace_control"."workspace_signal_evaluation_receipt"."transition_sequence" >= 1),
	CONSTRAINT "workspace_signal_receipt_arrays" CHECK (jsonb_typeof("workspace_control"."workspace_signal_evaluation_receipt"."query_run_ids") = 'array'
        AND jsonb_typeof("workspace_control"."workspace_signal_evaluation_receipt"."connection_ids") = 'array'),
	CONSTRAINT "workspace_signal_receipt_fingerprint" CHECK ("workspace_control"."workspace_signal_evaluation_receipt"."schema_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "workspace_signal_receipt_text" CHECK (char_length("workspace_control"."workspace_signal_evaluation_receipt"."row_count_category") BETWEEN 1 AND 32
        AND char_length("workspace_control"."workspace_signal_evaluation_receipt"."dedupe_key") BETWEEN 1 AND 256
        AND ("workspace_control"."workspace_signal_evaluation_receipt"."error_kind" IS NULL OR char_length("workspace_control"."workspace_signal_evaluation_receipt"."error_kind") BETWEEN 1 AND 128))
);
--> statement-breakpoint
CREATE TABLE "workspace_control"."workspace_signal_notification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"receipt_id" uuid NOT NULL,
	"recipient_member_id" text NOT NULL,
	"channel" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"delivery_attempt" integer DEFAULT 0 NOT NULL,
	"delivered_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"error_kind" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_signal_notification_channel" CHECK ("workspace_control"."workspace_signal_notification"."channel" IN ('desktop', 'workspace_web', 'email')),
	CONSTRAINT "workspace_signal_notification_state" CHECK ("workspace_control"."workspace_signal_notification"."state" IN ('pending', 'delivered', 'failed', 'suppressed')),
	CONSTRAINT "workspace_signal_notification_attempt" CHECK ("workspace_control"."workspace_signal_notification"."delivery_attempt" >= 0 AND "workspace_control"."workspace_signal_notification"."delivery_attempt" <= 100)
);
--> statement-breakpoint
CREATE TABLE "workspace_control"."workspace_signal_rule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"project_environment_id" uuid NOT NULL,
	"environment_revision" bigint NOT NULL,
	"source_analysis_id" uuid NOT NULL,
	"source_analysis_revision" bigint NOT NULL,
	"source_tile_id" text NOT NULL,
	"metric_semantic_id" text NOT NULL,
	"definition" jsonb NOT NULL,
	"owner_member_id" text NOT NULL,
	"runner_id" uuid,
	"enabled" boolean DEFAULT false NOT NULL,
	"revision" bigint DEFAULT 1 NOT NULL,
	"production_approved_by_member_id" text,
	"production_approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "workspace_signal_rule_revisions" CHECK ("workspace_control"."workspace_signal_rule"."environment_revision" >= 1
        AND "workspace_control"."workspace_signal_rule"."source_analysis_revision" >= 1
        AND "workspace_control"."workspace_signal_rule"."revision" >= 1
        AND "workspace_control"."workspace_signal_rule"."revision" <= 9007199254740991),
	CONSTRAINT "workspace_signal_rule_text" CHECK (char_length("workspace_control"."workspace_signal_rule"."source_tile_id") BETWEEN 1 AND 64
        AND char_length("workspace_control"."workspace_signal_rule"."metric_semantic_id") BETWEEN 1 AND 256),
	CONSTRAINT "workspace_signal_rule_definition_object" CHECK (jsonb_typeof("workspace_control"."workspace_signal_rule"."definition") = 'object'),
	CONSTRAINT "workspace_signal_rule_production_approval" CHECK (("workspace_control"."workspace_signal_rule"."production_approved_by_member_id" IS NULL AND "workspace_control"."workspace_signal_rule"."production_approved_at" IS NULL)
        OR ("workspace_control"."workspace_signal_rule"."production_approved_by_member_id" IS NOT NULL
          AND "workspace_control"."workspace_signal_rule"."production_approved_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "workspace_control"."workspace_signal_rule_connection" (
	"organization_id" text NOT NULL,
	"rule_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"connection_revision" bigint NOT NULL,
	CONSTRAINT "workspace_signal_rule_connection_rule_id_connection_id_pk" PRIMARY KEY("rule_id","connection_id"),
	CONSTRAINT "workspace_signal_rule_connection_revision" CHECK ("workspace_control"."workspace_signal_rule_connection"."connection_revision" >= 1)
);
--> statement-breakpoint
CREATE TABLE "workspace_control"."workspace_signal_runner" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"member_id" text NOT NULL,
	"device_id" text NOT NULL,
	"display_name" text NOT NULL,
	"background_allowed" boolean DEFAULT false NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "workspace_signal_runner_text" CHECK (char_length("workspace_control"."workspace_signal_runner"."device_id") BETWEEN 1 AND 256
        AND char_length("workspace_control"."workspace_signal_runner"."display_name") BETWEEN 1 AND 256)
);
--> statement-breakpoint
CREATE TABLE "workspace_control"."workspace_signal_runner_lease" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"rule_id" uuid NOT NULL,
	"rule_revision" bigint NOT NULL,
	"runner_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"lease_capability_hash" text NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_signal_runner_lease_revision" CHECK ("workspace_control"."workspace_signal_runner_lease"."rule_revision" >= 1),
	CONSTRAINT "workspace_signal_runner_lease_hash" CHECK ("workspace_control"."workspace_signal_runner_lease"."lease_capability_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "workspace_signal_runner_lease_time" CHECK ("workspace_control"."workspace_signal_runner_lease"."expires_at" > "workspace_control"."workspace_signal_runner_lease"."scheduled_at")
);
--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_signal_evaluation_receipt" ADD CONSTRAINT "workspace_signal_evaluation_receipt_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "workspace_control"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_signal_evaluation_receipt" ADD CONSTRAINT "workspace_signal_receipt_org_rule_fk" FOREIGN KEY ("organization_id","rule_id") REFERENCES "workspace_control"."workspace_signal_rule"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_signal_evaluation_receipt" ADD CONSTRAINT "workspace_signal_receipt_org_runner_fk" FOREIGN KEY ("organization_id","runner_id") REFERENCES "workspace_control"."workspace_signal_runner"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_signal_evaluation_receipt" ADD CONSTRAINT "workspace_signal_receipt_org_lease_fk" FOREIGN KEY ("organization_id","lease_id") REFERENCES "workspace_control"."workspace_signal_runner_lease"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_signal_notification" ADD CONSTRAINT "workspace_signal_notification_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "workspace_control"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_signal_notification" ADD CONSTRAINT "workspace_signal_notification_org_receipt_fk" FOREIGN KEY ("organization_id","receipt_id") REFERENCES "workspace_control"."workspace_signal_evaluation_receipt"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_signal_notification" ADD CONSTRAINT "workspace_signal_notification_org_member_fk" FOREIGN KEY ("organization_id","recipient_member_id") REFERENCES "workspace_control"."member"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_signal_rule" ADD CONSTRAINT "workspace_signal_rule_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "workspace_control"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_signal_rule" ADD CONSTRAINT "workspace_signal_rule_org_environment_fk" FOREIGN KEY ("organization_id","project_environment_id") REFERENCES "workspace_control"."knowledge_project_environment"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_signal_rule" ADD CONSTRAINT "workspace_signal_rule_org_analysis_revision_fk" FOREIGN KEY ("organization_id","source_analysis_id","source_analysis_revision") REFERENCES "workspace_control"."workspace_funnel_analysis_revision"("organization_id","analysis_id","revision") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_signal_rule" ADD CONSTRAINT "workspace_signal_rule_org_owner_fk" FOREIGN KEY ("organization_id","owner_member_id") REFERENCES "workspace_control"."member"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_signal_rule" ADD CONSTRAINT "workspace_signal_rule_org_runner_fk" FOREIGN KEY ("organization_id","runner_id") REFERENCES "workspace_control"."workspace_signal_runner"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_signal_rule_connection" ADD CONSTRAINT "workspace_signal_rule_connection_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "workspace_control"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_signal_rule_connection" ADD CONSTRAINT "workspace_signal_rule_connection_org_rule_fk" FOREIGN KEY ("organization_id","rule_id") REFERENCES "workspace_control"."workspace_signal_rule"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_signal_rule_connection" ADD CONSTRAINT "workspace_signal_rule_connection_org_connection_fk" FOREIGN KEY ("organization_id","connection_id") REFERENCES "workspace_control"."workspace_connection"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_signal_runner" ADD CONSTRAINT "workspace_signal_runner_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "workspace_control"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_signal_runner" ADD CONSTRAINT "workspace_signal_runner_org_member_fk" FOREIGN KEY ("organization_id","member_id") REFERENCES "workspace_control"."member"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_signal_runner_lease" ADD CONSTRAINT "workspace_signal_runner_lease_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "workspace_control"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_signal_runner_lease" ADD CONSTRAINT "workspace_signal_runner_lease_org_rule_fk" FOREIGN KEY ("organization_id","rule_id") REFERENCES "workspace_control"."workspace_signal_rule"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_signal_runner_lease" ADD CONSTRAINT "workspace_signal_runner_lease_org_runner_fk" FOREIGN KEY ("organization_id","runner_id") REFERENCES "workspace_control"."workspace_signal_runner"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_signal_receipt_org_id_idx" ON "workspace_control"."workspace_signal_evaluation_receipt" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_signal_receipt_dedupe_idx" ON "workspace_control"."workspace_signal_evaluation_receipt" USING btree ("organization_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "workspace_signal_receipt_rule_idx" ON "workspace_control"."workspace_signal_evaluation_receipt" USING btree ("organization_id","rule_id","transition_sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_signal_notification_delivery_idx" ON "workspace_control"."workspace_signal_notification" USING btree ("organization_id","receipt_id","recipient_member_id","channel");--> statement-breakpoint
CREATE INDEX "workspace_signal_notification_inbox_idx" ON "workspace_control"."workspace_signal_notification" USING btree ("organization_id","recipient_member_id","read_at","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_signal_rule_org_id_idx" ON "workspace_control"."workspace_signal_rule" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "workspace_signal_rule_environment_idx" ON "workspace_control"."workspace_signal_rule" USING btree ("organization_id","project_environment_id","enabled","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_signal_runner_org_id_idx" ON "workspace_control"."workspace_signal_runner" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_signal_runner_org_device_idx" ON "workspace_control"."workspace_signal_runner" USING btree ("organization_id","device_id");--> statement-breakpoint
CREATE INDEX "workspace_signal_runner_member_idx" ON "workspace_control"."workspace_signal_runner" USING btree ("organization_id","member_id","revoked_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_signal_runner_lease_org_id_idx" ON "workspace_control"."workspace_signal_runner_lease" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_signal_runner_lease_idempotency_idx" ON "workspace_control"."workspace_signal_runner_lease" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "workspace_signal_runner_lease_due_idx" ON "workspace_control"."workspace_signal_runner_lease" USING btree ("organization_id","rule_id","expires_at");