ALTER TABLE "workspace_control"."workspace_metadata_backup" ADD COLUMN "reencrypted_by_rotation_id" uuid;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_metadata_backup" ADD CONSTRAINT "workspace_metadata_backup_org_rotation_fk" FOREIGN KEY ("organization_id","reencrypted_by_rotation_id") REFERENCES "workspace_control"."workspace_data_key_rotation"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "workspace_control"."validate_workspace_backup_reencryption"()
RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
    OR NEW."source_revision" IS DISTINCT FROM OLD."source_revision"
    OR NEW."snapshot_hash" IS DISTINCT FROM OLD."snapshot_hash"
    OR NEW."created_by_user_id" IS DISTINCT FROM OLD."created_by_user_id"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    OR NEW."deleted_at" IS DISTINCT FROM OLD."deleted_at"
    OR NEW."reencrypted_at" IS NULL
    OR NEW."reencrypted_by_rotation_id" IS NULL
    OR NEW."data_key_id" IS NULL
    OR NEW."key_reference" <> 'dopedb-workspace-data-key'
    OR NOT EXISTS (
      SELECT 1
      FROM "workspace_control"."workspace_data_key_rotation" rotation
      JOIN "workspace_control"."workspace_data_key" target
        ON target."organization_id" = rotation."organization_id"
       AND target."id" = rotation."to_data_key_id"
      WHERE rotation."id" = NEW."reencrypted_by_rotation_id"
        AND rotation."organization_id" = NEW."organization_id"
        AND rotation."status" = 'running'
        AND rotation."claim_id" IS NOT NULL
        AND rotation."claim_expires_at" > now()
        AND rotation."to_data_key_id" = NEW."data_key_id"
        AND NEW."key_version" = 'v' || target."version"::text
    )
  THEN
    RAISE EXCEPTION 'workspace backup payloads are immutable outside an active key rotation';
  END IF;
  RETURN NEW;
END; $$;--> statement-breakpoint
DROP TRIGGER "workspace_metadata_backup_payload_immutable"
ON "workspace_control"."workspace_metadata_backup";--> statement-breakpoint
CREATE TRIGGER "workspace_metadata_backup_payload_immutable"
BEFORE UPDATE OF "ciphertext", "snapshot_hash", "key_reference", "key_version", "source_revision", "data_key_id"
ON "workspace_control"."workspace_metadata_backup" FOR EACH ROW
EXECUTE FUNCTION "workspace_control"."validate_workspace_backup_reencryption"();
