CREATE TABLE "workspace_control"."workspace_resource_conflict_resolution" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"conflict_id" uuid NOT NULL,
	"resolution" text NOT NULL,
	"resulting_version_id" uuid NOT NULL,
	"resolved_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_resource_conflict_resolution_value" CHECK ("workspace_control"."workspace_resource_conflict_resolution"."resolution" IN ('server', 'candidate', 'dismissed'))
);
--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_resource_conflict_resolution" ADD CONSTRAINT "workspace_resource_conflict_resolution_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "workspace_control"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_resource_conflict_resolution" ADD CONSTRAINT "workspace_resource_conflict_resolution_resolved_by_user_id_user_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "workspace_control"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_resource_conflict_resolution" ADD CONSTRAINT "workspace_resource_conflict_resolution_org_conflict_fk" FOREIGN KEY ("organization_id","conflict_id") REFERENCES "workspace_control"."workspace_resource_conflict"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_resource_conflict_resolution" ADD CONSTRAINT "workspace_resource_conflict_resolution_org_version_fk" FOREIGN KEY ("organization_id","resulting_version_id") REFERENCES "workspace_control"."workspace_resource_version"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_resource_conflict_resolution_org_id_idx" ON "workspace_control"."workspace_resource_conflict_resolution" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_resource_conflict_resolution_org_conflict_idx" ON "workspace_control"."workspace_resource_conflict_resolution" USING btree ("organization_id","conflict_id");--> statement-breakpoint
CREATE TRIGGER "workspace_resource_conflict_resolution_append_only" BEFORE UPDATE OR DELETE
ON "workspace_control"."workspace_resource_conflict_resolution" FOR EACH ROW
EXECUTE FUNCTION "workspace_control"."reject_workspace_version_mutation"();
