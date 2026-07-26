CREATE TABLE "workspace_control"."workspace_metadata_backup" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"source_revision" bigint NOT NULL,
	"key_reference" text NOT NULL,
	"key_version" text NOT NULL,
	"ciphertext" text NOT NULL,
	"snapshot_hash" text NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "workspace_metadata_backup_snapshot_hash" CHECK ("workspace_control"."workspace_metadata_backup"."snapshot_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "workspace_metadata_backup_source_revision" CHECK ("workspace_control"."workspace_metadata_backup"."source_revision" >= 1 AND "workspace_control"."workspace_metadata_backup"."source_revision" <= 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE "workspace_control"."workspace_resource_conflict" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" uuid NOT NULL,
	"expected_revision" bigint NOT NULL,
	"server_version_id" uuid NOT NULL,
	"candidate_version_id" uuid NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_resource_conflict_type" CHECK ("workspace_control"."workspace_resource_conflict"."resource_type" = 'connection'),
	CONSTRAINT "workspace_resource_conflict_expected_revision" CHECK ("workspace_control"."workspace_resource_conflict"."expected_revision" >= 0 AND "workspace_control"."workspace_resource_conflict"."expected_revision" <= 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE "workspace_control"."workspace_resource_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" uuid NOT NULL,
	"revision" bigint NOT NULL,
	"base_revision" bigint,
	"parent_version_id" uuid,
	"branch" text DEFAULT 'main' NOT NULL,
	"operation" text NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_resource_version_type" CHECK ("workspace_control"."workspace_resource_version"."resource_type" = 'connection'),
	CONSTRAINT "workspace_resource_version_branch" CHECK ("workspace_control"."workspace_resource_version"."branch" IN ('main', 'conflict')),
	CONSTRAINT "workspace_resource_version_revision" CHECK (("workspace_control"."workspace_resource_version"."branch" = 'main' AND "workspace_control"."workspace_resource_version"."revision" >= 1 AND "workspace_control"."workspace_resource_version"."revision" <= 9007199254740991)
        OR ("workspace_control"."workspace_resource_version"."branch" = 'conflict' AND "workspace_control"."workspace_resource_version"."revision" >= 0 AND "workspace_control"."workspace_resource_version"."revision" <= 9007199254740991)),
	CONSTRAINT "workspace_resource_version_base_revision" CHECK ("workspace_control"."workspace_resource_version"."base_revision" IS NULL OR ("workspace_control"."workspace_resource_version"."base_revision" >= 0 AND "workspace_control"."workspace_resource_version"."base_revision" <= 9007199254740991)),
	CONSTRAINT "workspace_resource_version_operation" CHECK ("workspace_control"."workspace_resource_version"."operation" IN ('create', 'update', 'delete', 'restore')),
	CONSTRAINT "workspace_resource_version_payload_hash" CHECK ("workspace_control"."workspace_resource_version"."payload_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_connection" ADD COLUMN "content_revision" bigint DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_resource_version_org_id_idx" ON "workspace_control"."workspace_resource_version" USING btree ("organization_id","id");--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_metadata_backup" ADD CONSTRAINT "workspace_metadata_backup_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "workspace_control"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_metadata_backup" ADD CONSTRAINT "workspace_metadata_backup_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "workspace_control"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_resource_conflict" ADD CONSTRAINT "workspace_resource_conflict_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "workspace_control"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_resource_conflict" ADD CONSTRAINT "workspace_resource_conflict_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "workspace_control"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_resource_conflict" ADD CONSTRAINT "workspace_resource_conflict_org_connection_fk" FOREIGN KEY ("organization_id","resource_id") REFERENCES "workspace_control"."workspace_connection"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_resource_conflict" ADD CONSTRAINT "workspace_resource_conflict_org_server_version_fk" FOREIGN KEY ("organization_id","server_version_id") REFERENCES "workspace_control"."workspace_resource_version"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_resource_conflict" ADD CONSTRAINT "workspace_resource_conflict_org_candidate_version_fk" FOREIGN KEY ("organization_id","candidate_version_id") REFERENCES "workspace_control"."workspace_resource_version"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_resource_version" ADD CONSTRAINT "workspace_resource_version_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "workspace_control"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_resource_version" ADD CONSTRAINT "workspace_resource_version_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "workspace_control"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_resource_version" ADD CONSTRAINT "workspace_resource_version_org_connection_fk" FOREIGN KEY ("organization_id","resource_id") REFERENCES "workspace_control"."workspace_connection"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_resource_version" ADD CONSTRAINT "workspace_resource_version_org_parent_fk" FOREIGN KEY ("organization_id","parent_version_id") REFERENCES "workspace_control"."workspace_resource_version"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_metadata_backup_org_id_idx" ON "workspace_control"."workspace_metadata_backup" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "workspace_metadata_backup_org_created_idx" ON "workspace_control"."workspace_metadata_backup" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_resource_conflict_org_id_idx" ON "workspace_control"."workspace_resource_conflict" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "workspace_resource_conflict_org_resource_idx" ON "workspace_control"."workspace_resource_conflict" USING btree ("organization_id","resource_type","resource_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_resource_version_main_revision_idx" ON "workspace_control"."workspace_resource_version" USING btree ("organization_id","resource_type","resource_id","revision") WHERE "branch" = 'main';--> statement-breakpoint
CREATE INDEX "workspace_resource_version_org_resource_created_idx" ON "workspace_control"."workspace_resource_version" USING btree ("organization_id","resource_type","resource_id","created_at");--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_connection" ADD CONSTRAINT "workspace_connection_content_revision" CHECK ("workspace_control"."workspace_connection"."content_revision" >= 1 AND "workspace_control"."workspace_connection"."content_revision" <= 9007199254740991);--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_connection" ADD CONSTRAINT "workspace_connection_revision" CHECK ("workspace_control"."workspace_connection"."revision" >= 1 AND "workspace_control"."workspace_connection"."revision" <= 9007199254740991);--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_profile" ADD CONSTRAINT "workspace_profile_revision" CHECK ("workspace_control"."workspace_profile"."revision" >= 1 AND "workspace_control"."workspace_profile"."revision" <= 9007199254740991);--> statement-breakpoint
WITH legacy AS (
  -- canonical_payload is byte-for-byte the alphabetical-key JSON emitted by
  -- workspace-versioning.ts canonicalJson(ConnectionVersionPayload).
  SELECT connection.*, jsonb_build_object(
    'name', connection."name", 'engine', connection."engine", 'provider', connection."provider",
    'driverId', connection."driver_id", 'host', connection."host", 'port', connection."port",
    'database', connection."database_name", 'sslmode', connection."sslmode",
    'readonlyDefault', connection."readonly_default", 'allowWrites', connection."allow_writes",
    'env', connection."environment", 'schemaGroup', connection."schema_group",
    'deleted', (connection."deleted_at" IS NOT NULL)
  ) AS payload,
  ('{"allowWrites":' || CASE WHEN connection."allow_writes" THEN 'true' ELSE 'false' END
    || ',"database":' || to_json(connection."database_name")::text
    || ',"deleted":' || CASE WHEN connection."deleted_at" IS NULL THEN 'false' ELSE 'true' END
    || ',"driverId":' || COALESCE(to_json(connection."driver_id")::text, 'null')
    || ',"engine":' || to_json(connection."engine")::text
    || ',"env":' || COALESCE(to_json(connection."environment")::text, 'null')
    || ',"host":' || to_json(connection."host")::text
    || ',"name":' || to_json(connection."name")::text
    || ',"port":' || connection."port"::text
    || ',"provider":' || to_json(connection."provider")::text
    || ',"readonlyDefault":' || CASE WHEN connection."readonly_default" THEN 'true' ELSE 'false' END
    || ',"schemaGroup":' || COALESCE(to_json(connection."schema_group")::text, 'null')
    || ',"sslmode":' || to_json(connection."sslmode")::text || '}') AS canonical_payload
  FROM "workspace_control"."workspace_connection" AS connection
)
INSERT INTO "workspace_control"."workspace_resource_version" (
  "organization_id", "resource_type", "resource_id", "revision", "branch", "operation",
  "payload", "payload_hash", "created_by_user_id", "created_at"
)
SELECT "organization_id", 'connection', "id", "content_revision", 'main',
  CASE WHEN "deleted_at" IS NULL THEN 'create' ELSE 'delete' END,
  payload, encode(digest(canonical_payload, 'sha256'), 'hex'), "created_by_user_id", "created_at"
FROM legacy;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "workspace_control"."reject_workspace_version_mutation"()
RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'workspace versions and conflicts are append-only';
END; $$;--> statement-breakpoint
CREATE TRIGGER "workspace_resource_version_append_only" BEFORE UPDATE OR DELETE
ON "workspace_control"."workspace_resource_version" FOR EACH ROW
EXECUTE FUNCTION "workspace_control"."reject_workspace_version_mutation"();--> statement-breakpoint
CREATE TRIGGER "workspace_resource_conflict_append_only" BEFORE UPDATE OR DELETE
ON "workspace_control"."workspace_resource_conflict" FOR EACH ROW
EXECUTE FUNCTION "workspace_control"."reject_workspace_version_mutation"();--> statement-breakpoint
CREATE TRIGGER "workspace_metadata_backup_payload_immutable"
BEFORE UPDATE OF "ciphertext", "snapshot_hash", "key_reference", "key_version", "source_revision"
ON "workspace_control"."workspace_metadata_backup" FOR EACH ROW
EXECUTE FUNCTION "workspace_control"."reject_workspace_version_mutation"();
