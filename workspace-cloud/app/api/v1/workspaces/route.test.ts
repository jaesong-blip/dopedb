import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authoritativeSession: vi.fn(),
  listOrganizations: vi.fn(),
  createOrganization: vi.fn(),
  select: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("../../../../lib/auth", () => ({ auth: { api: {
  listOrganizations: mocks.listOrganizations,
  createOrganization: mocks.createOrganization,
} } }));
vi.mock("../../../../lib/authoritative-session", () => ({
  authoritativeSession: mocks.authoritativeSession,
}));
vi.mock("../../../../lib/db", () => ({ db: {
  select: mocks.select,
} }));
vi.mock("../../../../lib/env", () => ({ env: { appOrigin: () => "https://app.example" } }));

import { GET, POST } from "./route";

function rolesQuery(rows: unknown[]) {
  return {
    from: () => ({ where: vi.fn().mockResolvedValue(rows) }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authoritativeSession.mockResolvedValue({
    user: { id: "user-1" },
    session: { activeOrganizationId: "org-1" },
  });
  mocks.listOrganizations.mockResolvedValue([]);
  mocks.select.mockReturnValue(rolesQuery([]));
});

describe("/api/v1/workspaces authoritative session boundary", () => {
  it("does not enumerate organizations after the durable session has been revoked", async () => {
    const request = new Request("https://app.example/api/v1/workspaces");
    mocks.authoritativeSession.mockResolvedValue(null);

    const response = await GET(request);

    expect(response.status).toBe(401);
    expect(mocks.listOrganizations).not.toHaveBeenCalled();
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.authoritativeSession).toHaveBeenCalledWith(request);
  });

  it("does not create a workspace after the durable session has been revoked", async () => {
    const request = new Request("https://app.example/api/v1/workspaces", {
      method: "POST",
      headers: { origin: "https://app.example", "content-type": "application/json" },
      body: JSON.stringify({ name: "Safe workspace" }),
    });
    mocks.authoritativeSession.mockResolvedValue(null);

    const response = await POST(request);

    expect(response.status).toBe(401);
    expect(mocks.createOrganization).not.toHaveBeenCalled();
    expect(mocks.authoritativeSession).toHaveBeenCalledWith(request);
  });
});
