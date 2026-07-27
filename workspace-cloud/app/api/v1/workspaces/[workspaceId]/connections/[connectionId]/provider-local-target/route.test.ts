import { beforeEach, describe, expect, it, vi } from "vitest";

const { authorizeMock, targetMock } = vi.hoisted(() => ({
  authorizeMock: vi.fn(),
  targetMock: vi.fn(),
}));

vi.mock("../../../../../../../../lib/workspace-authorization", () => ({
  authorizeWorkspaceConnection: authorizeMock,
}));
vi.mock("../../../../../../../../lib/provider-local-target", () => ({
  loadProviderLocalTarget: targetMock,
}));

import { GET } from "./route";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const connectionId = "22222222-2222-4222-8222-222222222222";
const context = { params: Promise.resolve({ workspaceId, connectionId }) };
const target = {
  connectionId, connectionRevision: "7", integrationId: "33333333-3333-4333-8333-333333333333",
  integrationGeneration: "9", provider: "neon", resourceFingerprint: "a".repeat(64),
  target: { project: "project", branch: "branch", database: "app", engine: "postgres", schemas: ["public"] },
  authorityExpiresAt: "2026-07-27T00:05:00.000Z",
};

function authorization() {
  return {
    ok: true, role: "admin", accessMode: "manage", connectionCapability: "use",
    session: { session: { id: "session" }, user: { id: "user" } }, membership: { id: "member" },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  authorizeMock.mockResolvedValue(authorization());
  targetMock.mockResolvedValue(target);
});

describe("GET provider local target", () => {
  it("requires use authorization and returns the exact private secret-free target", async () => {
    const response = await GET(new Request("https://app.example/provider-local-target"), context);
    expect(authorizeMock).toHaveBeenCalledWith(expect.any(Request), workspaceId, connectionId, "use");
    expect(targetMock).toHaveBeenCalledWith({
      organizationId: workspaceId, connectionId,
      authority: { sessionId: "session", userId: "user", membershipId: "member" },
    });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ target });
  });

  it("does not query a known or cross-workspace connection before authorization", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: false, status: 403, error: "Connection grant denied" });
    const denied = await GET(new Request("https://app.example/provider-local-target"), context);
    expect(denied.status).toBe(403);
    expect(targetMock).not.toHaveBeenCalled();
    const invalid = await GET(new Request("https://app.example/provider-local-target"), {
      params: Promise.resolve({ workspaceId, connectionId: "known-external-id" }),
    });
    expect(invalid.status).toBe(400);
    expect(targetMock).not.toHaveBeenCalled();
  });

  it("fails closed without leaking database or provider details for stale policy rows and database errors", async () => {
    targetMock.mockResolvedValueOnce(null);
    const unavailable = await GET(new Request("https://app.example/provider-local-target"), context);
    expect(unavailable.status).toBe(409);
    await expect(unavailable.json()).resolves.toEqual({ error: "Provider local target is unavailable" });
    targetMock.mockRejectedValueOnce(new Error("token=never-return-this"));
    const failed = await GET(new Request("https://app.example/provider-local-target"), context);
    expect(failed.status).toBe(500);
    await expect(failed.json()).resolves.toEqual({ error: "Provider local target is temporarily unavailable" });
  });
});
