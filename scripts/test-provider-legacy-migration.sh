#!/usr/bin/env bash
set -euo pipefail

fixture_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fixture_database="dopedb_provider_legacy_$$"
if [[ ! "$fixture_database" =~ ^dopedb_provider_legacy_[0-9]+$ ]]; then
  echo "invalid provider migration fixture database name" >&2
  exit 1
fi

cleanup_fixture() {
  dropdb --if-exists "$fixture_database" >/dev/null 2>&1 || true
}
trap cleanup_fixture EXIT

cleanup_fixture
createdb "$fixture_database"

psql_fixture() {
  psql --no-psqlrc --set=ON_ERROR_STOP=1 --dbname="$fixture_database" "$@"
}

before_seed=(
  "$fixture_root/workspace-cloud/drizzle/0000_tiresome_silhouette.sql"
  "$fixture_root/workspace-cloud/drizzle/0001_silky_xorn.sql"
  "$fixture_root/workspace-cloud/drizzle/0002_wise_sway.sql"
  "$fixture_root/workspace-cloud/drizzle/0003_curious_expediter.sql"
  "$fixture_root/workspace-cloud/drizzle/0004_exotic_lenny_balinger.sql"
  "$fixture_root/workspace-cloud/drizzle/0005_odd_wolfsbane.sql"
  "$fixture_root/workspace-cloud/drizzle/0006_brave_dazzler.sql"
  "$fixture_root/workspace-cloud/drizzle/0007_lean_slapstick.sql"
)
for migration in "${before_seed[@]}"; do
  psql_fixture --quiet --file="$migration"
done

psql_fixture --quiet <<'SQL'
INSERT INTO "workspace_control"."organization"
  ("id", "name", "slug")
VALUES
  ('legacy-workspace', 'Legacy workspace', 'legacy-workspace');

INSERT INTO "workspace_control"."user"
  ("id", "name", "email", "email_verified")
VALUES
  ('legacy-owner', 'Legacy owner', 'legacy-owner@example.com', TRUE);

INSERT INTO "workspace_control"."member"
  ("id", "organization_id", "user_id", "role")
VALUES
  ('legacy-member', 'legacy-workspace', 'legacy-owner', 'owner');

INSERT INTO "workspace_control"."workspace_provider_integration"
  ("id", "organization_id", "provider", "status", "external_account_id",
   "display_name", "encrypted_credential", "granted_scope", "created_by_user_id")
VALUES
  ('10000000-0000-4000-8000-000000000001', 'legacy-workspace', 'gcpCloudSql',
   'active', 'legacy-gcp-account', 'Legacy GCP', 'sealed-legacy-credential',
   'cloud-platform', 'legacy-owner');

INSERT INTO "workspace_control"."workspace_connection"
  ("id", "organization_id", "name", "engine", "provider", "host", "port",
   "database_name", "sslmode", "readonly_default", "allow_writes", "revision",
   "created_by_user_id", "credential_mode", "provider_integration_id",
   "provider_resource")
VALUES
  ('20000000-0000-4000-8000-000000000001', 'legacy-workspace',
   'Legacy no-lease connection', 'postgres', 'gcpCloudSql',
   'legacy-no-lease.invalid', 5432, 'app', 'verify-full', FALSE, TRUE, 7,
   'legacy-owner', 'managed', '10000000-0000-4000-8000-000000000001',
   '{"projectId":"legacy-project","instanceId":"legacy-instance"}'::jsonb),
  ('20000000-0000-4000-8000-000000000002', 'legacy-workspace',
   'Legacy live-lease connection', 'postgres', 'gcpCloudSql',
   'legacy-live-lease.invalid', 5432, 'app', 'verify-full', FALSE, TRUE, 9,
   'legacy-owner', 'managed', '10000000-0000-4000-8000-000000000001',
   '{"projectId":"legacy-project","instanceId":"legacy-instance"}'::jsonb);

INSERT INTO "workspace_control"."workspace_credential_lease"
  ("id", "organization_id", "connection_id", "integration_id", "user_id",
   "provider", "access_mode", "external_credential_id",
   "external_credential_kind", "expires_at", "active_slot")
VALUES
  ('30000000-0000-4000-8000-000000000001', 'legacy-workspace',
   '20000000-0000-4000-8000-000000000002',
   '10000000-0000-4000-8000-000000000001', 'legacy-owner', 'gcpCloudSql',
   'read', 'legacy-external-credential', 'gcpSqlAccessToken',
   now() + interval '15 minutes', 1);
SQL

psql_fixture --quiet \
  --file="$fixture_root/workspace-cloud/drizzle/0008_mature_shockwave.sql" \
  --file="$fixture_root/workspace-cloud/drizzle/0009_nebulous_lady_deathstrike.sql"

psql_fixture --quiet <<'SQL'
DO $fixture$
BEGIN
  IF (SELECT count(*) FROM "workspace_control"."workspace_resource_version"
      WHERE "organization_id" = 'legacy-workspace' AND "branch" = 'main') <> 2 THEN
    RAISE EXCEPTION 'legacy connection versions were not backfilled';
  END IF;
  IF (SELECT count(*) FROM "workspace_control"."workspace_connection_grant"
      WHERE "organization_id" = 'legacy-workspace' AND "capability" = 'manage') <> 2 THEN
    RAISE EXCEPTION 'legacy owner grants were not backfilled';
  END IF;
END
$fixture$;

SQL

migration_0010="$fixture_root/workspace-cloud/drizzle/0010_open_micromacro.sql"
psql_fixture --quiet \
  --command='BEGIN' \
  --file="$migration_0010" \
  --command='ROLLBACK'

psql_fixture --quiet <<'SQL'
DO $fixture$
DECLARE
  no_lease "workspace_control"."workspace_connection"%ROWTYPE;
BEGIN
  IF to_regclass('workspace_control.workspace_provider_resource') IS NOT NULL THEN
    RAISE EXCEPTION 'rolled-back provider resource table survived';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'workspace_control'
      AND table_name = 'workspace_connection'
      AND column_name = 'provider_resource_id'
  ) THEN
    RAISE EXCEPTION 'rolled-back provider resource column survived';
  END IF;
  SELECT * INTO STRICT no_lease
  FROM "workspace_control"."workspace_connection"
  WHERE "id" = '20000000-0000-4000-8000-000000000001';
  IF no_lease."credential_mode" <> 'managed'
     OR no_lease."provider_integration_id" IS NULL
     OR no_lease."readonly_default" IS DISTINCT FROM FALSE
     OR no_lease."allow_writes" IS DISTINCT FROM TRUE
     OR no_lease."revision" <> 7 THEN
    RAISE EXCEPTION '0010 rollback did not restore the exact legacy row';
  END IF;
END
$fixture$;
SQL

psql_fixture --quiet --file="$migration_0010"

psql_fixture --quiet <<'SQL'
DO $fixture$
DECLARE
  no_lease "workspace_control"."workspace_connection"%ROWTYPE;
  live_lease "workspace_control"."workspace_connection"%ROWTYPE;
BEGIN
  SELECT * INTO STRICT no_lease
  FROM "workspace_control"."workspace_connection"
  WHERE "id" = '20000000-0000-4000-8000-000000000001';
  IF no_lease."credential_mode" <> 'member_local'
     OR no_lease."provider_integration_id" IS NOT NULL
     OR no_lease."provider_resource" IS NOT NULL
     OR no_lease."provider_resource_id" IS NOT NULL
     OR no_lease."readonly_default" IS DISTINCT FROM TRUE
     OR no_lease."allow_writes" IS DISTINCT FROM FALSE
     OR no_lease."revision" <> 8 THEN
    RAISE EXCEPTION 'lease-free legacy connection was not safely demoted';
  END IF;

  SELECT * INTO STRICT live_lease
  FROM "workspace_control"."workspace_connection"
  WHERE "id" = '20000000-0000-4000-8000-000000000002';
  IF live_lease."credential_mode" <> 'managed'
     OR live_lease."provider_integration_id" IS NULL
     OR live_lease."provider_resource" IS NULL
     OR live_lease."revision" <> 9 THEN
    RAISE EXCEPTION 'live-lease cleanup authority was not preserved';
  END IF;

  BEGIN
    UPDATE "workspace_control"."workspace_connection"
    SET "allow_writes" = TRUE
    WHERE "id" = no_lease."id";
    RAISE EXCEPTION 'member-local write invariant accepted an unsafe row';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END
$fixture$;
SQL

after_0010=(
  "$fixture_root/workspace-cloud/drizzle/0011_gigantic_chamber.sql"
  "$fixture_root/workspace-cloud/drizzle/0012_jittery_hitman.sql"
  "$fixture_root/workspace-cloud/drizzle/0013_vengeful_talkback.sql"
  "$fixture_root/workspace-cloud/drizzle/0014_fresh_network.sql"
  "$fixture_root/workspace-cloud/drizzle/0015_wise_arachne.sql"
)
for migration in "${after_0010[@]}"; do
  psql_fixture --quiet --file="$migration"
done

migration_0016="$fixture_root/workspace-cloud/drizzle/0016_first_changeling.sql"
psql_fixture --quiet \
  --command='BEGIN' \
  --file="$migration_0016" \
  --command='ROLLBACK'

psql_fixture --quiet <<'SQL'
DO $fixture$
BEGIN
  IF to_regclass('workspace_control.workspace_provider_operation') IS NOT NULL
     OR to_regclass('workspace_control.workspace_provider_operation_approval') IS NOT NULL THEN
    RAISE EXCEPTION 'rolled-back provider operation tables survived';
  END IF;
  IF to_regclass('workspace_control.provider_integration_org_id_provider_idx') IS NOT NULL THEN
    RAISE EXCEPTION 'rolled-back provider integration authority index survived';
  END IF;
END
$fixture$;
SQL

psql_fixture --quiet --file="$migration_0016"

psql_fixture --quiet <<'SQL'
DO $fixture$
DECLARE
  integration "workspace_control"."workspace_provider_integration"%ROWTYPE;
BEGIN
  SELECT * INTO STRICT integration
  FROM "workspace_control"."workspace_provider_integration"
  WHERE "id" = '10000000-0000-4000-8000-000000000001';
  IF integration."status" <> 'reconnect_required'
     OR integration."generation" <> 2
     OR integration."local_verification_target" IS NOT NULL THEN
    RAISE EXCEPTION 'legacy GCP integration was not demoted to reconnect-required';
  END IF;

  BEGIN
    UPDATE "workspace_control"."workspace_provider_integration"
    SET "status" = 'active'
    WHERE "id" = integration."id";
    RAISE EXCEPTION 'mixed-version writer recreated an active targetless GCP row';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  IF (SELECT "provider_audit_id"
      FROM "workspace_control"."workspace_credential_lease"
      WHERE "id" = '30000000-0000-4000-8000-000000000001') IS NOT NULL THEN
    RAISE EXCEPTION 'legacy lease fabricated a Provider audit identifier';
  END IF;

  BEGIN
    INSERT INTO "workspace_control"."workspace_provider_operation"
      ("id", "organization_id", "integration_id", "provider",
       "integration_generation", "kind", "state", "idempotency_key",
       "request_hash", "plan_hash", "plan_expires_at", "risk",
       "approval_policy", "requested_by_member_id", "requested_by_user_id",
       "requested_by_session_id", "requested_by_role", "resource_scope",
       "source_resource_id", "target_name", "ownership_marker", "redacted_plan")
    VALUES
      ('40000000-0000-4000-8000-000000000001', 'legacy-workspace',
       '10000000-0000-4000-8000-000000000001', 'neon', 2,
       'neon.branch.create', 'awaiting_approval',
       '41000000-0000-4000-8000-000000000001', repeat('a', 64), repeat('b', 64),
       now() + interval '10 minutes', 'standard', 'single_admin',
       'legacy-member', 'legacy-owner', 'legacy-session', 'owner',
       'neon-project', 'br-source', 'safe-branch', 'v1.' || repeat('A', 43), '{}'::jsonb);
    RAISE EXCEPTION 'cross-provider operation authority was accepted';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;
END
$fixture$;

INSERT INTO "workspace_control"."workspace_provider_integration"
  ("id", "organization_id", "provider", "status", "external_account_id",
   "display_name", "encrypted_credential", "granted_scope", "created_by_user_id")
VALUES
  ('10000000-0000-4000-8000-000000000002', 'legacy-workspace', 'neon',
   'active', 'legacy-neon-account', 'Legacy Neon', 'sealed-neon-credential',
   'api-key-v1', 'legacy-owner');

INSERT INTO "workspace_control"."workspace_provider_operation"
  ("id", "organization_id", "integration_id", "provider",
   "integration_generation", "kind", "state", "idempotency_key",
   "request_hash", "plan_hash", "plan_expires_at", "risk",
   "approval_policy", "requested_by_member_id", "requested_by_user_id",
   "requested_by_session_id", "requested_by_role", "resource_scope",
   "source_resource_id", "target_name", "ownership_marker", "redacted_plan")
VALUES
  ('40000000-0000-4000-8000-000000000002', 'legacy-workspace',
   '10000000-0000-4000-8000-000000000002', 'neon', 1,
   'neon.branch.create', 'awaiting_approval',
   '41000000-0000-4000-8000-000000000002', repeat('c', 64), repeat('d', 64),
   now() + interval '10 minutes', 'standard', 'single_admin',
   'legacy-member', 'legacy-owner', 'legacy-session', 'owner',
   'neon-project', 'br-source', 'safe-branch', 'v1.' || repeat('B', 43), '{}'::jsonb);

INSERT INTO "workspace_control"."workspace_provider_operation_approval"
  ("id", "organization_id", "operation_id", "plan_hash", "decision",
   "actor_member_id", "actor_user_id", "actor_session_id", "actor_role")
VALUES
  ('42000000-0000-4000-8000-000000000002', 'legacy-workspace',
   '40000000-0000-4000-8000-000000000002', repeat('d', 64), 'approved',
   'legacy-member', 'legacy-owner', 'legacy-session', 'owner');

DO $fixture$
BEGIN
  BEGIN
    INSERT INTO "workspace_control"."workspace_provider_operation"
      ("id", "organization_id", "integration_id", "provider",
       "integration_generation", "kind", "state", "idempotency_key",
       "request_hash", "plan_hash", "plan_expires_at", "risk",
       "approval_policy", "requested_by_member_id", "requested_by_user_id",
       "requested_by_session_id", "requested_by_role", "resource_scope",
       "source_resource_id", "target_name", "ownership_marker", "redacted_plan")
    VALUES
      ('40000000-0000-4000-8000-000000000003', 'legacy-workspace',
       '10000000-0000-4000-8000-000000000002', 'neon', 1,
       'neon.branch.create', 'awaiting_approval',
       '41000000-0000-4000-8000-000000000003', repeat('e', 64), repeat('f', 64),
       now() + interval '10 minutes', 'production_data', 'single_admin',
       'legacy-member', 'legacy-owner', 'legacy-session', 'owner',
       'neon-project', 'br-source', 'unsafe-branch', 'v1.' || repeat('C', 43), '{}'::jsonb);
    RAISE EXCEPTION 'production data operation accepted single-person approval';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO "workspace_control"."workspace_provider_operation"
      ("id", "organization_id", "integration_id", "provider",
       "integration_generation", "kind", "state", "idempotency_key",
       "request_hash", "plan_hash", "plan_expires_at", "risk",
       "approval_policy", "requested_by_member_id", "requested_by_user_id",
       "requested_by_session_id", "requested_by_role", "resource_scope",
       "source_resource_id", "target_name", "ownership_marker", "redacted_plan",
       "remote_started_at")
    VALUES
      ('40000000-0000-4000-8000-000000000004', 'legacy-workspace',
       '10000000-0000-4000-8000-000000000002', 'neon', 1,
       'neon.branch.create', 'remote_started',
       '41000000-0000-4000-8000-000000000004', repeat('1', 64), repeat('2', 64),
       now() + interval '10 minutes', 'standard', 'single_admin',
       'legacy-member', 'legacy-owner', 'legacy-session', 'owner',
       'neon-project', 'br-source', 'unfenced-branch', 'v1.' || repeat('D', 43),
       '{}'::jsonb, now());
    RAISE EXCEPTION 'remote-started operation accepted no claim fence';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO "workspace_control"."workspace_provider_operation_approval"
      ("id", "organization_id", "operation_id", "plan_hash", "decision",
       "actor_member_id", "actor_user_id", "actor_session_id", "actor_role")
    VALUES
      ('42000000-0000-4000-8000-000000000003', 'legacy-workspace',
       '40000000-0000-4000-8000-000000000002', repeat('d', 64), 'approved',
       'legacy-member', 'legacy-owner', 'legacy-session', 'owner');
    RAISE EXCEPTION 'provider operation accepted a second approval decision';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;
END
$fixture$;

UPDATE "workspace_control"."workspace_provider_operation"
SET "state" = 'approved'
WHERE "id" = '40000000-0000-4000-8000-000000000002';

UPDATE "workspace_control"."workspace_provider_operation"
SET "state" = 'claimed',
    "claim_id" = '43000000-0000-4000-8000-000000000002',
    "claimed_at" = now()
WHERE "id" = '40000000-0000-4000-8000-000000000002';

UPDATE "workspace_control"."workspace_provider_operation"
SET "state" = 'remote_started', "remote_started_at" = now()
WHERE "id" = '40000000-0000-4000-8000-000000000002';

UPDATE "workspace_control"."workspace_provider_operation"
SET "state" = 'reconciling',
    "provider_operation_id" = '44000000-0000-4000-8000-000000000002',
    "provider_resource_id" = 'br-created',
    "redacted_result" = '{"status":"pending"}'::jsonb,
    "reconcile_after" = now() + interval '3 seconds'
WHERE "id" = '40000000-0000-4000-8000-000000000002';

UPDATE "workspace_control"."workspace_provider_operation"
SET "state" = 'succeeded',
    "redacted_result" = '{"status":"ready"}'::jsonb,
    "reconcile_after" = NULL,
    "completed_at" = now()
WHERE "id" = '40000000-0000-4000-8000-000000000002';

DO $fixture$
BEGIN
  IF (SELECT "state" FROM "workspace_control"."workspace_provider_operation"
      WHERE "id" = '40000000-0000-4000-8000-000000000002') <> 'succeeded' THEN
    RAISE EXCEPTION 'provider operation durable lifecycle did not complete';
  END IF;
END
$fixture$;
SQL

echo "provider legacy migration fixture ok"
