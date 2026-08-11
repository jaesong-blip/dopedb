ALTER TABLE "workspace_control"."workspace_analysis_publication" DROP CONSTRAINT "workspace_analysis_publication_snapshot";--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_article_run" DROP CONSTRAINT "workspace_analysis_article_run_org_requester_fk";
--> statement-breakpoint
DROP INDEX "workspace_control"."workspace_analysis_publication_slug_idx";--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_article_run" ADD COLUMN "cancel_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_article_run" ADD COLUMN "cancel_requested_by_member_id" text;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_publication" ADD COLUMN "version" bigint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_publication" ADD COLUMN "replaces_publication_id" uuid;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_article_run" ADD CONSTRAINT "workspace_analysis_article_run_org_cancel_requester_fk" FOREIGN KEY ("organization_id","cancel_requested_by_member_id") REFERENCES "workspace_control"."member"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_article_run" ADD CONSTRAINT "workspace_analysis_article_run_org_requester_fk" FOREIGN KEY ("organization_id","requested_by_member_id") REFERENCES "workspace_control"."member"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_publication" ADD CONSTRAINT "workspace_analysis_publication_org_replaces_fk" FOREIGN KEY ("organization_id","replaces_publication_id") REFERENCES "workspace_control"."workspace_analysis_publication"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_analysis_publication_slug_version_idx" ON "workspace_control"."workspace_analysis_publication" USING btree ("slug","version");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_analysis_publication_active_slug_idx" ON "workspace_control"."workspace_analysis_publication" USING btree ("slug") WHERE "workspace_control"."workspace_analysis_publication"."revoked_at" IS NULL;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_article_run" ADD CONSTRAINT "workspace_analysis_article_run_cancel" CHECK (("workspace_control"."workspace_analysis_article_run"."cancel_requested_at" IS NULL AND "workspace_control"."workspace_analysis_article_run"."cancel_requested_by_member_id" IS NULL)
        OR ("workspace_control"."workspace_analysis_article_run"."cancel_requested_at" IS NOT NULL
          AND "workspace_control"."workspace_analysis_article_run"."cancel_requested_by_member_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_publication" ADD CONSTRAINT "workspace_analysis_publication_snapshot" CHECK (jsonb_typeof("workspace_control"."workspace_analysis_publication"."snapshot") = 'object'
        AND "workspace_control"."workspace_analysis_publication"."snapshot_hash" ~ '^[0-9a-f]{64}$'
        AND "workspace_control"."workspace_analysis_publication"."version" >= 1);