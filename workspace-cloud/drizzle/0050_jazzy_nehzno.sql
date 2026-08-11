-- 0049 has already copied every legacy record and its history into the
-- integrity-hashed, non-executable recovery archive. Drop children before their
-- parents and avoid CASCADE so an unexpected new dependency fails closed.
DROP TABLE "workspace_control"."workspace_dashboard_revision";--> statement-breakpoint
DROP TABLE "workspace_control"."workspace_dashboard";--> statement-breakpoint
DROP TABLE "workspace_control"."workspace_report_evidence";--> statement-breakpoint
DROP TABLE "workspace_control"."workspace_report_revision";--> statement-breakpoint
DROP TABLE "workspace_control"."workspace_report";--> statement-breakpoint
DROP FUNCTION "workspace_control"."reject_workspace_report_immutable_update"();--> statement-breakpoint
DROP TABLE "workspace_control"."workspace_signal_notification";--> statement-breakpoint
DROP TABLE "workspace_control"."workspace_signal_evaluation_receipt";--> statement-breakpoint
DROP TABLE "workspace_control"."workspace_signal_runner_lease";--> statement-breakpoint
DROP TABLE "workspace_control"."workspace_signal_rule_connection";--> statement-breakpoint
DROP TABLE "workspace_control"."workspace_signal_rule_revision";--> statement-breakpoint
DROP TABLE "workspace_control"."workspace_signal_rule";--> statement-breakpoint
DROP TABLE "workspace_control"."workspace_signal_runner";--> statement-breakpoint
DROP TABLE "workspace_control"."workspace_funnel_analysis_connection";--> statement-breakpoint
DROP TABLE "workspace_control"."workspace_funnel_analysis_graph";--> statement-breakpoint
DROP TABLE "workspace_control"."workspace_funnel_analysis_revision";--> statement-breakpoint
DROP TABLE "workspace_control"."workspace_funnel_analysis";--> statement-breakpoint

-- Article revision pins, query receipts, encrypted result fragments, and Signal
-- receipts are evidence. Application code never edits them; make that invariant
-- database-owned so a future code path cannot rewrite history accidentally.
CREATE FUNCTION "workspace_control"."reject_analysis_evidence_update"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, workspace_control
AS $$
BEGIN
  RAISE EXCEPTION 'Analysis Article evidence is immutable';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "workspace_analysis_article_connection_immutable_update"
BEFORE UPDATE ON "workspace_control"."workspace_analysis_article_connection"
FOR EACH ROW EXECUTE FUNCTION "workspace_control"."reject_analysis_evidence_update"();--> statement-breakpoint
CREATE TRIGGER "workspace_analysis_article_graph_immutable_update"
BEFORE UPDATE ON "workspace_control"."workspace_analysis_article_graph"
FOR EACH ROW EXECUTE FUNCTION "workspace_control"."reject_analysis_evidence_update"();--> statement-breakpoint
CREATE TRIGGER "workspace_analysis_article_revision_immutable_update"
BEFORE UPDATE ON "workspace_control"."workspace_analysis_article_revision"
FOR EACH ROW EXECUTE FUNCTION "workspace_control"."reject_analysis_evidence_update"();--> statement-breakpoint
CREATE TRIGGER "workspace_analysis_query_receipt_immutable_update"
BEFORE UPDATE ON "workspace_control"."workspace_analysis_article_query_receipt"
FOR EACH ROW EXECUTE FUNCTION "workspace_control"."reject_analysis_evidence_update"();--> statement-breakpoint
CREATE TRIGGER "workspace_analysis_result_fragment_immutable_update"
BEFORE UPDATE ON "workspace_control"."workspace_analysis_result_fragment"
FOR EACH ROW EXECUTE FUNCTION "workspace_control"."reject_analysis_evidence_update"();--> statement-breakpoint
CREATE TRIGGER "workspace_analysis_signal_revision_immutable_update"
BEFORE UPDATE ON "workspace_control"."workspace_analysis_signal_revision"
FOR EACH ROW EXECUTE FUNCTION "workspace_control"."reject_analysis_evidence_update"();--> statement-breakpoint
CREATE TRIGGER "workspace_analysis_signal_receipt_immutable_update"
BEFORE UPDATE ON "workspace_control"."workspace_analysis_signal_receipt"
FOR EACH ROW EXECUTE FUNCTION "workspace_control"."reject_analysis_evidence_update"();--> statement-breakpoint

-- A fixed public snapshot can only move once from active to revoked. Publishing
-- a replacement creates a new row and never mutates the approved bytes.
CREATE FUNCTION "workspace_control"."enforce_analysis_publication_revocation"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, workspace_control
AS $$
BEGIN
  IF (to_jsonb(NEW) - 'revoked_at') IS DISTINCT FROM (to_jsonb(OLD) - 'revoked_at')
    OR OLD."revoked_at" IS NOT NULL
    OR NEW."revoked_at" IS NULL
    OR NEW."revoked_at" < OLD."published_at" THEN
    RAISE EXCEPTION 'Analysis Article publication snapshots are immutable';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "workspace_analysis_publication_revoke_only_update"
BEFORE UPDATE ON "workspace_control"."workspace_analysis_publication"
FOR EACH ROW EXECUTE FUNCTION "workspace_control"."enforce_analysis_publication_revocation"();--> statement-breakpoint

-- Recovery payloads are permanent evidence. Resolution may be bound exactly
-- once to a separately reviewed Article; no archived byte can be rewritten.
CREATE FUNCTION "workspace_control"."enforce_analysis_migration_resolution"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, workspace_control
AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['resolved_article_id', 'resolved_by_member_id', 'resolved_at'])
      IS DISTINCT FROM
      (to_jsonb(OLD) - ARRAY['resolved_article_id', 'resolved_by_member_id', 'resolved_at'])
    OR OLD."resolved_article_id" IS NOT NULL
    OR OLD."resolved_by_member_id" IS NOT NULL
    OR OLD."resolved_at" IS NOT NULL
    OR NEW."resolved_article_id" IS NULL
    OR NEW."resolved_by_member_id" IS NULL
    OR NEW."resolved_at" IS NULL THEN
    RAISE EXCEPTION 'Analysis legacy recovery evidence is immutable';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "workspace_analysis_migration_resolution_only_update"
BEFORE UPDATE ON "workspace_control"."workspace_analysis_migration_failure"
FOR EACH ROW EXECUTE FUNCTION "workspace_control"."enforce_analysis_migration_resolution"();
