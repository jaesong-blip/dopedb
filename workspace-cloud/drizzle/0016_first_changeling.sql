CREATE TABLE "workspace_control"."workspace_provider_operation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"integration_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"integration_generation" bigint NOT NULL,
	"kind" text NOT NULL,
	"state" text DEFAULT 'awaiting_approval' NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"plan_hash" text NOT NULL,
	"plan_version" integer DEFAULT 1 NOT NULL,
	"plan_expires_at" timestamp with time zone NOT NULL,
	"risk" text NOT NULL,
	"approval_policy" text NOT NULL,
	"requested_by_member_id" text NOT NULL,
	"requested_by_user_id" text NOT NULL,
	"requested_by_session_id" text NOT NULL,
	"requested_by_role" text NOT NULL,
	"resource_scope" text NOT NULL,
	"source_resource_id" text NOT NULL,
	"target_name" text NOT NULL,
	"ownership_marker" text NOT NULL,
	"redacted_plan" jsonb NOT NULL,
	"provider_operation_id" text,
	"provider_resource_id" text,
	"redacted_result" jsonb,
	"failure_code" text,
	"claim_id" uuid,
	"claimed_at" timestamp with time zone,
	"remote_started_at" timestamp with time zone,
	"reconcile_after" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_operation_provider" CHECK ("workspace_control"."workspace_provider_operation"."provider" = 'neon'),
	CONSTRAINT "provider_operation_kind" CHECK ("workspace_control"."workspace_provider_operation"."kind" = 'neon.branch.create'),
	CONSTRAINT "provider_operation_state" CHECK ("workspace_control"."workspace_provider_operation"."state" IN (
        'awaiting_approval', 'approved', 'claimed', 'remote_started',
        'reconciling', 'succeeded', 'failed', 'needs_repair', 'cancelled'
      )),
	CONSTRAINT "provider_operation_generation" CHECK ("workspace_control"."workspace_provider_operation"."integration_generation" >= 1),
	CONSTRAINT "provider_operation_hashes" CHECK ("workspace_control"."workspace_provider_operation"."request_hash" ~ '^[0-9a-f]{64}$'
        AND "workspace_control"."workspace_provider_operation"."plan_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "provider_operation_plan_version" CHECK ("workspace_control"."workspace_provider_operation"."plan_version" = 1),
	CONSTRAINT "provider_operation_risk" CHECK ("workspace_control"."workspace_provider_operation"."risk" IN ('standard', 'production_data')),
	CONSTRAINT "provider_operation_approval_policy" CHECK ("workspace_control"."workspace_provider_operation"."approval_policy" IN ('single_admin', 'separate_admin')
        AND ("workspace_control"."workspace_provider_operation"."risk" <> 'production_data'
          OR "workspace_control"."workspace_provider_operation"."approval_policy" = 'separate_admin')),
	CONSTRAINT "provider_operation_requester_role" CHECK ("workspace_control"."workspace_provider_operation"."requested_by_role" IN ('admin', 'owner')),
	CONSTRAINT "provider_operation_scope_length" CHECK (char_length("workspace_control"."workspace_provider_operation"."resource_scope") BETWEEN 1 AND 512
        AND char_length("workspace_control"."workspace_provider_operation"."source_resource_id") BETWEEN 1 AND 512
        AND char_length("workspace_control"."workspace_provider_operation"."target_name") BETWEEN 1 AND 256
        AND char_length("workspace_control"."workspace_provider_operation"."ownership_marker") BETWEEN 1 AND 256
        AND char_length("workspace_control"."workspace_provider_operation"."requested_by_member_id") BETWEEN 1 AND 512
        AND char_length("workspace_control"."workspace_provider_operation"."requested_by_user_id") BETWEEN 1 AND 512
        AND char_length("workspace_control"."workspace_provider_operation"."requested_by_session_id") BETWEEN 1 AND 512),
	CONSTRAINT "provider_operation_neon_identifiers" CHECK ("workspace_control"."workspace_provider_operation"."resource_scope" ~ '^[a-z0-9][a-z0-9-]{0,59}$'
        AND "workspace_control"."workspace_provider_operation"."source_resource_id" ~ '^[a-z0-9][a-z0-9-]{0,59}$'
        AND "workspace_control"."workspace_provider_operation"."ownership_marker" ~ '^v1\.[A-Za-z0-9_-]{43}$'),
	CONSTRAINT "provider_operation_provider_identifiers" CHECK ("workspace_control"."workspace_provider_operation"."provider_operation_id" IS NULL
        OR "workspace_control"."workspace_provider_operation"."provider_operation_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "provider_operation_provider_resource" CHECK ("workspace_control"."workspace_provider_operation"."provider_resource_id" IS NULL
        OR "workspace_control"."workspace_provider_operation"."provider_resource_id" ~ '^[a-z0-9][a-z0-9-]{0,59}$'),
	CONSTRAINT "provider_operation_failure_code" CHECK ("workspace_control"."workspace_provider_operation"."failure_code" IS NULL
        OR "workspace_control"."workspace_provider_operation"."failure_code" ~ '^[A-Z][A-Z0-9_]{0,95}$'),
	CONSTRAINT "provider_operation_json_shapes" CHECK (jsonb_typeof("workspace_control"."workspace_provider_operation"."redacted_plan") = 'object'
        AND ("workspace_control"."workspace_provider_operation"."redacted_result" IS NULL
          OR jsonb_typeof("workspace_control"."workspace_provider_operation"."redacted_result") = 'object')),
	CONSTRAINT "provider_operation_plan_expiry" CHECK ("workspace_control"."workspace_provider_operation"."plan_expires_at" > "workspace_control"."workspace_provider_operation"."created_at"
        AND "workspace_control"."workspace_provider_operation"."plan_expires_at" <= "workspace_control"."workspace_provider_operation"."created_at" + interval '15 minutes'),
	CONSTRAINT "provider_operation_claim_consistency" CHECK ((
          "workspace_control"."workspace_provider_operation"."state" IN ('awaiting_approval', 'approved')
          AND "workspace_control"."workspace_provider_operation"."claim_id" IS NULL AND "workspace_control"."workspace_provider_operation"."claimed_at" IS NULL
          AND "workspace_control"."workspace_provider_operation"."remote_started_at" IS NULL AND "workspace_control"."workspace_provider_operation"."completed_at" IS NULL
        ) OR (
          "workspace_control"."workspace_provider_operation"."state" = 'claimed'
          AND "workspace_control"."workspace_provider_operation"."claim_id" IS NOT NULL AND "workspace_control"."workspace_provider_operation"."claimed_at" IS NOT NULL
          AND "workspace_control"."workspace_provider_operation"."remote_started_at" IS NULL AND "workspace_control"."workspace_provider_operation"."completed_at" IS NULL
        ) OR (
          "workspace_control"."workspace_provider_operation"."state" IN ('remote_started', 'reconciling')
          AND "workspace_control"."workspace_provider_operation"."claim_id" IS NOT NULL AND "workspace_control"."workspace_provider_operation"."claimed_at" IS NOT NULL
          AND "workspace_control"."workspace_provider_operation"."remote_started_at" IS NOT NULL AND "workspace_control"."workspace_provider_operation"."completed_at" IS NULL
        ) OR (
          "workspace_control"."workspace_provider_operation"."state" IN ('succeeded', 'failed', 'needs_repair', 'cancelled')
          AND "workspace_control"."workspace_provider_operation"."completed_at" IS NOT NULL
        )),
	CONSTRAINT "provider_operation_claim_pair" CHECK (("workspace_control"."workspace_provider_operation"."claim_id" IS NULL AND "workspace_control"."workspace_provider_operation"."claimed_at" IS NULL)
        OR ("workspace_control"."workspace_provider_operation"."claim_id" IS NOT NULL AND "workspace_control"."workspace_provider_operation"."claimed_at" IS NOT NULL)),
	CONSTRAINT "provider_operation_failure_state" CHECK ("workspace_control"."workspace_provider_operation"."failure_code" IS NULL
        OR "workspace_control"."workspace_provider_operation"."state" IN ('failed', 'needs_repair')),
	CONSTRAINT "provider_operation_success_resource" CHECK ("workspace_control"."workspace_provider_operation"."state" <> 'succeeded' OR "workspace_control"."workspace_provider_operation"."provider_resource_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "workspace_control"."workspace_provider_operation_approval" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"operation_id" uuid NOT NULL,
	"plan_hash" text NOT NULL,
	"decision" text NOT NULL,
	"actor_member_id" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"actor_session_id" text NOT NULL,
	"actor_role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_operation_approval_hash" CHECK ("workspace_control"."workspace_provider_operation_approval"."plan_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "provider_operation_approval_decision" CHECK ("workspace_control"."workspace_provider_operation_approval"."decision" IN ('approved', 'rejected')),
	CONSTRAINT "provider_operation_approval_role" CHECK ("workspace_control"."workspace_provider_operation_approval"."actor_role" IN ('admin', 'owner'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "provider_integration_org_id_provider_idx" ON "workspace_control"."workspace_provider_integration" USING btree ("organization_id","id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_operation_org_id_idx" ON "workspace_control"."workspace_provider_operation" USING btree ("organization_id","id");--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_provider_operation" ADD CONSTRAINT "workspace_provider_operation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "workspace_control"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_provider_operation" ADD CONSTRAINT "provider_operation_org_integration_fk" FOREIGN KEY ("organization_id","integration_id","provider") REFERENCES "workspace_control"."workspace_provider_integration"("organization_id","id","provider") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_provider_operation_approval" ADD CONSTRAINT "workspace_provider_operation_approval_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "workspace_control"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_provider_operation_approval" ADD CONSTRAINT "provider_operation_approval_org_operation_fk" FOREIGN KEY ("organization_id","operation_id") REFERENCES "workspace_control"."workspace_provider_operation"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_operation_org_idempotency_idx" ON "workspace_control"."workspace_provider_operation" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "provider_operation_org_state_updated_idx" ON "workspace_control"."workspace_provider_operation" USING btree ("organization_id","state","updated_at");--> statement-breakpoint
CREATE INDEX "provider_operation_integration_state_idx" ON "workspace_control"."workspace_provider_operation" USING btree ("integration_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_operation_approval_org_operation_idx" ON "workspace_control"."workspace_provider_operation_approval" USING btree ("organization_id","operation_id");
