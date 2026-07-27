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
const providerImportMigration = readFileSync(
  new URL("../drizzle/0010_open_micromacro.sql", import.meta.url),
  "utf8",
);
const localAuthorityMigration = readFileSync(
  new URL("../drizzle/0011_gigantic_chamber.sql", import.meta.url),
  "utf8",
);
const localAuthorityConstraintMigration = readFileSync(
  new URL("../drizzle/0012_jittery_hitman.sql", import.meta.url),
  "utf8",
);
const providerImportSnapshot = JSON.parse(readFileSync(
  new URL("../drizzle/meta/0010_snapshot.json", import.meta.url),
  "utf8",
)) as {
  tables: Record<string, {
    columns: Record<string, { type: string; notNull: boolean }>;
    foreignKeys: Record<string, { columnsFrom: string[]; columnsTo: string[] }>;
    indexes: Record<string, { where?: string }>;
    checkConstraints?: Record<string, { value: string }>;
  }>;
};
const localAuthoritySnapshot = JSON.parse(readFileSync(
  new URL("../drizzle/meta/0012_snapshot.json", import.meta.url),
  "utf8",
)) as {
  tables: Record<string, {
    columns: Record<string, { type: string; notNull: boolean }>;
    checkConstraints?: Record<string, { value: string }>;
  }>;
};
const providerIntegrationSource = [
  "./provider-integrations/discovery-receipts.ts",
  "./provider-integrations/integration.ts",
].map((file) => readFileSync(new URL(file, import.meta.url), "utf8")).join("\n");
const providerImportStoreSource = readFileSync(
  new URL("./provider-import-store.ts", import.meta.url), "utf8",
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

describe("provider discovery/import migration", () => {
  it("persists refresh and disconnect external-I/O phase fences", () => {
    const integration = providerImportSnapshot.tables["workspace_control.workspace_provider_integration"]!;
    for (const column of ["refresh_phase", "refresh_remote_started_at", "disconnect_phase", "disconnect_generation"]) {
      expect(integration.columns[column]).toBeDefined();
    }
    expect(providerImportMigration).toContain("'remote_started'");
    expect(providerImportMigration).toContain("'reconnect_required'");
    expect(providerImportMigration).toContain("'provider_revoke_ambiguous'");
    expect(providerImportMigration).toContain("SET \"refresh_phase\" = 'reconnect_required'");
    const refreshCheck = integration.checkConstraints
      ?.provider_integration_refresh_claim_consistent?.value ?? "";
    expect(refreshCheck).toContain("'claimed'");
    expect(refreshCheck).toContain("'remote_started'");
    expect(refreshCheck).toContain("'reconnect_required'");
    expect(refreshCheck).toContain("refresh_remote_started_at\" IS NULL");
    expect(refreshCheck).toContain("refresh_remote_started_at\" IS NOT NULL");
  });
  it("uses bigint integration generations rather than lossy Date equality", () => {
    const integration = providerImportSnapshot.tables["workspace_control.workspace_provider_integration"]!;
    const receipt = providerImportSnapshot.tables["workspace_control.workspace_provider_discovery_receipt"]!;
    expect(integration.columns.generation).toMatchObject({ type: "bigint", notNull: true });
    expect(receipt.columns.integration_generation).toMatchObject({ type: "bigint", notNull: true });
    expect(providerImportMigration).toContain('ADD COLUMN "generation" bigint NOT NULL DEFAULT 1');
    expect(providerIntegrationSource).toContain('integration."generation" = ${input.integrationGeneration}');
    expect(providerIntegrationSource).not.toContain('integration."updated_at" = ${input.integrationUpdatedAt}');
  });
  it("requires an idle refresh phase at receipt issuance, revalidation, and import", () => {
    const receiptBoundary = providerIntegrationSource.slice(
      providerIntegrationSource.indexOf("export async function recordProviderDiscoveryReceipt"),
      providerIntegrationSource.indexOf("export async function revalidateProviderDiscoveryAuthority"),
    );
    const revalidationBoundary = providerIntegrationSource.slice(
      providerIntegrationSource.indexOf("export async function revalidateProviderDiscoveryAuthority"),
      providerIntegrationSource.indexOf("function boundedDiscoveryResults"),
    );
    expect(receiptBoundary).toContain('integration."refresh_phase" = \'idle\'');
    expect(revalidationBoundary).toContain('integration."refresh_phase" = \'idle\'');
    expect(providerImportStoreSource.match(/integration\."refresh_phase" = 'idle'/g))
      .toHaveLength(2);
  });
  it("refreshes every canonical safe projection field without reviving a receipt", () => {
    const conflict = providerIntegrationSource.slice(
      providerIntegrationSource.indexOf('ON CONFLICT ("organization_id", "provider", "resource_fingerprint")'),
      providerIntegrationSource.indexOf('RETURNING "id"', providerIntegrationSource.indexOf('ON CONFLICT ("organization_id", "provider", "resource_fingerprint")')),
    );
    expect(conflict).toContain('"resource" = EXCLUDED."resource"');
    expect(conflict).toContain('"redacted_metadata" = EXCLUDED."redacted_metadata"');
    expect(conflict).toContain('"capability_manifest" = EXCLUDED."capability_manifest"');
    expect(conflict).not.toContain("workspace_provider_discovery_receipt");
  });
  it("creates the exact durable resource parent key before every tenant composite FK", () => {
    const resourceKey = providerImportMigration.indexOf(
      'CREATE UNIQUE INDEX "provider_resource_org_id_idx"',
    );
    const receiptResourceFk = providerImportMigration.indexOf(
      'ADD CONSTRAINT "provider_discovery_receipt_org_resource_fk"',
    );
    const importResourceFk = providerImportMigration.indexOf(
      'ADD CONSTRAINT "provider_import_org_resource_fk"',
    );
    const connectionResourceFk = providerImportMigration.indexOf(
      'ADD CONSTRAINT "workspace_connection_org_provider_resource_fk"',
    );
    expect(resourceKey).toBeGreaterThan(-1);
    expect(receiptResourceFk).toBeGreaterThan(resourceKey);
    expect(importResourceFk).toBeGreaterThan(resourceKey);
    expect(connectionResourceFk).toBeGreaterThan(resourceKey);
    expect(providerImportMigration).toContain(
      'REFERENCES "workspace_control"."workspace_provider_resource"("organization_id","id")',
    );
  });

  it("keeps the 0010 snapshot aligned with the nullable legacy binding and composite FK", () => {
    const connection = providerImportSnapshot.tables["workspace_control.workspace_connection"]!;
    expect(connection.columns.provider_resource_id).toMatchObject({ type: "uuid", notNull: false });
    expect(connection.foreignKeys.workspace_connection_org_provider_resource_fk).toMatchObject({
      columnsFrom: ["organization_id", "provider_resource_id"],
      columnsTo: ["organization_id", "id"],
    });
    expect(connection.indexes.workspace_connection_org_provider_resource_idx).toMatchObject({
      where: '"provider_resource_id" IS NOT NULL AND "deleted_at" IS NULL',
    });
    expect(providerImportMigration).toContain(
      'WHERE "provider_resource_id" IS NOT NULL AND "deleted_at" IS NULL',
    );
    expect(schema).toContain('.where(sql`"provider_resource_id" IS NOT NULL AND "deleted_at" IS NULL`)');
  });

  it("keeps receipts session/member-bound and import records hash-bound without credentials", () => {
    for (const fragment of [
      '"workspace_provider_discovery_receipt"',
      '"member_id" text NOT NULL',
      '"session_id" text NOT NULL',
      '"consumed_at" timestamp with time zone',
      '"request_hash" text NOT NULL',
      '"provider_import_org_connection_fk"',
    ]) expect(providerImportMigration).toContain(fragment);
    for (const forbidden of ["password", "access_token", "refresh_token", "encrypted_credential"]) {
      expect(providerImportMigration).not.toContain(forbidden);
    }
  });

  it("demotes every pre-receipt managed selector, including strict-looking dev-labelled rows", () => {
    const remediation = providerImportMigration.slice(
      providerImportMigration.indexOf("-- A pre-receipt managed selector"),
      providerImportMigration.indexOf(
        'ALTER TABLE "workspace_control"."workspace_provider_discovery_receipt"',
      ),
    );
    expect(remediation).toContain('WHERE connection."credential_mode" = \'managed\'');
    expect(remediation).not.toContain('connection."environment"');
    expect(remediation).not.toContain('connection."provider_resource" ->>');
    expect(remediation).not.toContain('INSERT INTO "workspace_control"."workspace_provider_resource"');
    expect(remediation).toContain('"credential_mode" = \'member_local\'');
    expect(remediation).toContain('"provider_integration_id" = NULL');
    expect(remediation).toContain('"provider_resource" = NULL, "provider_resource_id" = NULL');
    expect(remediation).toContain('"readonly_default" = TRUE, "allow_writes" = FALSE');
    // A live lease is a durable external-cleanup obligation. Migration may
    // demote dormant legacy templates only; it must retain that binding until
    // the lease sweeper records successful cleanup.
    expect(remediation).toContain('"workspace_credential_lease" lease');
    expect(remediation).toContain('lease."revoked_at" IS NULL');
    expect(remediation).toContain('"revision" = CASE');
    expect(remediation).not.toContain('connection."deleted_at" IS NULL');
  });
});

describe("provider-local authority projection migration", () => {
  it("rejects mixed-version active GCP NULL-target inserts while retaining reconnect legacy rows", () => {
    const integration = localAuthoritySnapshot.tables[
      "workspace_control.workspace_provider_integration"
    ]!;
    expect(integration.columns.local_verification_target).toMatchObject({
      type: "jsonb", notNull: false,
    });
    const shape = integration.checkConstraints
      ?.provider_integration_local_verification_target_shape?.value ?? "";
    expect(shape).toContain("'kind', 'projectId', 'instanceId'");
    expect(shape).toContain("- 'kind' - 'projectId' - 'instanceId'");
    expect(shape).toContain('"provider" <> \'gcpCloudSql\'');
    expect(shape).toContain('"status" = \'active\'');
    expect(shape).toContain('"revoked_at" IS NULL');
    expect(shape).toContain('"local_verification_target" IS NOT NULL');
    expect(shape).toContain('"status" <> \'active\'');
    expect(localAuthorityConstraintMigration).toContain(
      "provider_integration_local_verification_target_shape",
    );
    expect(localAuthorityConstraintMigration).toContain(
      "Reject a mixed-version writer from recreating that",
    );
    expect(localAuthorityMigration).toContain(
      'SET "status" = \'reconnect_required\'',
    );
    expect(localAuthorityMigration).toContain('"local_verification_target" IS NULL');
    expect(localAuthorityMigration).not.toContain("encrypted_credential");
    expect(localAuthorityMigration).not.toContain("openProviderCredential");
  });
});
