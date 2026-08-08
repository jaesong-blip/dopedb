CREATE UNIQUE INDEX "workspace_signal_runner_lease_scope_idx" ON "workspace_control"."workspace_signal_runner_lease" USING btree ("organization_id","id","rule_id","rule_revision","runner_id");--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_signal_evaluation_receipt" ADD CONSTRAINT "workspace_signal_receipt_exact_lease_fk" FOREIGN KEY ("organization_id","lease_id","rule_id","rule_revision","runner_id") REFERENCES "workspace_control"."workspace_signal_runner_lease"("organization_id","id","rule_id","rule_revision","runner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_signal_rule" ADD CONSTRAINT "workspace_signal_rule_enabled_runner" CHECK (NOT "workspace_control"."workspace_signal_rule"."enabled" OR "workspace_control"."workspace_signal_rule"."runner_id" IS NOT NULL);--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_signal_runner_lease_one_active_idx"
ON "workspace_control"."workspace_signal_runner_lease" ("organization_id", "rule_id")
WHERE "completed_at" IS NULL AND "revoked_at" IS NULL;
