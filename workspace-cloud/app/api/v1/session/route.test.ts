import { beforeEach, describe, expect, it, vi } from "vitest";

const authoritativeSessionMock = vi.hoisted(() => vi.fn());

vi.mock("server-only", () => ({}));
vi.mock("../../../../lib/authoritative-session", () => ({
  authoritativeSession: authoritativeSessionMock,
}));

import { GET } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/v1/session", () => {
  it("stops before emitting private identity when the durable session is revoked", async () => {
    const request = new Request("https://app.example/api/v1/session");
    authoritativeSessionMock.mockResolvedValue(null);

    const response = await GET(request);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(authoritativeSessionMock).toHaveBeenCalledWith(request);
  });

  it("returns only the current authoritative identity with private cache headers", async () => {
    authoritativeSessionMock.mockResolvedValue({
      user: { id: "user-1", email: "member@example.test", name: "Member" },
      session: { id: "session-1", activeOrganizationId: "org-1" },
    });

    const response = await GET(new Request("https://app.example/api/v1/session"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("private");
    expect(await response.json()).toEqual({
      user: { id: "user-1", email: "member@example.test", displayName: "Member" },
      session: { id: "session-1", activeWorkspaceId: "org-1" },
    });
  });
});
