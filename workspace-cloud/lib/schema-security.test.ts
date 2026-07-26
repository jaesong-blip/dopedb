// The migration is security-sensitive executable state, so these tests pin its
// fail-closed backfill and composite tenant relationship contracts.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../drizzle/0007_lean_slapstick.sql", import.meta.url),
  "utf8",
);
const connectionGrantMigration = readFileSync(
  new URL("../drizzle/0009_nebulous_lady_deathstrike.sql", import.meta.url),
  "utf8",
);
const schema = readFileSync(new URL("./schema.ts", import.meta.url), "utf8");

describe("workspace tenant and provider principal migration", () => {
  it("stores only fixed-length fingerprints in the global GCP claim table", () => {
    expect(migration).toContain(
      "\"principal_fingerprint\" text PRIMARY KEY NOT NULL",
    );
    expect(migration).toContain("\"organization_id\" text NOT NULL");
    expect(migration).toContain(
      "\"principal_fingerprint\" ~ '^[0-9a-f]{64}$'",
    );
    expect(migration).toContain(
      "\"target_fingerprint\" ~ '^[0-9a-f]{64}$'",
    );
    expect(migration).toContain(
      "\"access_kind\" IN ('read', 'write')",
    );
    expect(migration).not.toContain("gserviceaccount.com");
  });

  it("fails closed before backfilling invalid or duplicate active GCP claims", () => {
    expect(migration).toContain(
      "invalid active GCP integration identity; refusing principal backfill",
    );
    expect(migration).toContain(
      "duplicate active GCP service-account claim; refusing principal backfill",
    );
    expect(migration).toContain(
      "duplicate workspace GCP target; refusing principal backfill",
    );
    expect(migration).toContain("CROSS JOIN LATERAL regexp_match");
    expect(migration).toContain(
      "INSERT INTO \"workspace_control\"."
        + "\"workspace_provider_principal_claim\"",
    );
  });

  it("creates tenant parent keys before enforcing composite relationships", () => {
    const connectionKey = migration.indexOf(
      "CREATE UNIQUE INDEX \"workspace_connection_org_id_idx\"",
    );
    const integrationKey = migration.indexOf(
      "CREATE UNIQUE INDEX \"provider_integration_org_id_idx\"",
    );
    const connectionForeignKey = migration.indexOf(
      "ADD CONSTRAINT \"workspace_connection_org_provider_integration_fk\"",
    );
    expect(connectionKey).toBeGreaterThan(-1);
    expect(integrationKey).toBeGreaterThan(-1);
    expect(connectionForeignKey).toBeGreaterThan(connectionKey);
    expect(connectionForeignKey).toBeGreaterThan(integrationKey);
    expect(migration).toContain(
      "ADD CONSTRAINT \"credential_lease_org_connection_fk\"",
    );
    expect(migration).toContain(
      "ADD CONSTRAINT \"credential_lease_org_integration_fk\"",
    );
    expect(migration).toContain(
      "ADD CONSTRAINT \"provider_principal_claim_org_integration_fk\"",
    );
    expect(migration).toContain(
      "CREATE UNIQUE INDEX \"provider_principal_claim_org_target_idx\"",
    );
    expect(migration).toContain(
      "WHERE \"access_kind\" = 'read'",
    );
    expect(migration).toContain(
      "workspace tenant relationship mismatch; refusing security migration",
    );
  });
});

describe("workspace connection grants", () => {
  it("uses tenant-composite foreign keys and cannot make a member-local template writable", () => {
    expect(connectionGrantMigration).toContain(
      '"workspace_connection_grant_org_connection_fk"',
    );
    expect(connectionGrantMigration).toContain(
      '"workspace_connection_grant_org_member_fk"',
    );
    expect(connectionGrantMigration).toContain(
      '"workspace_connection_grant_capability" CHECK',
    );
    expect(connectionGrantMigration).toContain(
      '"credential_mode" = \'member_local\' AND',
    );
    expect(connectionGrantMigration).toContain('"allow_writes" = FALSE');
    expect(connectionGrantMigration.indexOf('CREATE UNIQUE INDEX "member_organization_id_idx"'))
      .toBeLessThan(connectionGrantMigration.indexOf('"workspace_connection_grant_org_member_fk"'));
  });

  it("normalizes legacy member-local writes into a new immutable version before adding the check", () => {
    const normalization = connectionGrantMigration.indexOf("WITH normalized AS (");
    const readOnlyCheck = connectionGrantMigration.indexOf(
      'ADD CONSTRAINT "workspace_connection_member_local_read_only"',
    );
    expect(normalization).toBeGreaterThan(-1);
    expect(normalization).toBeLessThan(readOnlyCheck);
    expect(connectionGrantMigration).toContain('"content_revision" = connection."content_revision" + 1');
    expect(connectionGrantMigration).toContain("'main', 'update', payload");
    expect(connectionGrantMigration).toContain('version."revision" = payloads."content_revision" - 1');
    expect(connectionGrantMigration).toContain("encode(digest(canonical_payload, 'sha256'), 'hex')");
  });

  it("does not bootstrap a grant for a member being revoked", () => {
    expect(connectionGrantMigration).toContain('member."revocation_pending_at" IS NULL');
    expect(connectionGrantMigration).toContain('member."revocation_claim_id" IS NULL');
  });

  it("keeps secret material out of the shared connection schema", () => {
    const connectionSchema = schema.slice(
      schema.indexOf("export const workspaceConnection ="),
      schema.indexOf("export const workspaceConnectionGrant ="),
    );
    for (const forbidden of ["password", "username", "certificate", "secretRef", "connectionUrl"]) {
      expect(connectionSchema).not.toContain(`${forbidden}:`);
    }
  });
});
