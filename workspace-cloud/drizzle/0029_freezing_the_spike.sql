ALTER TABLE "workspace_control"."knowledge_project_environment" ADD COLUMN "risk_class" text DEFAULT 'custom' NOT NULL;--> statement-breakpoint
UPDATE "workspace_control"."knowledge_project_environment"
SET "risk_class" = 'production'
WHERE "production" = true;--> statement-breakpoint
ALTER TABLE "workspace_control"."knowledge_project_environment" ADD CONSTRAINT "knowledge_environment_risk_class" CHECK ("workspace_control"."knowledge_project_environment"."risk_class" IN ('production', 'staging', 'development', 'test', 'custom'));
