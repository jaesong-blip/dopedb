import { beforeEach, describe, expect, it, vi } from "vitest";

const { andMock, eqMock, inArrayMock, integrationTable, selectMock, whereMock } = vi.hoisted(() => ({
  andMock: vi.fn((...values: unknown[]) => ({ and: values })),
  eqMock: vi.fn((column: unknown, value: unknown) => ({ eq: [column, value] })),
  inArrayMock: vi.fn((column: unknown, values: unknown) => ({ inArray: [column, values] })),
  integrationTable: {
    id: "id",
    organizationId: "organization_id",
    provider: "provider",
    status: "status",
    generation: "generation",
    displayName: "display_name",
    grantedScope: "granted_scope",
    localVerificationTarget: "local_verification_target",
  },
  selectMock: vi.fn(),
  whereMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("drizzle-orm", () => ({ and: andMock, eq: eqMock, inArray: inArrayMock }));
vi.mock("./schema", () => ({ workspaceProviderIntegration: integrationTable }));
vi.mock("./db", () => ({ db: { select: selectMock } }));
import {
  listLocalProviderAuthority,
  projectLocalProviderAuthority,
} from "./provider-local-authority";

const workspaceId = "11111111-1111-4111-8111-111111111111";

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    provider: "neon",
    status: "active",
    generation: 9_007_199_254_740_993n,
    displayName: "Neon read access",
    grantedScope: "projects:read",
    localVerificationTarget: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  const from = vi.fn();
  from.mockReturnValue({ where: whereMock });
  selectMock.mockReturnValue({ from });
  whereMock.mockResolvedValue([]);
});

describe("local provider authority projection", () => {
  it("projects only the exact redacted wire and preserves bigint generations", () => {
    expect(projectLocalProviderAuthority({
      ...row(),
      encryptedCredential: "must-not-project",
      externalAccountId: "must-not-project",
      resource: { raw: "must-not-project" },
    } as ReturnType<typeof row>)).toEqual({
      id: "22222222-2222-4222-8222-222222222222",
      provider: "neon",
      status: "active",
      generation: "9007199254740993",
      displayName: "Neon read access",
      grantedScope: "projects:read",
      reconnectRequired: false,
    });
  });

  it("keeps a reconnect-required legacy GCP row visible and fails closed for an unsafe database row", () => {
    expect(projectLocalProviderAuthority(row({
      provider: "gcpCloudSql",
      status: "reconnect_required",
      generation: 7n,
      grantedScope: null,
      localVerificationTarget: null,
    }))).toMatchObject({
      status: "reconnect_required", generation: "7", grantedScope: "adcWif", reconnectRequired: true,
    });
    expect(() => projectLocalProviderAuthority(row({ displayName: "bad\nname" }))).toThrow(
      "Invalid local provider authority projection",
    );
    expect(() => projectLocalProviderAuthority(row({ provider: "unknown" }))).toThrow(
      "Invalid local provider authority projection",
    );
    expect(() => projectLocalProviderAuthority(row({ id: "known-but-not-a-uuid" }))).toThrow(
      "Invalid local provider authority projection",
    );
  });

  it("pins the tenant predicate in the same minimal projection query", async () => {
    whereMock.mockResolvedValue([row()]);

    await expect(listLocalProviderAuthority(workspaceId)).resolves.toHaveLength(1);

    expect(selectMock).toHaveBeenCalledWith({
      id: "id",
      provider: "provider",
      status: "status",
      generation: "generation",
      displayName: "display_name",
      grantedScope: "granted_scope",
      localVerificationTarget: "local_verification_target",
    });
    expect(eqMock).toHaveBeenCalledWith("organization_id", workspaceId);
    expect(inArrayMock).toHaveBeenCalledWith("status", ["active", "reconnect_required"]);
    expect(andMock).toHaveBeenCalledOnce();
  });

  it("projects only GCP's durable dedicated target and never the envelope or principals", () => {
    const integration = projectLocalProviderAuthority(row({
      provider: "gcpCloudSql",
      grantedScope: "adcWif:target",
      localVerificationTarget: {
        kind: "gcpCloudSql",
        projectId: "sample-project-123",
        instanceId: "instance-one",
      },
    }));
    expect(integration).toMatchObject({ verificationTarget: { instanceId: "instance-one" } });
    expect(JSON.stringify(integration)).not.toContain("opaque-envelope");
    expect(projectLocalProviderAuthority(row({ provider: "gcpCloudSql" }))).toMatchObject({
      status: "reconnect_required", reconnectRequired: true,
    });
  });

  it("rejects malformed, secret-like, and non-GCP durable targets", () => {
    expect(() => projectLocalProviderAuthority(row({ localVerificationTarget: {
      kind: "gcpCloudSql", projectId: "sample-project-123", instanceId: "instance-one", token: "no",
    } }))).toThrow("Invalid local provider authority projection");
    expect(() => projectLocalProviderAuthority(row({ provider: "neon", localVerificationTarget: {
      kind: "gcpCloudSql", projectId: "sample-project-123", instanceId: "instance-one",
    } }))).toThrow("Invalid local provider authority projection");
  });
});
