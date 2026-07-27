CREATE TABLE "workspace_control"."workspace_provider_discovery_receipt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"resource_id" uuid NOT NULL,
	"integration_id" uuid NOT NULL,
	"integration_generation" bigint NOT NULL,
	"member_id" text NOT NULL,
	"user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_control"."workspace_provider_import_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"resource_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_import_request_hash" CHECK ("workspace_control"."workspace_provider_import_request"."request_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "workspace_control"."workspace_provider_resource" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"provider" text NOT NULL,
	"resource_fingerprint" text NOT NULL,
	"resource" jsonb NOT NULL,
	"redacted_metadata" jsonb NOT NULL,
	"capability_manifest" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_provider_resource" ADD CONSTRAINT "workspace_provider_resource_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "workspace_control"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_resource_org_id_idx" ON "workspace_control"."workspace_provider_resource" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_resource_org_provider_fingerprint_idx" ON "workspace_control"."workspace_provider_resource" USING btree ("organization_id","provider","resource_fingerprint");--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_connection" DROP CONSTRAINT "workspace_connection_member_local_read_only";--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_connection" ADD COLUMN "provider_resource_id" uuid;--> statement-breakpoint
-- A bigint CAS token is independent of wall-clock precision. Existing rows get
-- generation one and every credential/connection-affecting mutation increments it.
ALTER TABLE "workspace_control"."workspace_provider_integration" ADD COLUMN "generation" bigint NOT NULL DEFAULT 1;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_provider_integration" ADD CONSTRAINT "provider_integration_generation_positive" CHECK ("generation" >= 1);--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_provider_integration" ADD COLUMN "refresh_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_provider_integration" ADD COLUMN "refresh_claim_id" uuid;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_provider_integration" ADD COLUMN "refresh_generation" bigint;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_provider_integration" ADD COLUMN "refresh_phase" text NOT NULL DEFAULT 'idle';--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_provider_integration" ADD COLUMN "refresh_remote_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_provider_integration" ADD COLUMN "disconnect_phase" text NOT NULL DEFAULT 'idle';--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_provider_integration" ADD COLUMN "disconnect_generation" bigint;--> statement-breakpoint
-- A pre-existing claim was created by code without an external-I/O fence. Treat it
-- as ambiguous rather than allowing a second refresh-token rotation to invalidate a
-- response a crashed worker may already have received.
UPDATE "workspace_control"."workspace_provider_integration"
SET "refresh_phase" = 'reconnect_required',
    "refresh_remote_started_at" = COALESCE("refresh_claimed_at", now()),
    "status" = 'reconnect_required'
WHERE "refresh_claim_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_provider_integration" ADD CONSTRAINT "provider_integration_refresh_claim_consistent" CHECK (("refresh_phase" = 'idle' AND "refresh_claimed_at" IS NULL AND "refresh_claim_id" IS NULL AND "refresh_generation" IS NULL AND "refresh_remote_started_at" IS NULL) OR ("refresh_phase" = 'claimed' AND "refresh_claimed_at" IS NOT NULL AND "refresh_claim_id" IS NOT NULL AND "refresh_generation" IS NOT NULL AND "refresh_remote_started_at" IS NULL) OR ("refresh_phase" = 'remote_started' AND "refresh_claimed_at" IS NOT NULL AND "refresh_claim_id" IS NOT NULL AND "refresh_generation" IS NOT NULL AND "refresh_remote_started_at" IS NOT NULL) OR ("refresh_phase" = 'reconnect_required' AND "refresh_claimed_at" IS NOT NULL AND "refresh_claim_id" IS NOT NULL AND "refresh_generation" IS NOT NULL AND "refresh_remote_started_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_provider_integration" ADD CONSTRAINT "provider_integration_disconnect_phase" CHECK ("disconnect_phase" IN ('idle', 'claimed', 'lease_cleanup_pending', 'leases_revoked', 'provider_revoke_started', 'provider_revoke_ambiguous', 'provider_revoked', 'finalized'));--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_provider_integration" ADD CONSTRAINT "provider_integration_disconnect_generation_consistent" CHECK (("disconnect_phase" = 'idle' AND "disconnect_generation" IS NULL) OR ("disconnect_phase" <> 'idle' AND "disconnect_generation" IS NOT NULL));--> statement-breakpoint
-- A pre-receipt managed selector is not authoritative evidence of target state,
-- readiness, or production policy. Never copy it into canonical resources: every
-- existing managed template is deterministically demoted to the secretless,
-- read-only member-local shape before receipt-bound imports become available.
UPDATE "workspace_control"."workspace_connection" connection
SET "credential_mode" = 'member_local', "provider_integration_id" = NULL,
	"provider_resource" = NULL, "provider_resource_id" = NULL,
	"readonly_default" = TRUE, "allow_writes" = FALSE,
	"revocation_pending_at" = NULL, "revocation_claimed_at" = NULL,
	"revocation_claim_id" = NULL,
	"revision" = CASE
		WHEN connection."revision" < 9007199254740991 THEN connection."revision" + 1
		ELSE connection."revision"
	END,
	"updated_at" = now()
WHERE connection."credential_mode" = 'managed'
  -- A live lease may still require the provider/resource binding for its
  -- externally-visible cleanup. Demote only bindings with no live lease.
  AND NOT EXISTS (
    SELECT 1 FROM "workspace_control"."workspace_credential_lease" lease
    WHERE lease."organization_id" = connection."organization_id"
      AND lease."connection_id" = connection."id"
      AND lease."revoked_at" IS NULL
  );--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_provider_discovery_receipt" ADD CONSTRAINT "workspace_provider_discovery_receipt_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "workspace_control"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_provider_discovery_receipt" ADD CONSTRAINT "workspace_provider_discovery_receipt_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "workspace_control"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_provider_discovery_receipt" ADD CONSTRAINT "workspace_provider_discovery_receipt_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "workspace_control"."session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_provider_discovery_receipt" ADD CONSTRAINT "provider_discovery_receipt_org_resource_fk" FOREIGN KEY ("organization_id","resource_id") REFERENCES "workspace_control"."workspace_provider_resource"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_provider_discovery_receipt" ADD CONSTRAINT "provider_discovery_receipt_org_integration_fk" FOREIGN KEY ("organization_id","integration_id") REFERENCES "workspace_control"."workspace_provider_integration"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_provider_discovery_receipt" ADD CONSTRAINT "provider_discovery_receipt_org_member_fk" FOREIGN KEY ("organization_id","member_id") REFERENCES "workspace_control"."member"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_provider_import_request" ADD CONSTRAINT "workspace_provider_import_request_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "workspace_control"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_provider_import_request" ADD CONSTRAINT "provider_import_org_resource_fk" FOREIGN KEY ("organization_id","resource_id") REFERENCES "workspace_control"."workspace_provider_resource"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_provider_import_request" ADD CONSTRAINT "provider_import_org_connection_fk" FOREIGN KEY ("organization_id","connection_id") REFERENCES "workspace_control"."workspace_connection"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "provider_discovery_receipt_org_expiry_idx" ON "workspace_control"."workspace_provider_discovery_receipt" USING btree ("organization_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_import_org_key_idx" ON "workspace_control"."workspace_provider_import_request" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_connection" ADD CONSTRAINT "workspace_connection_org_provider_resource_fk" FOREIGN KEY ("organization_id","provider_resource_id") REFERENCES "workspace_control"."workspace_provider_resource"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_connection_org_provider_resource_idx" ON "workspace_control"."workspace_connection" USING btree ("organization_id","provider_resource_id") WHERE "provider_resource_id" IS NOT NULL AND "deleted_at" IS NULL;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_connection" ADD CONSTRAINT "workspace_connection_member_local_read_only" CHECK (("workspace_control"."workspace_connection"."credential_mode" = 'member_local' AND "workspace_control"."workspace_connection"."readonly_default" = TRUE AND "workspace_control"."workspace_connection"."allow_writes" = FALSE)
        OR "workspace_control"."workspace_connection"."credential_mode" = 'managed');
