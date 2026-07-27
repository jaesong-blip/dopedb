ALTER TABLE "workspace_control"."workspace_provider_integration" DROP CONSTRAINT "provider_integration_refresh_claim_consistent";--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_provider_integration" DROP CONSTRAINT "provider_integration_disconnect_phase";--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_provider_integration" DROP CONSTRAINT "provider_integration_disconnect_generation_consistent";--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_provider_integration" ALTER COLUMN "generation" SET DEFAULT 1;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_provider_integration" ADD COLUMN "local_verification_target" jsonb;--> statement-breakpoint
-- Do not decrypt or infer historical GCP WIF coordinates. Until an explicit
-- reconnect writes a freshly verified redacted target, make the integration
-- non-issuable while keeping it visible in the reconnect-required inventory.
UPDATE "workspace_control"."workspace_provider_integration"
SET "status" = 'reconnect_required',
    "generation" = CASE
      WHEN "generation" < 9223372036854775807 THEN "generation" + 1
      ELSE "generation"
    END,
    "updated_at" = now()
WHERE "provider" = 'gcpCloudSql'
  AND "status" = 'active'
  AND "revoked_at" IS NULL
  AND "local_verification_target" IS NULL;--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_provider_integration" ADD CONSTRAINT "provider_integration_refresh_claim_consistent" CHECK (("workspace_control"."workspace_provider_integration"."refresh_phase" = 'idle'
            AND "workspace_control"."workspace_provider_integration"."refresh_claimed_at" IS NULL AND "workspace_control"."workspace_provider_integration"."refresh_claim_id" IS NULL
            AND "workspace_control"."workspace_provider_integration"."refresh_generation" IS NULL AND "workspace_control"."workspace_provider_integration"."refresh_remote_started_at" IS NULL)
        OR ("workspace_control"."workspace_provider_integration"."refresh_phase" = 'claimed'
            AND "workspace_control"."workspace_provider_integration"."refresh_claimed_at" IS NOT NULL AND "workspace_control"."workspace_provider_integration"."refresh_claim_id" IS NOT NULL
            AND "workspace_control"."workspace_provider_integration"."refresh_generation" IS NOT NULL AND "workspace_control"."workspace_provider_integration"."refresh_remote_started_at" IS NULL)
        OR ("workspace_control"."workspace_provider_integration"."refresh_phase" = 'remote_started'
            AND "workspace_control"."workspace_provider_integration"."refresh_claimed_at" IS NOT NULL AND "workspace_control"."workspace_provider_integration"."refresh_claim_id" IS NOT NULL
            AND "workspace_control"."workspace_provider_integration"."refresh_generation" IS NOT NULL AND "workspace_control"."workspace_provider_integration"."refresh_remote_started_at" IS NOT NULL)
        OR ("workspace_control"."workspace_provider_integration"."refresh_phase" = 'reconnect_required'
            AND "workspace_control"."workspace_provider_integration"."refresh_claimed_at" IS NOT NULL AND "workspace_control"."workspace_provider_integration"."refresh_claim_id" IS NOT NULL
            AND "workspace_control"."workspace_provider_integration"."refresh_generation" IS NOT NULL AND "workspace_control"."workspace_provider_integration"."refresh_remote_started_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_provider_integration" ADD CONSTRAINT "provider_integration_disconnect_phase" CHECK ("workspace_control"."workspace_provider_integration"."disconnect_phase" IN ('idle', 'claimed', 'lease_cleanup_pending', 'leases_revoked',
          'provider_revoke_started', 'provider_revoke_ambiguous',
          'provider_revoked', 'finalized'));--> statement-breakpoint
ALTER TABLE "workspace_control"."workspace_provider_integration" ADD CONSTRAINT "provider_integration_disconnect_generation_consistent" CHECK (("workspace_control"."workspace_provider_integration"."disconnect_phase" = 'idle' AND "workspace_control"."workspace_provider_integration"."disconnect_generation" IS NULL)
        OR ("workspace_control"."workspace_provider_integration"."disconnect_phase" <> 'idle' AND "workspace_control"."workspace_provider_integration"."disconnect_generation" IS NOT NULL));
