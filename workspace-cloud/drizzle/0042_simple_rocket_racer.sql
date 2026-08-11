ALTER TABLE "workspace_control"."workspace_analysis_article" DROP CONSTRAINT "workspace_analysis_article_revisions";--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_article" ADD COLUMN "live_revision" bigint;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_article" ADD CONSTRAINT "workspace_analysis_article_revisions" CHECK ("workspace_control"."workspace_analysis_article"."environment_revision" >= 1
        AND "workspace_control"."workspace_analysis_article"."revision" >= 1
        AND "workspace_control"."workspace_analysis_article"."revision" <= 9007199254740991
        AND ("workspace_control"."workspace_analysis_article"."live_revision" IS NULL
          OR ("workspace_control"."workspace_analysis_article"."live_revision" >= 1 AND "workspace_control"."workspace_analysis_article"."live_revision" <= "workspace_control"."workspace_analysis_article"."revision")));