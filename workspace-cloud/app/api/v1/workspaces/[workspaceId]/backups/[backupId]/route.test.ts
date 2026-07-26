import { beforeEach, describe, expect, it, vi } from "vitest";

const { authorizeWorkspaceMock, executeMock } = vi.hoisted(() => ({
  authorizeWorkspaceMock: vi.fn(),
  executeMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("../../../../../../../lib/db", () => ({ db: { execute: executeMock } }));
vi.mock("../../../../../../../lib/env", () => ({ env: { appOrigin: () => "https://app.example" } }));
vi.mock("../../../../../../../lib/workspace-authorization", () => ({
  authorizeWorkspace: authorizeWorkspaceMock,
}));

import { DELETE } from "./route";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const backupId = "22222222-2222-4222-8222-222222222222";
const context = { params: Promise.resolve({ workspaceId, backupId }) };
const request = () => new Request(
  `https://app.example/api/v1/workspaces/${workspaceId}/backups/${backupId}`,
  { method: "DELETE", headers: { origin: "https://app.example" } },
);

beforeEach(() => {
  vi.clearAllMocks();
  authorizeWorkspaceMock.mockResolvedValue({
    ok: true, role: "admin", accessMode: "manage",
    session: { session: { id: "session-id" }, user: { id: "admin-user" } }, membership: { id: "member-id" },
  });
});

describe("workspace backup deletion", () => {
  it("audits only the row returned by the tenant-scoped tombstone CTE", async () => {
    executeMock.mockResolvedValue({ rows: [{ id: backupId }] });

    expect((await DELETE(request(), context)).status).toBe(204);
    expect(executeMock).toHaveBeenCalledOnce();
  });

  it("does not report or audit deletion for absent or already tombstoned backups", async () => {
    executeMock.mockResolvedValue({ rows: [] });

    const response = await DELETE(request(), context);

    expect(response.status).toBe(404);
    expect(executeMock).toHaveBeenCalledOnce();
  });
});
