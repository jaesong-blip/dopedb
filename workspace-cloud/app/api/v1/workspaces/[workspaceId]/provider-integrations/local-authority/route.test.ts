import { beforeEach, describe, expect, it, vi } from "vitest";

const { authorizeWorkspaceMock, listLocalProviderAuthorityMock } = vi.hoisted(() => ({
  authorizeWorkspaceMock: vi.fn(),
  listLocalProviderAuthorityMock: vi.fn(),
}));

vi.mock("../../../../../../../lib/workspace-authorization", () => ({
  authorizeWorkspace: authorizeWorkspaceMock,
}));
vi.mock("../../../../../../../lib/provider-local-authority", () => ({
  listLocalProviderAuthority: listLocalProviderAuthorityMock,
}));

import { GET } from "./route";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const otherWorkspaceId = "99999999-9999-4999-8999-999999999999";

function context(id = workspaceId) {
  return { params: Promise.resolve({ workspaceId: id }) };
}

function viewer() {
  return {
    ok: true,
    session: { user: { id: "viewer-user" } },
    membership: { id: "viewer-member" },
    role: "viewer",
    accessMode: "view",
  };
}

function integration(overrides: Record<string, unknown> = {}) {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    provider: "neon",
    status: "active",
    generation: "9007199254740993",
    displayName: "Neon read access",
    grantedScope: "projects:read",
    reconnectRequired: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  authorizeWorkspaceMock.mockResolvedValue(viewer());
  listLocalProviderAuthorityMock.mockResolvedValue([integration()]);
});

describe("GET local provider authority", () => {
  it("rejects an unauthenticated request before the projection", async () => {
    authorizeWorkspaceMock.mockResolvedValue({ ok: false, status: 401, error: "Unauthorized" });

    const response = await GET(new Request("https://app.example/local-authority"), context());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(listLocalProviderAuthorityMock).not.toHaveBeenCalled();
  });

  it("rejects a revoked member before the projection", async () => {
    authorizeWorkspaceMock.mockResolvedValue({ ok: false, status: 403, error: "Workspace access denied" });

    const response = await GET(new Request("https://app.example/local-authority"), context());

    expect(response.status).toBe(403);
    expect(listLocalProviderAuthorityMock).not.toHaveBeenCalled();
  });

  it("allows a viewer and returns only the exact private redacted wire", async () => {
    const response = await GET(new Request("https://app.example/local-authority"), context());

    expect(authorizeWorkspaceMock).toHaveBeenCalledWith(expect.any(Request), workspaceId, "view");
    expect(listLocalProviderAuthorityMock).toHaveBeenCalledWith(workspaceId);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ integrations: [integration()] });
  });

  it("uses the requested workspace as the sole projection tenant boundary", async () => {
    listLocalProviderAuthorityMock.mockResolvedValue([]);

    const response = await GET(
      new Request("https://app.example/local-authority"),
      context(otherWorkspaceId),
    );

    expect(response.status).toBe(200);
    expect(listLocalProviderAuthorityMock).toHaveBeenCalledWith(otherWorkspaceId);
    await expect(response.json()).resolves.toEqual({ integrations: [] });
  });

  it("maps reconnect state without leaking provider or database error details", async () => {
    listLocalProviderAuthorityMock.mockResolvedValueOnce([
      integration({ provider: "gcpCloudSql", status: "reconnect_required", reconnectRequired: true }),
    ]);
    const reconnect = await GET(new Request("https://app.example/local-authority"), context());
    await expect(reconnect.json()).resolves.toEqual({ integrations: [
      integration({ provider: "gcpCloudSql", status: "reconnect_required", reconnectRequired: true }),
    ] });

    listLocalProviderAuthorityMock.mockRejectedValueOnce(
      new Error("database password=never-return-this"),
    );
    const failed = await GET(new Request("https://app.example/local-authority"), context());
    expect(failed.status).toBe(500);
    await expect(failed.json()).resolves.toEqual({
      error: "Provider authority is temporarily unavailable",
    });
  });

  it("returns a GCP target without credential or principal fields", async () => {
    listLocalProviderAuthorityMock.mockResolvedValueOnce([integration({
      provider: "gcpCloudSql",
      verificationTarget: {
        kind: "gcpCloudSql", projectId: "sample-project-123", instanceId: "instance-one",
      },
    })]);
    const response = await GET(new Request("https://app.example/local-authority"), context());
    const body = await response.json() as { integrations: Array<Record<string, unknown>> };
    expect(body.integrations[0].verificationTarget).toEqual({
      kind: "gcpCloudSql",
      projectId: "sample-project-123",
      instanceId: "instance-one",
    });
    expect(JSON.stringify(body)).not.toMatch(/credential|token|email|subject|workload|projectNumber/i);
  });
});
