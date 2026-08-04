ALTER TABLE "workspace_control"."workspace_provider_import_request" ADD COLUMN "production_approved" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "workspace_control"."workspace_provider_import_request" AS imported
SET "production_approved" = TRUE
FROM "workspace_control"."workspace_audit_event" AS audit
WHERE audit."organization_id" = imported."organization_id"
  AND audit."resource_type" = 'connection'
  AND audit."resource_id" = imported."connection_id"::text
  AND audit."action" IN ('connection.provider_import', 'connection.provider_migrate')
  AND audit."redacted_summary" -> 'productionApproved' = 'true'::jsonb
  -- Both rows are inserted by one data-modifying statement, so PostgreSQL's
  -- transaction-stable now() gives an exact, non-heuristic witness match.
  AND audit."created_at" = imported."created_at";
