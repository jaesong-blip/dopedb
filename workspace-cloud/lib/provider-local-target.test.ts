import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { executeMock, lockKeyMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  lockKeyMock: vi.fn(() => "member-lock"),
}));

vi.mock("server-only", () => ({}));
vi.mock("./db", () => ({ db: { execute: executeMock } }));
vi.mock("./revocation-gates", () => ({ revocationGateLockKey: lockKeyMock }));

import { loadProviderLocalTarget, parseProviderLocalTarget } from "./provider-local-target";

const input = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  connectionId: "22222222-2222-4222-8222-222222222222",
  authority: { sessionId: "session", userId: "user", membershipId: "member" },
  now: new Date("2026-07-27T00:00:00.000Z"),
};

function row(overrides: Record<string, unknown> = {}) {
  return {
    connectionId: input.connectionId,
    connectionRevision: "7",
    integrationId: "33333333-3333-4333-8333-333333333333",
    integrationGeneration: "9",
    provider: "neon",
    resourceFingerprint: "a".repeat(64),
    resource: {
      project: "project-1", branch: "branch-1", database: "app", engine: "postgres", schemas: ["public"],
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  executeMock.mockResolvedValue({ rows: [row()] });
});

describe("provider local target authority", () => {
  it("rebuilds the exact secret-free Neon target and gives it a bounded lifetime", () => {
    const target = parseProviderLocalTarget(row(), input.now);
    expect(target).toEqual({
      connectionId: input.connectionId,
      connectionRevision: "7",
      integrationId: "33333333-3333-4333-8333-333333333333",
      integrationGeneration: "9",
      provider: "neon",
      resourceFingerprint: "a".repeat(64),
      target: { project: "project-1", branch: "branch-1", database: "app", engine: "postgres", schemas: ["public"] },
      authorityExpiresAt: "2026-07-27T00:05:00.000Z",
    });
  });

  it("accepts only the GCP core network modes and rejects alias, secret, oversized, nested, control, or invalid rows", () => {
    expect(parseProviderLocalTarget(row({
      provider: "gcpCloudSql",
      resource: {
        project: "sample-project-123", instance: "instance-1", database: "app", engine: "mysql",
        networkMode: "PRIVATE_SERVICES_ACCESS",
      },
    }), input.now)?.target).toEqual({
      project: "sample-project-123", instance: "instance-1", database: "app", engine: "mysql",
      networkMode: "PRIVATE_SERVICES_ACCESS",
    });
    expect(parseProviderLocalTarget(row({
      provider: "gcpCloudSql",
      resource: {
        project: "sample-project-123", instance: "instance-1", database: "app", engine: "postgres",
        networkMode: "PRIVATE_SERVICE_CONNECT",
      },
    }), input.now)?.target).toMatchObject({ networkMode: "PRIVATE_SERVICE_CONNECT" });
    expect(parseProviderLocalTarget(row({ encryptedCredential: "must-not-project" }), input.now)).toBeNull();
    expect(parseProviderLocalTarget(row({ resource: { project: "p", branch: "b", database: "d", engine: "postgres", schemas: ["public"], token: "x" } }), input.now)).toBeNull();
    expect(parseProviderLocalTarget(row({ resource: {
      project: "p".repeat(513), branch: "b", database: "d", engine: "postgres", schemas: ["public"],
    } }), input.now)).toBeNull();
    expect(parseProviderLocalTarget(row({ resource: { project: "p\n", branch: "b", database: "d", engine: "postgres", schemas: ["public"] } }), input.now)).toBeNull();
    expect(parseProviderLocalTarget(row({ resource: { project: "p", branch: "b", database: "d", engine: "postgres", schemas: [{ name: "public" }] } }), input.now)).toBeNull();
    expect(parseProviderLocalTarget(row({
      provider: "gcpCloudSql",
      resource: {
        project: "sample-project-123", instance: "instance-1", database: "app", engine: "mysql",
        networkMode: "PRIVATE_IP",
      },
    }), input.now)).toBeNull();
    expect(parseProviderLocalTarget(row({ resourceFingerprint: "not-a-fingerprint" }), input.now)).toBeNull();
    expect(parseProviderLocalTarget(row({ connectionRevision: "9007199254740992" }), input.now)).toBeNull();
  });

  it("locks and rechecks exact session, member, grant, canonical resource, policy, and generation in one tenant query", async () => {
    await expect(loadProviderLocalTarget(input)).resolves.toMatchObject({ provider: "neon" });
    const query = new PgDialect().sqlToQuery(executeMock.mock.calls[0]![0]).sql.replace(/\s+/g, " ");
    expect(lockKeyMock).toHaveBeenCalledWith({
      kind: "member", organizationId: input.organizationId, memberId: "member", userId: "user",
    });
    for (const fragment of [
      'session."expires_at" > now()',
      'member."revocation_pending_at" IS NULL',
      'grant."capability" IN (\'use\', \'manage\')',
      'connection."organization_id" = grant."organization_id"',
      'connection."deleted_at" IS NULL',
      'connection."revocation_pending_at" IS NULL',
      'connection."readonly_default" = TRUE',
      'connection."allow_writes" = FALSE',
      'connection."credential_mode" = \'member_local\'',
      'connection."provider" = integration."provider"',
      'connection."provider" = resource."provider"',
      'connection."provider_resource" = resource."resource"',
      'imported."organization_id" = connection."organization_id"',
      'imported."connection_id" = connection."id"',
      'imported."resource_id" = resource."id"',
      'imported."request_hash" = encode(digest(',
      "'integrationGeneration', integration.\"generation\"::text",
      "'integrationId', integration.\"id\"::text",
      "'mode', 'managed'",
      "'name', connection.\"name\"",
      "'organizationId', connection.\"organization_id\"",
      "'resourceId', resource.\"id\"::text",
      'integration."generation" AS "integrationGeneration"',
      'integration."status" = \'active\'',
      'integration."refresh_phase" = \'idle\'',
      'integration."revoked_at" IS NULL',
      'resource."provider" = integration."provider"',
      'integration."provider" IN (\'neon\', \'gcpCloudSql\')',
      'resource."redacted_metadata" -> \'production\' = \'false\'::jsonb',
      'resource."capability_manifest" -> \'importReadOnly\' = \'true\'::jsonb',
      'resource."capability_manifest" -> \'write\' = \'false\'::jsonb',
      'resource."capability_manifest" -> \'managedLease\' = \'true\'::jsonb',
      'FOR UPDATE OF grant, connection, integration, resource, imported',
    ]) expect(query).toContain(fragment);
    expect(query).not.toContain("connection.\"credential_mode\" = 'managed'");
  });

  it("fails closed for a missing, stale, or malformed database result", async () => {
    executeMock.mockResolvedValueOnce({ rows: [] });
    await expect(loadProviderLocalTarget(input)).resolves.toBeNull();
    executeMock.mockResolvedValueOnce({ rows: [row({ integrationGeneration: "0" })] });
    await expect(loadProviderLocalTarget(input)).resolves.toBeNull();
  });
});
