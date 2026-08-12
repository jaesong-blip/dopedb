CREATE TABLE "workspace_control"."workspace_analysis_signal_notification" (
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
	CONSTRAINT "workspace_analysis_signal_notification_channel" CHECK ("workspace_control"."workspace_analysis_signal_notification"."channel" IN ('desktop', 'workspace_web', 'email')),
	CONSTRAINT "workspace_analysis_signal_notification_state" CHECK ("workspace_control"."workspace_analysis_signal_notification"."state" IN ('pending', 'delivered', 'failed')),
	CONSTRAINT "workspace_analysis_signal_notification_attempt" CHECK ("workspace_control"."workspace_analysis_signal_notification"."delivery_attempt" BETWEEN 0 AND 20)
);
--> statement-breakpoint
CREATE TABLE "workspace_control"."workspace_analysis_signal_receipt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"signal_id" uuid NOT NULL,
	"signal_revision" bigint NOT NULL,
	"run_id" uuid NOT NULL,
	"runner_id" uuid NOT NULL,
	"observed_state" text NOT NULL,
	"state" text NOT NULL,
	"result_hash" text NOT NULL,
	"schema_fingerprint" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"transition_sequence" bigint NOT NULL,
	"error_kind" text,
	"evaluated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_analysis_signal_receipt_states" CHECK ("workspace_control"."workspace_analysis_signal_receipt"."observed_state" IN ('normal', 'firing', 'no_data', 'error', 'stale')
        AND "workspace_control"."workspace_analysis_signal_receipt"."state" IN ('normal', 'firing', 'recovered', 'no_data', 'error', 'stale')),
	CONSTRAINT "workspace_analysis_signal_receipt_hashes" CHECK ("workspace_control"."workspace_analysis_signal_receipt"."result_hash" ~ '^[0-9a-f]{64}$'
        AND "workspace_control"."workspace_analysis_signal_receipt"."schema_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "workspace_analysis_signal_receipt_numbers" CHECK ("workspace_control"."workspace_analysis_signal_receipt"."signal_revision" >= 1 AND "workspace_control"."workspace_analysis_signal_receipt"."transition_sequence" >= 1),
	CONSTRAINT "workspace_analysis_signal_receipt_text" CHECK (char_length("workspace_control"."workspace_analysis_signal_receipt"."dedupe_key") BETWEEN 1 AND 256
        AND ("workspace_control"."workspace_analysis_signal_receipt"."error_kind" IS NULL OR char_length("workspace_control"."workspace_analysis_signal_receipt"."error_kind") BETWEEN 1 AND 128))
);
--> statement-breakpoint
CREATE TABLE "workspace_control"."workspace_analysis_signal_revision" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"signal_id" uuid NOT NULL,
	"revision" bigint NOT NULL,
	"base_revision" bigint,
	"operation" text NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"created_by_member_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_analysis_signal_revision_number" CHECK ("workspace_control"."workspace_analysis_signal_revision"."revision" >= 1 AND "workspace_control"."workspace_analysis_signal_revision"."revision" <= 9007199254740991),
	CONSTRAINT "workspace_analysis_signal_revision_operation" CHECK ("workspace_control"."workspace_analysis_signal_revision"."operation" IN ('create', 'update', 'enable', 'disable', 'delete')),
	CONSTRAINT "workspace_analysis_signal_revision_payload" CHECK (jsonb_typeof("workspace_control"."workspace_analysis_signal_revision"."payload") = 'object'
        AND "workspace_control"."workspace_analysis_signal_revision"."payload_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
-- PostgreSQL resolves composite foreign-key targets when each ALTER TABLE is
-- executed. Create both referenced unique keys before the notification and
-- receipt constraints that depend on them.
CREATE UNIQUE INDEX "workspace_analysis_signal_receipt_org_id_idx" ON "workspace_control"."workspace_analysis_signal_receipt" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_analysis_signal_revision_unique_idx" ON "workspace_control"."workspace_analysis_signal_revision" USING btree ("organization_id","signal_id","revision");--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_signal" DROP CONSTRAINT "workspace_analysis_signal_org_run_fk";
--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_signal_notification" ADD CONSTRAINT "workspace_analysis_signal_notification_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "workspace_control"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_signal_notification" ADD CONSTRAINT "workspace_analysis_signal_notification_org_receipt_fk" FOREIGN KEY ("organization_id","receipt_id") REFERENCES "workspace_control"."workspace_analysis_signal_receipt"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_signal_notification" ADD CONSTRAINT "workspace_analysis_signal_notification_org_member_fk" FOREIGN KEY ("organization_id","recipient_member_id") REFERENCES "workspace_control"."member"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_signal_receipt" ADD CONSTRAINT "workspace_analysis_signal_receipt_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "workspace_control"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_signal_receipt" ADD CONSTRAINT "workspace_analysis_signal_receipt_org_revision_fk" FOREIGN KEY ("organization_id","signal_id","signal_revision") REFERENCES "workspace_control"."workspace_analysis_signal_revision"("organization_id","signal_id","revision") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_signal_receipt" ADD CONSTRAINT "workspace_analysis_signal_receipt_org_run_fk" FOREIGN KEY ("organization_id","run_id") REFERENCES "workspace_control"."workspace_analysis_article_run"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_signal_receipt" ADD CONSTRAINT "workspace_analysis_signal_receipt_org_runner_fk" FOREIGN KEY ("organization_id","runner_id") REFERENCES "workspace_control"."workspace_analysis_runner"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_signal_revision" ADD CONSTRAINT "workspace_analysis_signal_revision_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "workspace_control"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_signal_revision" ADD CONSTRAINT "workspace_analysis_signal_revision_org_signal_fk" FOREIGN KEY ("organization_id","signal_id") REFERENCES "workspace_control"."workspace_analysis_signal"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_signal_revision" ADD CONSTRAINT "workspace_analysis_signal_revision_org_member_fk" FOREIGN KEY ("organization_id","created_by_member_id") REFERENCES "workspace_control"."member"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_analysis_signal_notification_delivery_idx" ON "workspace_control"."workspace_analysis_signal_notification" USING btree ("organization_id","receipt_id","recipient_member_id","channel");--> statement-breakpoint
CREATE INDEX "workspace_analysis_signal_notification_inbox_idx" ON "workspace_control"."workspace_analysis_signal_notification" USING btree ("organization_id","recipient_member_id","read_at","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_analysis_signal_receipt_dedupe_idx" ON "workspace_control"."workspace_analysis_signal_receipt" USING btree ("organization_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "workspace_analysis_signal_receipt_history_idx" ON "workspace_control"."workspace_analysis_signal_receipt" USING btree ("organization_id","signal_id","transition_sequence");--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_signal" ADD CONSTRAINT "workspace_analysis_signal_org_run_fk" FOREIGN KEY ("organization_id","last_evaluated_run_id") REFERENCES "workspace_control"."workspace_analysis_article_run"("organization_id","id") ON DELETE restrict ON UPDATE no action;
