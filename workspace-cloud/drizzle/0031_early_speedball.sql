CREATE TABLE "workspace_control"."knowledge_grant_graph_revision" (
	"organization_id" text NOT NULL,
	"grant_id" uuid NOT NULL,
	"graph_revision_id" uuid NOT NULL,
	CONSTRAINT "knowledge_grant_graph_revision_grant_id_graph_revision_id_pk" PRIMARY KEY("grant_id","graph_revision_id")
);
--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_grant_graph_revision" ADD CONSTRAINT "knowledge_grant_graph_revision_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "workspace_control"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_grant_graph_revision" ADD CONSTRAINT "knowledge_grant_graph_revision_grant_id_knowledge_grant_id_fk" FOREIGN KEY ("grant_id") REFERENCES "workspace_control"."knowledge_grant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_grant_graph_revision" ADD CONSTRAINT "knowledge_grant_graph_revision_graph_revision_id_knowledge_graph_revision_id_fk" FOREIGN KEY ("graph_revision_id") REFERENCES "workspace_control"."knowledge_graph_revision"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_grant_org_id_idx" ON "workspace_control"."knowledge_grant" USING btree ("organization_id","id");--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_grant_graph_revision" ADD CONSTRAINT "knowledge_grant_graph_revision_org_grant_fk" FOREIGN KEY ("organization_id","grant_id") REFERENCES "workspace_control"."knowledge_grant"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_grant_graph_revision" ADD CONSTRAINT "knowledge_grant_graph_revision_org_graph_fk" FOREIGN KEY ("organization_id","graph_revision_id") REFERENCES "workspace_control"."knowledge_graph_revision"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
INSERT INTO "workspace_control"."knowledge_grant_graph_revision"
  ("organization_id", "grant_id", "graph_revision_id")
SELECT "organization_id", "id", "graph_revision_id"
FROM "workspace_control"."knowledge_grant";
