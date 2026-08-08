ALTER TABLE "workspace_control"."knowledge_environment_head"
  DROP CONSTRAINT IF EXISTS "knowledge_environment_head_pkey";
--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_environment_head"
  ADD COLUMN "source_id" uuid;
--> statement-breakpoint
UPDATE "workspace_control"."knowledge_environment_head" AS head
SET "source_id" = revision."source_id"
FROM "workspace_control"."knowledge_graph_revision" AS revision
WHERE revision."id" = head."graph_revision_id";
--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_environment_head"
  ALTER COLUMN "source_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_environment_head"
  ADD CONSTRAINT "knowledge_environment_head_project_environment_id_source_id_pk"
  PRIMARY KEY("project_environment_id", "source_id");
--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_environment_head"
  ADD CONSTRAINT "knowledge_environment_head_source_id_knowledge_source_id_fk"
  FOREIGN KEY ("source_id") REFERENCES "workspace_control"."knowledge_source"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_environment_head"
  ADD CONSTRAINT "knowledge_environment_head_org_source_fk"
  FOREIGN KEY ("organization_id", "source_id")
  REFERENCES "workspace_control"."knowledge_source"("organization_id", "id")
  ON DELETE cascade ON UPDATE no action;
