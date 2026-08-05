CREATE TABLE "workspace_control"."workspace_deletion_receipt" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"requested_by_user_id" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"purge_after" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"cancelled_at" timestamp with time zone,
	"purged_at" timestamp with time zone,
	CONSTRAINT "workspace_deletion_receipt_status" CHECK ("workspace_control"."workspace_deletion_receipt"."status" IN ('pending', 'cancelled', 'purged')),
	CONSTRAINT "workspace_deletion_receipt_deadline" CHECK ("workspace_control"."workspace_deletion_receipt"."purge_after" >= "workspace_control"."workspace_deletion_receipt"."requested_at" + interval '24 hours'),
	CONSTRAINT "workspace_deletion_receipt_terminal" CHECK (("workspace_control"."workspace_deletion_receipt"."status" = 'pending'
          AND "workspace_control"."workspace_deletion_receipt"."cancelled_at" IS NULL AND "workspace_control"."workspace_deletion_receipt"."purged_at" IS NULL)
        OR ("workspace_control"."workspace_deletion_receipt"."status" = 'cancelled'
          AND "workspace_control"."workspace_deletion_receipt"."cancelled_at" IS NOT NULL AND "workspace_control"."workspace_deletion_receipt"."purged_at" IS NULL)
        OR ("workspace_control"."workspace_deletion_receipt"."status" = 'purged'
          AND "workspace_control"."workspace_deletion_receipt"."cancelled_at" IS NULL AND "workspace_control"."workspace_deletion_receipt"."purged_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_metadata_backup" ADD COLUMN "purge_after" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_profile" ADD COLUMN "deletion_receipt_id" uuid;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_profile" ADD COLUMN "deletion_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_profile" ADD COLUMN "purge_after" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_deletion_receipt" ADD CONSTRAINT "workspace_deletion_receipt_requested_by_user_id_user_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "workspace_control"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_deletion_receipt_org_pending_idx" ON "workspace_control"."workspace_deletion_receipt" USING btree ("organization_id") WHERE "status" = 'pending';--> statement-breakpoint
CREATE INDEX "workspace_deletion_receipt_purge_idx" ON "workspace_control"."workspace_deletion_receipt" USING btree ("status","purge_after");--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_profile" ADD CONSTRAINT "workspace_profile_deletion_receipt_id_workspace_deletion_receipt_id_fk" FOREIGN KEY ("deletion_receipt_id") REFERENCES "workspace_control"."workspace_deletion_receipt"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_profile_lifecycle_purge_idx" ON "workspace_control"."workspace_profile" USING btree ("lifecycle_state","purge_after");--> statement-breakpoint
UPDATE "workspace_control"."workspace_metadata_backup"
SET "purge_after" = "deleted_at" + interval '7 days'
WHERE "deleted_at" IS NOT NULL AND "purge_after" IS NULL;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_metadata_backup" ADD CONSTRAINT "workspace_metadata_backup_retention" CHECK (("workspace_control"."workspace_metadata_backup"."deleted_at" IS NULL AND "workspace_control"."workspace_metadata_backup"."purge_after" IS NULL)
        OR ("workspace_control"."workspace_metadata_backup"."deleted_at" IS NOT NULL
          AND "workspace_control"."workspace_metadata_backup"."purge_after" IS NOT NULL
          AND "workspace_control"."workspace_metadata_backup"."purge_after" >= "workspace_control"."workspace_metadata_backup"."deleted_at"));--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_profile" ADD CONSTRAINT "workspace_profile_lifecycle" CHECK (("workspace_control"."workspace_profile"."lifecycle_state" = 'active'
        AND "workspace_control"."workspace_profile"."deletion_receipt_id" IS NULL
        AND "workspace_control"."workspace_profile"."deletion_requested_at" IS NULL
        AND "workspace_control"."workspace_profile"."purge_after" IS NULL)
      OR ("workspace_control"."workspace_profile"."lifecycle_state" = 'deletion_pending'
        AND "workspace_control"."workspace_profile"."deletion_receipt_id" IS NOT NULL
        AND "workspace_control"."workspace_profile"."deletion_requested_at" IS NOT NULL
        AND "workspace_control"."workspace_profile"."purge_after" IS NOT NULL
        AND "workspace_control"."workspace_profile"."purge_after" >= "workspace_control"."workspace_profile"."deletion_requested_at" + interval '24 hours'));--> statement-breakpoint
CREATE OR REPLACE FUNCTION "workspace_control"."purge_due_workspace"(
  target_organization_id text,
  target_receipt_id uuid
) RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, workspace_control
AS $$
DECLARE
  eligible boolean;
BEGIN
  SELECT TRUE INTO eligible
  FROM workspace_control.workspace_profile profile
  JOIN workspace_control.workspace_deletion_receipt receipt
    ON receipt.id = profile.deletion_receipt_id
   AND receipt.organization_id = profile.organization_id
  WHERE profile.organization_id = target_organization_id
    AND profile.lifecycle_state = 'deletion_pending'
    AND profile.deletion_receipt_id = target_receipt_id
    AND profile.purge_after <= now()
    AND receipt.status = 'pending'
    AND receipt.purge_after <= now()
  FOR UPDATE OF profile, receipt;

  IF eligible IS DISTINCT FROM TRUE THEN
    RETURN FALSE;
  END IF;

  IF EXISTS (
    SELECT 1 FROM workspace_control.workspace_credential_lease lease
    WHERE lease.organization_id = target_organization_id
      AND lease.revoked_at IS NULL
  ) OR EXISTS (
    SELECT 1 FROM workspace_control.workspace_provider_integration integration
    WHERE integration.organization_id = target_organization_id
      AND integration.revoked_at IS NULL
  ) OR EXISTS (
    SELECT 1 FROM workspace_control.workspace_provider_operation operation
    WHERE operation.organization_id = target_organization_id
      AND operation.state NOT IN ('succeeded', 'failed', 'cancelled')
  ) OR EXISTS (
    SELECT 1 FROM workspace_control.workspace_data_key_rotation rotation
    WHERE rotation.organization_id = target_organization_id
      AND rotation.status = 'running'
  ) OR EXISTS (
    SELECT 1 FROM workspace_control.member member
    WHERE member.organization_id = target_organization_id
      AND member.revocation_claim_id IS NOT NULL
  ) THEN
    RETURN FALSE;
  END IF;

  DELETE FROM workspace_control.workspace_metadata_backup
  WHERE organization_id = target_organization_id;

  DELETE FROM workspace_control.workspace_data_key_rotation
  WHERE organization_id = target_organization_id;

  DELETE FROM workspace_control.workspace_data_key
  WHERE organization_id = target_organization_id;

  UPDATE workspace_control.workspace_deletion_receipt
  SET status = 'purged', purged_at = now()
  WHERE id = target_receipt_id
    AND organization_id = target_organization_id
    AND status = 'pending';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace deletion receipt changed during purge';
  END IF;

  DELETE FROM workspace_control.organization
  WHERE id = target_organization_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace disappeared during purge';
  END IF;

  RETURN TRUE;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "workspace_control"."purge_due_workspace"(text, uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "workspace_control"."purge_due_workspace"(text, uuid) TO CURRENT_USER;
