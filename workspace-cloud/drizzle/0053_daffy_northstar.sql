DROP INDEX "workspace_control"."workspace_analysis_runner_org_device_idx";--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_runner" DROP CONSTRAINT "workspace_analysis_runner_org_member_fk";--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_article_run" DROP CONSTRAINT "workspace_analysis_article_run_org_requester_fk";--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_article_run" DROP CONSTRAINT "workspace_analysis_article_run_org_cancel_requester_fk";--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_publication" DROP CONSTRAINT "workspace_analysis_publication_org_approver_fk";--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_signal" DROP CONSTRAINT "workspace_analysis_signal_org_owner_fk";--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_signal_revision" DROP CONSTRAINT "workspace_analysis_signal_revision_org_member_fk";--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_runner" ALTER COLUMN "member_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_publication" ALTER COLUMN "approved_by_member_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_signal" ALTER COLUMN "owner_member_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_signal_revision" ALTER COLUMN "created_by_member_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_article_run" ADD COLUMN "runner_capability_generation" bigint;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_refresh_lease" ADD COLUMN "runner_capability_generation" bigint;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_runner" ADD COLUMN "runner_capability_hash" text;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_runner" ADD COLUMN "runner_capability_generation" bigint;--> statement-breakpoint
-- Membership removal clears only historical attribution. Preserve every other
-- immutable publication/revision byte while allowing the FK action to set the
-- departed member reference to NULL.
CREATE OR REPLACE FUNCTION "workspace_control"."enforce_analysis_publication_revocation"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, workspace_control
AS $$
BEGIN
  IF OLD."approved_by_member_id" IS NOT NULL
    AND NEW."approved_by_member_id" IS NULL
    AND (to_jsonb(NEW) - 'approved_by_member_id')
      IS NOT DISTINCT FROM (to_jsonb(OLD) - 'approved_by_member_id') THEN
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - 'revoked_at') IS DISTINCT FROM (to_jsonb(OLD) - 'revoked_at')
    OR OLD."revoked_at" IS NOT NULL
    OR NEW."revoked_at" IS NULL
    OR NEW."revoked_at" < OLD."published_at" THEN
    RAISE EXCEPTION 'Analysis Article publication snapshots are immutable';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE FUNCTION "workspace_control"."enforce_analysis_signal_revision_attribution"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, workspace_control
AS $$
BEGIN
  IF OLD."created_by_member_id" IS NOT NULL
    AND NEW."created_by_member_id" IS NULL
    AND (to_jsonb(NEW) - 'created_by_member_id')
      IS NOT DISTINCT FROM (to_jsonb(OLD) - 'created_by_member_id') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Analysis evidence rows are immutable';
END;
$$;--> statement-breakpoint
DROP TRIGGER "workspace_analysis_signal_revision_immutable_update"
ON "workspace_control"."workspace_analysis_signal_revision";--> statement-breakpoint
CREATE TRIGGER "workspace_analysis_signal_revision_immutable_update"
BEFORE UPDATE ON "workspace_control"."workspace_analysis_signal_revision"
FOR EACH ROW EXECUTE FUNCTION "workspace_control"."enforce_analysis_signal_revision_attribution"();--> statement-breakpoint
-- Existing runners have no proof of possession. Never bootstrap a capability
-- onto the same row: quarantine them and require Desktop to register a fresh
-- row. Article schedules keep their old runner id and must be reassigned by a
-- human; the migration never moves authority implicitly.
UPDATE "workspace_control"."workspace_analysis_article_run"
SET "state" = 'stale', "finished_at" = now(),
	"error_kind" = 'runner_capability_required',
	"error_message" = 'The legacy Desktop runner was quarantined during the possession-capability migration.'
WHERE "runner_capability_generation" IS NULL
	AND "state" IN ('queued', 'running');--> statement-breakpoint
DELETE FROM "workspace_control"."workspace_analysis_result_fragment" fragment
USING "workspace_control"."workspace_analysis_article_run" run
WHERE fragment."organization_id" = run."organization_id"
	AND fragment."run_id" = run."id"
	AND run."runner_capability_generation" IS NULL
	AND run."error_kind" = 'runner_capability_required';--> statement-breakpoint
DELETE FROM "workspace_control"."workspace_analysis_article_query_receipt" receipt
USING "workspace_control"."workspace_analysis_article_run" run
WHERE receipt."organization_id" = run."organization_id"
	AND receipt."run_id" = run."id"
	AND run."runner_capability_generation" IS NULL
	AND run."error_kind" = 'runner_capability_required';--> statement-breakpoint
UPDATE "workspace_control"."workspace_analysis_refresh_lease"
SET "revoked_at" = COALESCE("revoked_at", now())
WHERE "runner_capability_generation" IS NULL
	AND "completed_at" IS NULL;--> statement-breakpoint
UPDATE "workspace_control"."workspace_analysis_runner"
SET "revoked_at" = COALESCE("revoked_at", now())
WHERE "runner_capability_hash" IS NULL
	OR "runner_capability_generation" IS NULL;--> statement-breakpoint
UPDATE "workspace_control"."workspace_analysis_article" article
SET "next_refresh_at" = NULL
WHERE article."deleted_at" IS NULL
	AND article."definition"->'refresh'->>'mode' = 'scheduled'
	AND EXISTS (
		SELECT 1
		FROM "workspace_control"."workspace_analysis_runner" runner
		WHERE runner."organization_id" = article."organization_id"
			AND runner."id"::text = article."definition"->'refresh'->>'runnerId'
			AND runner."runner_capability_hash" IS NULL
			AND runner."runner_capability_generation" IS NULL
	);--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_analysis_runner_org_device_idx" ON "workspace_control"."workspace_analysis_runner" USING btree ("organization_id","device_id") WHERE "workspace_control"."workspace_analysis_runner"."revoked_at" IS NULL;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_runner" ADD CONSTRAINT "workspace_analysis_runner_org_member_fk" FOREIGN KEY ("organization_id","member_id") REFERENCES "workspace_control"."member"("organization_id","id") ON DELETE SET NULL ("member_id") ON UPDATE NO ACTION;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_article_run" ADD CONSTRAINT "workspace_analysis_article_run_org_requester_fk" FOREIGN KEY ("organization_id","requested_by_member_id") REFERENCES "workspace_control"."member"("organization_id","id") ON DELETE SET NULL ("requested_by_member_id") ON UPDATE NO ACTION;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_article_run" ADD CONSTRAINT "workspace_analysis_article_run_org_cancel_requester_fk" FOREIGN KEY ("organization_id","cancel_requested_by_member_id") REFERENCES "workspace_control"."member"("organization_id","id") ON DELETE SET NULL ("cancel_requested_by_member_id") ON UPDATE NO ACTION;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_publication" ADD CONSTRAINT "workspace_analysis_publication_org_approver_fk" FOREIGN KEY ("organization_id","approved_by_member_id") REFERENCES "workspace_control"."member"("organization_id","id") ON DELETE SET NULL ("approved_by_member_id") ON UPDATE NO ACTION;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_signal" ADD CONSTRAINT "workspace_analysis_signal_org_owner_fk" FOREIGN KEY ("organization_id","owner_member_id") REFERENCES "workspace_control"."member"("organization_id","id") ON DELETE SET NULL ("owner_member_id") ON UPDATE NO ACTION;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_signal_revision" ADD CONSTRAINT "workspace_analysis_signal_revision_org_member_fk" FOREIGN KEY ("organization_id","created_by_member_id") REFERENCES "workspace_control"."member"("organization_id","id") ON DELETE SET NULL ("created_by_member_id") ON UPDATE NO ACTION;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_article_run" DROP CONSTRAINT "workspace_analysis_article_run_cancel";--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_article_run" ADD CONSTRAINT "workspace_analysis_article_run_cancel" CHECK (("workspace_control"."workspace_analysis_article_run"."cancel_requested_at" IS NULL AND "workspace_control"."workspace_analysis_article_run"."cancel_requested_by_member_id" IS NULL)
        OR "workspace_control"."workspace_analysis_article_run"."cancel_requested_at" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_article_run" ADD CONSTRAINT "workspace_analysis_article_run_runner_capability" CHECK (("workspace_control"."workspace_analysis_article_run"."runner_capability_generation" >= 1
          AND "workspace_control"."workspace_analysis_article_run"."runner_capability_generation" <= 9007199254740991)
        OR ("workspace_control"."workspace_analysis_article_run"."runner_capability_generation" IS NULL
          AND "workspace_control"."workspace_analysis_article_run"."state" IN ('succeeded', 'failed', 'cancelled', 'stale')));--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_refresh_lease" ADD CONSTRAINT "workspace_analysis_refresh_lease_runner_capability" CHECK (("workspace_control"."workspace_analysis_refresh_lease"."runner_capability_generation" >= 1
          AND "workspace_control"."workspace_analysis_refresh_lease"."runner_capability_generation" <= 9007199254740991)
        OR ("workspace_control"."workspace_analysis_refresh_lease"."runner_capability_generation" IS NULL
          AND ("workspace_control"."workspace_analysis_refresh_lease"."completed_at" IS NOT NULL OR "workspace_control"."workspace_analysis_refresh_lease"."revoked_at" IS NOT NULL)));--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_runner" ADD CONSTRAINT "workspace_analysis_runner_capability" CHECK ((
          "workspace_control"."workspace_analysis_runner"."runner_capability_hash" ~ '^[0-9a-f]{64}$'
          AND "workspace_control"."workspace_analysis_runner"."runner_capability_generation" >= 1
          AND "workspace_control"."workspace_analysis_runner"."runner_capability_generation" <= 9007199254740991
        ) OR (
          "workspace_control"."workspace_analysis_runner"."runner_capability_hash" IS NULL
          AND "workspace_control"."workspace_analysis_runner"."runner_capability_generation" IS NULL
          AND "workspace_control"."workspace_analysis_runner"."revoked_at" IS NOT NULL
        ));--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_runner" ADD CONSTRAINT "workspace_analysis_runner_member" CHECK ("workspace_control"."workspace_analysis_runner"."member_id" IS NOT NULL
        OR "workspace_control"."workspace_analysis_runner"."revoked_at" IS NOT NULL);
