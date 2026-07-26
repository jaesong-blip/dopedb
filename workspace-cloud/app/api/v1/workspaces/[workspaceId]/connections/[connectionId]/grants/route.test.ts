import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  clearClaimMock,
  claimMock,
  executeMock,
  authorizeMock,
  memberFindMock,
  releaseClaimMock,
  renewClaimMock,
  revokeLeasesMock,
} = vi.hoisted(() => ({
  clearClaimMock: vi.fn(),
  claimMock: vi.fn(),
  executeMock: vi.fn(),
  authorizeMock: vi.fn(),
  memberFindMock: vi.fn(),
  releaseClaimMock: vi.fn(),
  renewClaimMock: vi.fn(),
  revokeLeasesMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("../../../../../../../../lib/db", () => ({
  db: { execute: executeMock, query: { member: { findFirst: memberFindMock } } },
}));
vi.mock("../../../../../../../../lib/env", () => ({ env: { appOrigin: () => "https://app.example" } }));
vi.mock("../../../../../../../../lib/provider-integrations", () => ({
  revokeActiveLeases: revokeLeasesMock,
}));
vi.mock("../../../../../../../../lib/revocation-gates", () => ({
  claimRevocationGate: claimMock,
  clearRevocationGate: clearClaimMock,
  releaseRevocationGateClaim: releaseClaimMock,
  renewRevocationGateClaim: renewClaimMock,
  revocationGateLockKey: (target: { organizationId: string; userId: string }) =>
    `member:${target.organizationId}:${target.userId}`,
}));
vi.mock("../../../../../../../../lib/workspace-authorization", () => ({
  authorizeWorkspaceConnection: authorizeMock,
}));

import { DELETE, POST } from "./route";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const connectionId = "22222222-2222-4222-8222-222222222222";
const context = { params: Promise.resolve({ workspaceId, connectionId }) };
const authorization = {
  ok: true,
  role: "viewer",
  accessMode: "manage",
  connectionCapability: "manage",
  session: { session: { id: "session-id" }, user: { id: "actor-user" } },
  membership: { id: "actor-member" },
};

beforeEach(() => {
  vi.clearAllMocks();
  authorizeMock.mockResolvedValue(authorization);
  memberFindMock.mockResolvedValue({ id: "target-member", userId: "target-user" });
  claimMock.mockResolvedValue({
    kind: "member",
    organizationId: workspaceId,
    memberId: "target-member",
    userId: "target-user",
    claimId: "33333333-3333-4333-8333-333333333333",
    claimedAt: new Date(),
    pendingAt: new Date(),
    firstPending: true,
  });
  clearClaimMock.mockResolvedValue(true);
  releaseClaimMock.mockResolvedValue(true);
  renewClaimMock.mockResolvedValue({});
  revokeLeasesMock.mockResolvedValue({ revoked: 1, deferred: 0 });
  executeMock.mockResolvedValue({ rows: [{ capability: "use", memberId: "target-member" }] });
});

describe("connection grant authority", () => {
  it("revalidates session, member, and manage grant under deterministic member locks", async () => {
    const response = await POST(new Request("https://app.example", {
      method: "POST",
      headers: { origin: "https://app.example", "content-type": "application/json" },
      body: JSON.stringify({ memberId: "target-member", capability: "use" }),
    }), context);

    expect(response.status).toBe(200);
    expect(authorizeMock).toHaveBeenCalledWith(expect.any(Request), workspaceId, connectionId, "manage");
    const query = new PgDialect().sqlToQuery(executeMock.mock.calls[0]![0]);
    expect(query.sql).toContain("pg_advisory_xact_lock");
    expect(query.sql).toContain("ORDER BY lock_key");
    expect(query.sql).toContain("count(*) AS lock_count");
    expect(query.sql).toContain('grant."capability" = \'manage\'');
    expect(query.sql).toContain('session."expires_at" > now()');
    expect(query.sql).toContain('member."revocation_pending_at" IS NULL');
    expect(query.sql).toContain('ON CONFLICT ("organization_id", "connection_id", "member_id")');
  });

  it("uses the same member gate as lease delivery, revokes target leases, and clears only after the grant CAS", async () => {
    const response = await DELETE(new Request("https://app.example?memberId=target-member", {
      method: "DELETE", headers: { origin: "https://app.example" },
    }), context);

    expect(response.status).toBe(204);
    expect(claimMock).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: workspaceId,
      memberId: "target-member",
      userId: "target-user",
    }));
    expect(revokeLeasesMock).toHaveBeenCalledWith({
      organizationId: workspaceId,
      connectionId,
      userId: "target-user",
    });
    expect(revokeLeasesMock.mock.invocationCallOrder[0]).toBeLessThan(
      executeMock.mock.invocationCallOrder[0],
    );
    expect(executeMock.mock.invocationCallOrder[0]).toBeLessThan(
      clearClaimMock.mock.invocationCallOrder[0],
    );
    const query = new PgDialect().sqlToQuery(executeMock.mock.calls[0]![0]);
    expect(query.params).toContain("member:11111111-1111-4111-8111-111111111111:target-user");
    expect(query.sql).toContain('member."revocation_claim_id" =');
    expect(query.sql).toContain("USING actor, target");
  });

  it("keeps the target member gate pending when provider lease revocation is deferred", async () => {
    revokeLeasesMock.mockResolvedValueOnce({ revoked: 0, deferred: 1 });

    const response = await DELETE(new Request("https://app.example?memberId=target-member", {
      method: "DELETE", headers: { origin: "https://app.example" },
    }), context);

    expect(response.status).toBe(409);
    expect(executeMock).not.toHaveBeenCalled();
    expect(renewClaimMock).toHaveBeenCalledOnce();
    expect(clearClaimMock).not.toHaveBeenCalled();
  });

  it("does not touch a target or write an audit when the fresh grant is absent", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: false, status: 403, error: "Connection grant denied" });
    const response = await DELETE(new Request("https://app.example?memberId=target-member", {
      method: "DELETE", headers: { origin: "https://app.example" },
    }), context);
    expect(response.status).toBe(403);
    expect(executeMock).not.toHaveBeenCalled();
  });
});
