CREATE TABLE "workspace_control"."workspace_analysis_migration_failure" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" uuid NOT NULL,
	"source_revision" bigint NOT NULL,
	"title" text NOT NULL,
	"project_environment_id" uuid,
	"owner_member_id" text,
	"payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"failure_reason" text NOT NULL,
	"original_created_at" timestamp with time zone,
	"archived_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_article_id" uuid,
	"resolved_by_member_id" text,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "workspace_analysis_migration_failure_kind" CHECK ("workspace_control"."workspace_analysis_migration_failure"."source_kind" IN ('dashboard', 'funnel_analysis', 'report', 'signal')),
	CONSTRAINT "workspace_analysis_migration_failure_revision" CHECK ("workspace_control"."workspace_analysis_migration_failure"."source_revision" >= 1 AND "workspace_control"."workspace_analysis_migration_failure"."source_revision" <= 9007199254740991),
	CONSTRAINT "workspace_analysis_migration_failure_text" CHECK (char_length(btrim("workspace_control"."workspace_analysis_migration_failure"."title")) BETWEEN 1 AND 256
        AND char_length("workspace_control"."workspace_analysis_migration_failure"."failure_reason") BETWEEN 1 AND 2000),
	CONSTRAINT "workspace_analysis_migration_failure_payload" CHECK (jsonb_typeof("workspace_control"."workspace_analysis_migration_failure"."payload") = 'object'
        AND "workspace_control"."workspace_analysis_migration_failure"."payload_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "workspace_analysis_migration_failure_resolution" CHECK (("workspace_control"."workspace_analysis_migration_failure"."resolved_article_id" IS NULL
          AND "workspace_control"."workspace_analysis_migration_failure"."resolved_by_member_id" IS NULL
          AND "workspace_control"."workspace_analysis_migration_failure"."resolved_at" IS NULL)
        OR ("workspace_control"."workspace_analysis_migration_failure"."resolved_article_id" IS NOT NULL
          AND "workspace_control"."workspace_analysis_migration_failure"."resolved_by_member_id" IS NOT NULL
          AND "workspace_control"."workspace_analysis_migration_failure"."resolved_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_analysis_migration_failure" ADD CONSTRAINT "workspace_analysis_migration_failure_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "workspace_control"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_analysis_migration_failure_org_id_idx" ON "workspace_control"."workspace_analysis_migration_failure" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_analysis_migration_failure_source_idx" ON "workspace_control"."workspace_analysis_migration_failure" USING btree ("organization_id","source_kind","source_id");--> statement-breakpoint
CREATE INDEX "workspace_analysis_migration_failure_unresolved_idx" ON "workspace_control"."workspace_analysis_migration_failure" USING btree ("organization_id","resolved_at","archived_at");--> statement-breakpoint

-- A legacy Dashboard does not declare an exact output schema or sensitivity
-- decisions, so making it executable as an Article would silently widen trust.
-- Preserve the complete current projection, revision history, and every possible
-- Environment binding for explicit recovery instead.
WITH archived AS (
  SELECT dashboard."organization_id", dashboard."id" AS "source_id",
    dashboard."revision" AS "source_revision", dashboard."title",
    CASE WHEN jsonb_array_length(environment."candidates") = 1
      THEN (environment."candidates"->0->>'projectEnvironmentId')::uuid
      ELSE NULL
    END AS "project_environment_id",
    dashboard."owner_member_id", dashboard."created_at" AS "original_created_at",
    jsonb_build_object(
      'version', 1,
      'sourceKind', 'dashboard',
      'current', to_jsonb(dashboard),
      'revisions', COALESCE((
        SELECT jsonb_agg(to_jsonb(revision) ORDER BY revision."revision")
        FROM "workspace_control"."workspace_dashboard_revision" revision
        WHERE revision."organization_id" = dashboard."organization_id"
          AND revision."dashboard_id" = dashboard."id"
      ), '[]'::jsonb),
      'environmentCandidates', environment."candidates"
    ) AS "payload",
    'Legacy Dashboard lacks the declared output columns, semantic types, sensitivity, and masking required by an executable Analysis Article.'
      || CASE jsonb_array_length(environment."candidates")
        WHEN 0 THEN ' No active Project Environment contains its connection.'
        WHEN 1 THEN ''
        ELSE ' Its connection belongs to more than one active Project Environment.'
      END AS "failure_reason"
  FROM "workspace_control"."workspace_dashboard" dashboard
  CROSS JOIN LATERAL (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'projectEnvironmentId', binding."project_environment_id",
      'environmentRevision', binding."environment_revision",
      'connectionRevision', binding."connection_revision",
      'role', binding."role",
      'alias', binding."alias"
    ) ORDER BY binding."project_environment_id"), '[]'::jsonb) AS "candidates"
    FROM "workspace_control"."knowledge_environment_connection" binding
    WHERE binding."organization_id" = dashboard."organization_id"
      AND binding."connection_id" = dashboard."connection_id"
      AND binding."revoked_at" IS NULL
  ) environment
), inserted AS (
  INSERT INTO "workspace_control"."workspace_analysis_migration_failure"
    ("organization_id", "source_kind", "source_id", "source_revision", "title",
     "project_environment_id", "owner_member_id", "payload", "payload_hash",
     "failure_reason", "original_created_at")
  SELECT "organization_id", 'dashboard', "source_id", "source_revision", "title",
    "project_environment_id", "owner_member_id", "payload",
    encode(digest(convert_to("payload"::text, 'UTF8'), 'sha256'), 'hex'),
    "failure_reason", "original_created_at"
  FROM archived
  ON CONFLICT ("organization_id", "source_kind", "source_id") DO NOTHING
  RETURNING "id"
)
SELECT count(*) FROM inserted;--> statement-breakpoint

-- Reports retain their immutable evidence receipts, but old evidence omits the
-- result column contract and Environment authority required for safe reruns.
WITH archived AS (
  SELECT report."organization_id", report."id" AS "source_id",
    report."revision" AS "source_revision", report."title",
    CASE WHEN jsonb_array_length(environment."candidates") = 1
      THEN (environment."candidates"->0->>'projectEnvironmentId')::uuid
      ELSE NULL
    END AS "project_environment_id",
    report."owner_member_id", report."created_at" AS "original_created_at",
    jsonb_build_object(
      'version', 1,
      'sourceKind', 'report',
      'current', to_jsonb(report),
      'revisions', COALESCE((
        SELECT jsonb_agg(to_jsonb(revision) ORDER BY revision."revision")
        FROM "workspace_control"."workspace_report_revision" revision
        WHERE revision."organization_id" = report."organization_id"
          AND revision."report_id" = report."id"
      ), '[]'::jsonb),
      'evidence', COALESCE((
        SELECT jsonb_agg(to_jsonb(evidence) ORDER BY evidence."created_at", evidence."id")
        FROM "workspace_control"."workspace_report_evidence" evidence
        WHERE evidence."organization_id" = report."organization_id"
          AND evidence."report_id" = report."id"
      ), '[]'::jsonb),
      'environmentCandidates', environment."candidates"
    ) AS "payload",
    'Legacy Report evidence lacks the declared result columns, semantic types, sensitivity, masking, and deterministic block graph required by an executable Analysis Article.'
      || CASE jsonb_array_length(environment."candidates")
        WHEN 0 THEN ' No active Project Environment contains its connection.'
        WHEN 1 THEN ''
        ELSE ' Its connection belongs to more than one active Project Environment.'
      END AS "failure_reason"
  FROM "workspace_control"."workspace_report" report
  CROSS JOIN LATERAL (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'projectEnvironmentId', binding."project_environment_id",
      'environmentRevision', binding."environment_revision",
      'connectionRevision', binding."connection_revision",
      'role', binding."role",
      'alias', binding."alias"
    ) ORDER BY binding."project_environment_id"), '[]'::jsonb) AS "candidates"
    FROM "workspace_control"."knowledge_environment_connection" binding
    WHERE binding."organization_id" = report."organization_id"
      AND binding."connection_id" = report."connection_id"
      AND binding."revoked_at" IS NULL
  ) environment
), inserted AS (
  INSERT INTO "workspace_control"."workspace_analysis_migration_failure"
    ("organization_id", "source_kind", "source_id", "source_revision", "title",
     "project_environment_id", "owner_member_id", "payload", "payload_hash",
     "failure_reason", "original_created_at")
  SELECT "organization_id", 'report', "source_id", "source_revision", "title",
    "project_environment_id", "owner_member_id", "payload",
    encode(digest(convert_to("payload"::text, 'UTF8'), 'sha256'), 'hex'),
    "failure_reason", "original_created_at"
  FROM archived
  ON CONFLICT ("organization_id", "source_kind", "source_id") DO NOTHING
  RETURNING "id"
)
SELECT count(*) FROM inserted;--> statement-breakpoint

-- Funnel definitions already know their Environment and exact connections, but
-- their old free-form tile payload still has no complete typed result schema.
WITH archived AS (
  SELECT analysis."organization_id", analysis."id" AS "source_id",
    analysis."revision" AS "source_revision",
    left(COALESCE(NULLIF(btrim(analysis."definition"->>'title'), ''),
      'Legacy funnel analysis'), 256) AS "title",
    analysis."project_environment_id", analysis."owner_member_id",
    analysis."created_at" AS "original_created_at",
    jsonb_build_object(
      'version', 1,
      'sourceKind', 'funnel_analysis',
      'current', to_jsonb(analysis),
      'revisions', COALESCE((
        SELECT jsonb_agg(to_jsonb(revision) ORDER BY revision."revision")
        FROM "workspace_control"."workspace_funnel_analysis_revision" revision
        WHERE revision."organization_id" = analysis."organization_id"
          AND revision."analysis_id" = analysis."id"
      ), '[]'::jsonb),
      'connections', COALESCE((
        SELECT jsonb_agg(to_jsonb(connection) ORDER BY connection."role", connection."connection_id")
        FROM "workspace_control"."workspace_funnel_analysis_connection" connection
        WHERE connection."organization_id" = analysis."organization_id"
          AND connection."analysis_id" = analysis."id"
      ), '[]'::jsonb),
      'graphRevisions', COALESCE((
        SELECT jsonb_agg(to_jsonb(graph) ORDER BY graph."graph_revision_id")
        FROM "workspace_control"."workspace_funnel_analysis_graph" graph
        WHERE graph."organization_id" = analysis."organization_id"
          AND graph."analysis_id" = analysis."id"
      ), '[]'::jsonb)
    ) AS "payload",
    'Legacy Funnel Analysis lacks the complete declared output column types, sensitivity, masking, and versioned transform/block contracts required by an executable Analysis Article.' AS "failure_reason"
  FROM "workspace_control"."workspace_funnel_analysis" analysis
), inserted AS (
  INSERT INTO "workspace_control"."workspace_analysis_migration_failure"
    ("organization_id", "source_kind", "source_id", "source_revision", "title",
     "project_environment_id", "owner_member_id", "payload", "payload_hash",
     "failure_reason", "original_created_at")
  SELECT "organization_id", 'funnel_analysis', "source_id", "source_revision", "title",
    "project_environment_id", "owner_member_id", "payload",
    encode(digest(convert_to("payload"::text, 'UTF8'), 'sha256'), 'hex'),
    "failure_reason", "original_created_at"
  FROM archived
  ON CONFLICT ("organization_id", "source_kind", "source_id") DO NOTHING
  RETURNING "id"
)
SELECT count(*) FROM inserted;--> statement-breakpoint

-- Old Signal rules target Funnel tiles rather than a reviewed Article metric.
-- Preserve categorical history and delivery receipts, but redact obsolete lease
-- capability hashes because recovery never needs execution authority.
WITH archived AS (
  SELECT rule."organization_id", rule."id" AS "source_id",
    rule."revision" AS "source_revision", rule."metric_semantic_id" AS "title",
    rule."project_environment_id", rule."owner_member_id",
    rule."created_at" AS "original_created_at",
    jsonb_build_object(
      'version', 1,
      'sourceKind', 'signal',
      'current', to_jsonb(rule),
      'runner', CASE WHEN runner."id" IS NULL THEN NULL ELSE to_jsonb(runner) END,
      'revisions', COALESCE((
        SELECT jsonb_agg(to_jsonb(revision) ORDER BY revision."revision")
        FROM "workspace_control"."workspace_signal_rule_revision" revision
        WHERE revision."organization_id" = rule."organization_id"
          AND revision."rule_id" = rule."id"
      ), '[]'::jsonb),
      'connections', COALESCE((
        SELECT jsonb_agg(to_jsonb(connection) ORDER BY connection."connection_id")
        FROM "workspace_control"."workspace_signal_rule_connection" connection
        WHERE connection."organization_id" = rule."organization_id"
          AND connection."rule_id" = rule."id"
      ), '[]'::jsonb),
      'leases', COALESCE((
        SELECT jsonb_agg((to_jsonb(lease) - 'lease_capability_hash')
          ORDER BY lease."created_at", lease."id")
        FROM "workspace_control"."workspace_signal_runner_lease" lease
        WHERE lease."organization_id" = rule."organization_id"
          AND lease."rule_id" = rule."id"
      ), '[]'::jsonb),
      'receipts', COALESCE((
        SELECT jsonb_agg(to_jsonb(receipt) ORDER BY receipt."transition_sequence", receipt."id")
        FROM "workspace_control"."workspace_signal_evaluation_receipt" receipt
        WHERE receipt."organization_id" = rule."organization_id"
          AND receipt."rule_id" = rule."id"
      ), '[]'::jsonb),
      'notifications', COALESCE((
        SELECT jsonb_agg(to_jsonb(notification) ORDER BY notification."created_at", notification."id")
        FROM "workspace_control"."workspace_signal_notification" notification
        JOIN "workspace_control"."workspace_signal_evaluation_receipt" receipt
          ON receipt."organization_id" = notification."organization_id"
         AND receipt."id" = notification."receipt_id"
        WHERE receipt."organization_id" = rule."organization_id"
          AND receipt."rule_id" = rule."id"
      ), '[]'::jsonb)
    ) AS "payload",
    'Legacy Signal targets a Funnel tile rather than a reviewed live Analysis Article metric with an exact result schema and hash.' AS "failure_reason"
  FROM "workspace_control"."workspace_signal_rule" rule
  LEFT JOIN "workspace_control"."workspace_signal_runner" runner
    ON runner."organization_id" = rule."organization_id"
   AND runner."id" = rule."runner_id"
), inserted AS (
  INSERT INTO "workspace_control"."workspace_analysis_migration_failure"
    ("organization_id", "source_kind", "source_id", "source_revision", "title",
     "project_environment_id", "owner_member_id", "payload", "payload_hash",
     "failure_reason", "original_created_at")
  SELECT "organization_id", 'signal', "source_id", "source_revision", "title",
    "project_environment_id", "owner_member_id", "payload",
    encode(digest(convert_to("payload"::text, 'UTF8'), 'sha256'), 'hex'),
    "failure_reason", "original_created_at"
  FROM archived
  ON CONFLICT ("organization_id", "source_kind", "source_id") DO NOTHING
  RETURNING "id"
)
SELECT count(*) FROM inserted;--> statement-breakpoint

-- Emit one payload-free category marker per affected workspace. The normal sync
-- cursor then refreshes the Analysis collection without carrying archived SQL.
INSERT INTO "workspace_control"."workspace_audit_event"
  ("organization_id", "actor_user_id", "action", "resource_type", "resource_id",
   "redacted_summary", "request_id")
SELECT failure."organization_id", NULL, 'analysis_legacy.archive',
  'analysis_article', NULL,
  jsonb_build_object('unresolvedCount', count(*)), gen_random_uuid()
FROM "workspace_control"."workspace_analysis_migration_failure" failure
GROUP BY failure."organization_id";
