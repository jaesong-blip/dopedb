-- 0011 has already moved every historical active GCP row without a target to
-- reconnect_required. Reject a mixed-version writer from recreating that
-- issuable NULL-target state, while preserving reconnect/revoked legacy rows.
ALTER TABLE "workspace_control"."workspace_provider_integration" ADD CONSTRAINT "provider_integration_local_verification_target_shape" CHECK ((
        "workspace_control"."workspace_provider_integration"."provider" = 'gcpCloudSql' AND (
          (
            "workspace_control"."workspace_provider_integration"."status" = 'active'
            AND "workspace_control"."workspace_provider_integration"."revoked_at" IS NULL
            AND "workspace_control"."workspace_provider_integration"."local_verification_target" IS NOT NULL
            AND jsonb_typeof("workspace_control"."workspace_provider_integration"."local_verification_target") = 'object'
            AND "workspace_control"."workspace_provider_integration"."local_verification_target" ?& ARRAY['kind', 'projectId', 'instanceId']
            AND ("workspace_control"."workspace_provider_integration"."local_verification_target" - 'kind' - 'projectId' - 'instanceId') = '{}'::jsonb
            AND "workspace_control"."workspace_provider_integration"."local_verification_target"->>'kind' = 'gcpCloudSql'
            AND "workspace_control"."workspace_provider_integration"."local_verification_target"->>'projectId' ~ '^[a-z][a-z0-9-]{4,28}[a-z0-9]$'
            AND "workspace_control"."workspace_provider_integration"."local_verification_target"->>'instanceId' ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,97}$'
          )
          OR (
            ("workspace_control"."workspace_provider_integration"."status" <> 'active'
              OR "workspace_control"."workspace_provider_integration"."revoked_at" IS NOT NULL)
            AND (
              "workspace_control"."workspace_provider_integration"."local_verification_target" IS NULL OR (
                jsonb_typeof("workspace_control"."workspace_provider_integration"."local_verification_target") = 'object'
                AND "workspace_control"."workspace_provider_integration"."local_verification_target" ?& ARRAY['kind', 'projectId', 'instanceId']
                AND ("workspace_control"."workspace_provider_integration"."local_verification_target" - 'kind' - 'projectId' - 'instanceId') = '{}'::jsonb
                AND "workspace_control"."workspace_provider_integration"."local_verification_target"->>'kind' = 'gcpCloudSql'
                AND "workspace_control"."workspace_provider_integration"."local_verification_target"->>'projectId' ~ '^[a-z][a-z0-9-]{4,28}[a-z0-9]$'
                AND "workspace_control"."workspace_provider_integration"."local_verification_target"->>'instanceId' ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,97}$'
              )
            )
          )
        )
      ) OR ("workspace_control"."workspace_provider_integration"."provider" <> 'gcpCloudSql' AND "workspace_control"."workspace_provider_integration"."local_verification_target" IS NULL));
