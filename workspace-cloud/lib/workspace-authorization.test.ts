import { beforeEach, describe, expect, it, vi } from "vitest";

const { authoritativeSessionMock, memberFindFirstMock } = vi.hoisted(() => ({
  authoritativeSessionMock: vi.fn(),
  memberFindFirstMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("./authoritative-session", () => ({ authoritativeSession: authoritativeSessionMock }));
vi.mock("./db", () => ({
  db: {
    query: {
      member: { findFirst: memberFindFirstMock },
    },
  },
}));

import { authorizeWorkspace } from "./workspace-authorization";

const organizationId = "11111111-1111-4111-8111-111111111111";
const request = new Request("https://app.example/api/test");

beforeEach(() => {
  vi.clearAllMocks();
  authoritativeSessionMock.mockResolvedValue({ user: { id: "member-user" } });
  memberFindFirstMock.mockResolvedValue({
    id: "22222222-2222-4222-8222-222222222222",
    organizationId,
    userId: "member-user",
    role: "editor",
    revocationPendingAt: null,
  });
});

describe("workspace authorization revocation gate", () => {
  it("allows an active member with the requested capability", async () => {
    await expect(authorizeWorkspace(request, organizationId, "write"))
      .resolves.toMatchObject({
        ok: true,
        role: "editor",
        accessMode: "write",
      });
  });

  it("fails closed while a member authority change is pending", async () => {
    memberFindFirstMock.mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      organizationId,
      userId: "member-user",
      role: "editor",
      revocationPendingAt: new Date(),
    });

    await expect(authorizeWorkspace(request, organizationId, "read"))
      .resolves.toEqual({
        ok: false,
        status: 403,
        error: "Workspace access denied",
      });
  });

  it("does not disclose a known workspace id outside the caller membership", async () => {
    memberFindFirstMock.mockResolvedValue(null);

    await expect(authorizeWorkspace(request, organizationId, "view"))
      .resolves.toEqual({
        ok: false,
        status: 403,
        error: "Workspace access denied",
      });
  });

  it("blocks a session revoked between client sync attempts", async () => {
    authoritativeSessionMock.mockResolvedValue(null);

    await expect(authorizeWorkspace(request, organizationId, "view"))
      .resolves.toEqual({ ok: false, status: 401, error: "Unauthorized" });
    expect(authoritativeSessionMock).toHaveBeenCalledWith(request);
    expect(memberFindFirstMock).not.toHaveBeenCalled();
  });
});
