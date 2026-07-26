CREATE TABLE "workspace_control"."workspace_connection_grant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"member_id" text NOT NULL,
	"capability" text DEFAULT 'view' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_connection_grant_capability" CHECK ("workspace_control"."workspace_connection_grant"."capability" IN ('view', 'use', 'manage'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "member_organization_id_idx" ON "workspace_control"."member" USING btree ("organization_id","id");--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_connection_grant" ADD CONSTRAINT "workspace_connection_grant_org_connection_fk" FOREIGN KEY ("organization_id","connection_id") REFERENCES "workspace_control"."workspace_connection"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_connection_grant" ADD CONSTRAINT "workspace_connection_grant_org_member_fk" FOREIGN KEY ("organization_id","member_id") REFERENCES "workspace_control"."member"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_connection_grant_org_connection_member_idx" ON "workspace_control"."workspace_connection_grant" USING btree ("organization_id","connection_id","member_id");--> statement-breakpoint
-- Bootstrap explicit grants for existing administrators/owners once. Subsequent
-- workspace-role changes do not create target-database authority implicitly.
INSERT INTO "workspace_control"."workspace_connection_grant"
  ("organization_id", "connection_id", "member_id", "capability")
SELECT connection."organization_id", connection."id", member."id", 'manage'
FROM "workspace_control"."workspace_connection" AS connection
JOIN "workspace_control"."member" AS member
  ON member."organization_id" = connection."organization_id"
WHERE member."role" IN ('admin', 'owner')
  AND member."revocation_pending_at" IS NULL
  AND member."revocation_claim_id" IS NULL
ON CONFLICT ("organization_id", "connection_id", "member_id") DO NOTHING;--> statement-breakpoint
CREATE INDEX "workspace_connection_grant_org_member_idx" ON "workspace_control"."workspace_connection_grant" USING btree ("organization_id","member_id");--> statement-breakpoint
-- Earlier shared member-local templates could opt into writes. Normalize them
-- before enforcing the new invariant and append a matching immutable version;
-- mutating the projection without the version would corrupt #22 history.
WITH normalized AS (
  UPDATE "workspace_control"."workspace_connection" AS connection
  SET "readonly_default" = TRUE,
      "allow_writes" = FALSE,
      "content_revision" = connection."content_revision" + 1,
      "updated_at" = now()
  WHERE connection."credential_mode" = 'member_local'
    AND (
      connection."readonly_default" IS DISTINCT FROM TRUE
      OR connection."allow_writes" IS DISTINCT FROM FALSE
    )
  RETURNING connection.*
), payloads AS (
  SELECT connection.*,
    jsonb_build_object(
      'name', connection."name", 'engine', connection."engine", 'provider', connection."provider",
      'driverId', connection."driver_id", 'host', connection."host", 'port', connection."port",
      'database', connection."database_name", 'sslmode', connection."sslmode",
      'readonlyDefault', connection."readonly_default", 'allowWrites', connection."allow_writes",
      'env', connection."environment", 'schemaGroup', connection."schema_group",
      'deleted', (connection."deleted_at" IS NOT NULL)
    ) AS payload,
    ('{"allowWrites":false'
      || ',"database":' || to_json(connection."database_name")::text
      || ',"deleted":' || CASE WHEN connection."deleted_at" IS NULL THEN 'false' ELSE 'true' END
      || ',"driverId":' || COALESCE(to_json(connection."driver_id")::text, 'null')
      || ',"engine":' || to_json(connection."engine")::text
      || ',"env":' || COALESCE(to_json(connection."environment")::text, 'null')
      || ',"host":' || to_json(connection."host")::text
      || ',"name":' || to_json(connection."name")::text
      || ',"port":' || connection."port"::text
      || ',"provider":' || to_json(connection."provider")::text
      || ',"readonlyDefault":true'
      || ',"schemaGroup":' || COALESCE(to_json(connection."schema_group")::text, 'null')
      || ',"sslmode":' || to_json(connection."sslmode")::text || '}') AS canonical_payload
  FROM normalized AS connection
), parents AS (
  SELECT payloads.*, version."id" AS parent_version_id
  FROM payloads
  JOIN "workspace_control"."workspace_resource_version" AS version
    ON version."organization_id" = payloads."organization_id"
    AND version."resource_type" = 'connection'
    AND version."resource_id" = payloads."id"
    AND version."branch" = 'main'
    AND version."revision" = payloads."content_revision" - 1
)
INSERT INTO "workspace_control"."workspace_resource_version" (
  "id", "organization_id", "resource_type", "resource_id", "revision", "base_revision",
  "parent_version_id", "branch", "operation", "payload", "payload_hash", "created_by_user_id", "created_at"
)
SELECT gen_random_uuid(), "organization_id", 'connection', "id", "content_revision",
  "content_revision" - 1, parent_version_id, 'main', 'update', payload,
  encode(digest(canonical_payload, 'sha256'), 'hex'), "created_by_user_id", "updated_at"
FROM parents;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_connection" ADD CONSTRAINT "workspace_connection_member_local_read_only" CHECK (("workspace_control"."workspace_connection"."credential_mode" = 'member_local' AND "workspace_control"."workspace_connection"."readonly_default" = TRUE AND "workspace_control"."workspace_connection"."allow_writes" = FALSE) OR "workspace_control"."workspace_connection"."credential_mode" = 'managed');
