ALTER TABLE "workspace_control"."workspace_analysis_signal_notification" ADD COLUMN "claim_id" uuid;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_signal_notification" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_signal_notification" ADD COLUMN "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX "workspace_analysis_signal_notification_due_idx" ON "workspace_control"."workspace_analysis_signal_notification" USING btree ("channel","state","next_attempt_at","claimed_at");--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_signal_notification" ADD CONSTRAINT "workspace_analysis_signal_notification_claim" CHECK (("workspace_control"."workspace_analysis_signal_notification"."claim_id" IS NULL AND "workspace_control"."workspace_analysis_signal_notification"."claimed_at" IS NULL)
        OR ("workspace_control"."workspace_analysis_signal_notification"."claim_id" IS NOT NULL AND "workspace_control"."workspace_analysis_signal_notification"."claimed_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_signal_notification" ADD CONSTRAINT "workspace_analysis_signal_notification_terminal" CHECK (("workspace_control"."workspace_analysis_signal_notification"."state" = 'pending' AND "workspace_control"."workspace_analysis_signal_notification"."delivered_at" IS NULL)
        OR ("workspace_control"."workspace_analysis_signal_notification"."state" = 'delivered' AND "workspace_control"."workspace_analysis_signal_notification"."delivered_at" IS NOT NULL
          AND "workspace_control"."workspace_analysis_signal_notification"."claim_id" IS NULL AND "workspace_control"."workspace_analysis_signal_notification"."claimed_at" IS NULL)
        OR ("workspace_control"."workspace_analysis_signal_notification"."state" = 'failed' AND "workspace_control"."workspace_analysis_signal_notification"."delivered_at" IS NULL
          AND "workspace_control"."workspace_analysis_signal_notification"."claim_id" IS NULL AND "workspace_control"."workspace_analysis_signal_notification"."claimed_at" IS NULL));--> statement-breakpoint
CREATE INDEX "rate_limit_last_request_idx" ON "workspace_control"."rate_limit" USING btree ("last_request");
