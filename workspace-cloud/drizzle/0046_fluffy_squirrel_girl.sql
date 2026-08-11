ALTER TABLE "workspace_control"."workspace_analysis_result_fragment" DROP CONSTRAINT "workspace_analysis_result_fragment_bounds";--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_result_fragment" ADD COLUMN "expires_at" timestamp with time zone NOT NULL;--> statement-breakpoint
CREATE INDEX "workspace_analysis_result_fragment_expiry_idx" ON "workspace_control"."workspace_analysis_result_fragment" USING btree ("organization_id","expires_at");--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_result_fragment" ADD CONSTRAINT "workspace_analysis_result_fragment_bounds" CHECK ("workspace_control"."workspace_analysis_result_fragment"."ordinal" BETWEEN 0 AND 255
        AND "workspace_control"."workspace_analysis_result_fragment"."row_count" BETWEEN 0 AND 5000
        AND "workspace_control"."workspace_analysis_result_fragment"."plaintext_bytes" BETWEEN 2 AND 1048576
        AND "workspace_control"."workspace_analysis_result_fragment"."expires_at" > "workspace_control"."workspace_analysis_result_fragment"."created_at");