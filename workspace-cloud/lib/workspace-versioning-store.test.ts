import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const executeMock = vi.hoisted(() => vi.fn());

vi.mock("server-only", () => ({}));
vi.mock("./db", () => ({ db: { execute: executeMock } }));

import {
  commitConnectionMutation,
  conflictConnectionCandidate,
  restoreWorkspaceSnapshot,
} from "./workspace-versioning-store";

const organizationId = "11111111-1111-4111-8111-111111111111";
const backupId = "22222222-2222-4222-8222-222222222222";
const connectionId = "33333333-3333-4333-8333-333333333333";
const snapshot = {
  version: 1 as const,
  workspace: { organizationId, lifecycleState: "active", residencyRegion: null, revision: 4 },
  connections: [{
    id: connectionId, contentRevision: 3, name: "Analytics", engine: "postgres" as const,
    provider: "neon" as const, driverId: null, host: "db.example.com", port: 5432,
    database: "analytics", sslmode: "require", readonlyDefault: true, allowWrites: false,
    env: "prod", schemaGroup: null,
  }],
};

beforeEach(() => vi.clearAllMocks());

describe("atomic backup restore command", () => {
  it("uses one CTE statement for CAS, candidates, inserts, versions, and audit", async () => {
    executeMock.mockResolvedValue({
      rows: [{ revision: 5, restored: 1, conflictIds: [] }],
    });

    await expect(restoreWorkspaceSnapshot({
      organizationId, backupId, expectedRevision: 4, sourceRevision: 4,
      authority: { sessionId: "session-id", userId: "admin-user", membershipId: "member-id", role: "admin" },
      snapshot,
    })).resolves.toEqual({ revision: 5, restored: 1, conflictIds: [] });

    expect(executeMock).toHaveBeenCalledOnce();
    const query = new PgDialect().sqlToQuery(executeMock.mock.calls[0]![0]);
    expect(query.sql).toContain('UPDATE "workspace_control"."workspace_profile"');
    expect(query.sql).toContain('INSERT INTO "workspace_control"."workspace_resource_conflict"');
    expect(query.sql).toContain('INSERT INTO "workspace_control"."workspace_connection"');
    expect(query.sql).toContain('INSERT INTO "workspace_control"."workspace_resource_version"');
    expect(query.sql).toContain('INSERT INTO "workspace_control"."workspace_audit_event"');
    expect(query.sql).toContain("pg_advisory_xact_lock");
    expect(query.sql).toContain('"workspace_control"."session"');
    expect(query.sql).toContain('session."expires_at" > now()');
    expect(query.sql).toContain('member."revocation_pending_at" IS NULL');
    expect(query.sql).toContain('member."revocation_claim_id" IS NULL');
    expect(query.sql).toContain('backup."deleted_at" IS NULL');
    expect(query.sql).toContain('backup."source_revision" =');
    expect(query.sql).toContain("profile_gate AS MATERIALIZED");
    expect(query.sql).toContain("coverage AS MATERIALIZED");
    expect(query.sql).toContain('server_versions."server_version_id" IS NULL');
    expect(query.sql).toContain("FROM server_versions\n      JOIN claimed ON TRUE");
    expect(query.sql.indexOf("profile_gate AS MATERIALIZED"))
      .toBeLessThan(query.sql.indexOf("existing AS MATERIALIZED"));
    expect(query.sql).toContain("SELECT 1 FROM profile_gate");
  });

  it("reports a lost compare-and-swap without publishing any partial result", async () => {
    executeMock.mockResolvedValue({ rows: [] });

    await expect(restoreWorkspaceSnapshot({
      organizationId, backupId, expectedRevision: 4, sourceRevision: 4,
      authority: { sessionId: "session-id", userId: "admin-user", membershipId: "member-id", role: "admin" },
      snapshot,
    })).resolves.toBeNull();
    expect(executeMock).toHaveBeenCalledOnce();
  });
});

describe("atomic connection mutation commands", () => {
  const authority = {
    sessionId: "session-id", userId: "admin-user", membershipId: "member-id", role: "admin" as const,
  };
  const payload = {
    name: "Analytics", engine: "postgres" as const, provider: "neon" as const, driverId: null,
    host: "db.example.com", port: 5432, database: "analytics", sslmode: "require",
    readonlyDefault: true, allowWrites: false, env: "prod", schemaGroup: null, deleted: false,
  };

  it("makes projection, version, and audit depend on the exact authority and claim", async () => {
    executeMock.mockResolvedValue({ rows: [] });
    await expect(commitConnectionMutation({
      organizationId, connectionId, expectedContentRevision: 1, expectedAuthorityRevision: 2,
      claimId: "44444444-4444-4444-8444-444444444444", authority,
      mutation: { kind: "update", payload, name: payload.name, engine: payload.engine,
        provider: payload.provider, driverId: null, host: payload.host, port: payload.port,
        databaseName: payload.database, sslmode: payload.sslmode, readonlyDefault: true,
        allowWrites: false, environment: null, schemaGroup: null },
    })).resolves.toBeNull();
    const query = new PgDialect().sqlToQuery(executeMock.mock.calls[0]![0]);
    expect(query.sql).toContain('connection."revocation_claim_id" =');
    expect(query.sql).toContain('connection."revision" =');
    expect(query.sql).toContain('connection."content_revision" =');
    expect(query.sql).toContain('FROM authority, parent');
    expect(query.sql).toContain('FROM updated JOIN parent ON TRUE');
    expect(query.sql).toContain('FROM updated JOIN version ON TRUE');
    expect(query.sql).toContain('session."expires_at" > now()');
    expect(query.sql).toContain('member."revocation_pending_at" IS NULL');
  });

  it("maps raw SQL aliases and int8/timestamp wire values before public projection", async () => {
    executeMock.mockResolvedValue({ rows: [{
      id: connectionId, name: "Analytics", engine: "postgres", provider: "neon", driverId: null,
      host: "db.example.com", port: "5432", databaseName: "analytics", sslmode: "require",
      readonlyDefault: true, allowWrites: false, environment: null, schemaGroup: null,
      credentialMode: "member_local", contentRevision: "2", updatedAt: "2026-07-23T00:00:00.000Z",
    }] });
    await expect(commitConnectionMutation({
      organizationId, connectionId, expectedContentRevision: 1, expectedAuthorityRevision: 2,
      claimId: "44444444-4444-4444-8444-444444444444", authority,
      mutation: { kind: "delete", payload: { ...payload, deleted: true } },
    })).resolves.toMatchObject({ port: 5432, contentRevision: 2, updatedAt: new Date("2026-07-23T00:00:00.000Z") });
  });

  it("requires live authority before appending an offline conflict candidate", async () => {
    executeMock.mockResolvedValue({ rows: [] });
    await expect(conflictConnectionCandidate({
      organizationId, connectionId, expectedRevision: 0, payload, authority,
    })).rejects.toThrow("Missing immutable connection version");
    const query = new PgDialect().sqlToQuery(executeMock.mock.calls[0]![0]);
    expect(query.sql).toContain("authority_lock AS MATERIALIZED");
    expect(query.sql).toContain("EXISTS (SELECT 1 FROM authority)");
    expect(query.sql).toContain('FROM conflict JOIN server_version ON TRUE');
  });
});
