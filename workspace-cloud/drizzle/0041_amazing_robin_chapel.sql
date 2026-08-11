ALTER TABLE "workspace_control"."workspace_analysis_article_connection" DROP CONSTRAINT "workspace_analysis_article_connection_revision";--> statement-breakpoint
DROP INDEX "workspace_control"."workspace_analysis_article_connection_role_idx";--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_article_connection" DROP CONSTRAINT "workspace_analysis_article_connection_article_id_connection_id_pk";--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_article_graph" DROP CONSTRAINT "workspace_analysis_article_graph_article_id_graph_revision_id_pk";--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_article_connection" ADD COLUMN "article_revision" bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_article_graph" ADD COLUMN "article_revision" bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_article_connection" ADD CONSTRAINT "workspace_analysis_article_connection_article_id_article_revision_connection_id_pk" PRIMARY KEY("article_id","article_revision","connection_id");--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_article_graph" ADD CONSTRAINT "workspace_analysis_article_graph_article_id_article_revision_graph_revision_id_pk" PRIMARY KEY("article_id","article_revision","graph_revision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_analysis_article_connection_role_idx" ON "workspace_control"."workspace_analysis_article_connection" USING btree ("article_id","article_revision","role");--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_article_connection" ADD CONSTRAINT "workspace_analysis_article_connection_revision" CHECK ("workspace_control"."workspace_analysis_article_connection"."article_revision" >= 1 AND "workspace_control"."workspace_analysis_article_connection"."connection_revision" >= 1);--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_article_graph" ADD CONSTRAINT "workspace_analysis_article_graph_revision" CHECK ("workspace_control"."workspace_analysis_article_graph"."article_revision" >= 1);
