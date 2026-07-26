import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalHash, canonicalJson, connectionVersionPayload } from "./workspace-versioning";

const migration = readFileSync(
  new URL("../drizzle/0008_mature_shockwave.sql", import.meta.url),
  "utf8",
);

describe("workspace version and backup migration", () => {
  it("creates tenant composite keys before conflict foreign keys", () => {
    const resourceKey = migration.indexOf(
      "CREATE UNIQUE INDEX \"workspace_resource_version_org_id_idx\"",
    );
    const conflictForeignKey = migration.indexOf(
      "workspace_resource_conflict_org_server_version_fk",
    );
    expect(resourceKey).toBeGreaterThan(-1);
    expect(conflictForeignKey).toBeGreaterThan(resourceKey);
    expect(migration).toContain("workspace_resource_conflict_org_connection_fk");
    expect(migration).toContain("workspace_resource_version_org_connection_fk");
  });

  it("backfills secretless connection baselines and makes history immutable", () => {
    expect(migration).toContain("WITH legacy AS");
    expect(migration).toContain("'connection'");
    expect(migration).toContain("workspace_resource_version_append_only");
    expect(migration).toContain("workspace versions and conflicts are append-only");
    expect(migration).toContain("workspace_resource_conflict_append_only");
    expect(migration).toContain("workspace_metadata_backup_payload_immutable");
    expect(migration).not.toMatch(/password|access_token|refresh_token|result_rows/i);
  });

  it("uses the documented JavaScript canonical payload bytes for legacy hashes", () => {
    const payload = connectionVersionPayload({
      name: "Analytics", engine: "postgres", provider: "neon", driverId: null,
      host: "db.example.com", port: 5432, database: "analytics", sslmode: "require",
      readonlyDefault: true, allowWrites: false, env: "prod", schemaGroup: null,
    });
    expect(canonicalJson(payload)).toBe(
      '{"allowWrites":false,"database":"analytics","deleted":false,"driverId":null,"engine":"postgres","env":"prod","host":"db.example.com","name":"Analytics","port":5432,"provider":"neon","readonlyDefault":true,"schemaGroup":null,"sslmode":"require"}',
    );
    expect(canonicalHash(payload)).toBe("1722ac1333cb644332c9d92ca69e67f37f3a8c6b99d73fb95784ce9351ca2e2d");
    expect(migration).toContain("digest(canonical_payload, 'sha256')");
    expect(migration).toContain("'{\"allowWrites\":'");
    expect(migration).not.toContain("digest(payload::text");
  });

  it("keeps database constraints aligned with revision invariants", () => {
    expect(migration).toContain("workspace_connection_content_revision");
    expect(migration).toContain("workspace_resource_version_revision");
    expect(migration).toContain("workspace_resource_version_base_revision");
    expect(migration).toContain("workspace_resource_conflict_expected_revision");
    expect(migration).toContain("workspace_metadata_backup_source_revision");
    expect(migration).toContain("workspace_profile_revision");
    expect(migration).toContain("workspace_connection_revision");
    expect(migration).toContain("9007199254740991");
  });
});
