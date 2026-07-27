// OAuth I/O is untrusted until the centralized mutation store revalidates the
// exact live workspace authority and integration generation.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(), claim: vi.fn(), consumed: vi.fn(), exchange: vi.fn(),
  find: vi.fn(), authoritativeSession: vi.fn(), persist: vi.fn(), release: vi.fn(),
  revokeLeases: vi.fn(), revokeOld: vi.fn(), revokeNew: vi.fn(), seal: vi.fn(), inspect: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("../../../../../../lib/authoritative-session", () => ({ authoritativeSession: mocks.authoritativeSession }));
vi.mock("../../../../../../lib/db", () => ({ db: {
  delete: vi.fn(() => ({ where: vi.fn(() => ({ returning: mocks.consumed })) })),
  query: { workspaceProviderIntegration: { findFirst: mocks.find } },
} }));
vi.mock("../../../../../../lib/env", () => ({ env: { appOrigin: () => "https://app.example" } }));
vi.mock("../../../../../../lib/providers/planetscale", () => ({
  exchangePlanetScaleCode: mocks.exchange, inspectPlanetScaleToken: mocks.inspect,
  revokePlanetScaleAuthorization: mocks.revokeNew,
}));
vi.mock("../../../../../../lib/provider-integrations", () => ({
  revokeActiveLeases: mocks.revokeLeases, revokeProviderAuthorization: mocks.revokeOld,
}));
vi.mock("../../../../../../lib/provider-integration-mutation-store", () => ({ persistProviderIntegration: mocks.persist }));
vi.mock("../../../../../../lib/revocation-gates", () => ({ claimRevocationGate: mocks.claim, releaseRevocationGateClaim: mocks.release }));
vi.mock("../../../../../../lib/secret-envelope", () => ({ sealProviderCredential: mocks.seal }));
vi.mock("../../../../../../lib/workspace-authorization", () => ({ authorizeWorkspace: mocks.authorize }));
import { GET } from "./route";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const integrationId = "22222222-2222-4222-8222-222222222222";
const scope = "read_organizations read_databases read_branches manage_passwords manage_production_branch_passwords";
const existing = { id: integrationId, organizationId: workspaceId, provider: "planetScale", encryptedCredential: "sealed-old", credentialExpiresAt: null, status: "active", revokedAt: null, revocationPendingAt: null, updatedAt: new Date("2026-07-23T00:00:00Z") };
const claim = { kind: "integration", organizationId: workspaceId, integrationId, claimId: "33333333-3333-4333-8333-333333333333", claimedAt: new Date(), pendingAt: new Date(), firstPending: true };
const ambiguousDisconnectClaimId = "44444444-4444-4444-8444-444444444444";
function request() { return new Request(`https://app.example/api/v1/providers/planet-scale/callback?state=${"s".repeat(43)}&code=valid-code`); }
function status(response: Response) { return new URL(response.headers.get("location") ?? "https://bad").searchParams.get("status"); }

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authoritativeSession.mockResolvedValue({ user: { id: "admin-user" } });
  mocks.consumed.mockResolvedValue([{ organizationId: workspaceId }]);
  mocks.authorize.mockResolvedValue({ ok: true, session: { user: { id: "admin-user" }, session: { id: "session-id" } }, membership: { id: "member-id" }, role: "admin" });
  mocks.exchange.mockResolvedValue({ accessToken: "rotated-access", refreshToken: "rotated-refresh", expiresAt: "2026-07-24T01:00:00.000Z", scope });
  mocks.inspect.mockResolvedValue({ subject: "org-account-subject", scope });
  mocks.find.mockResolvedValue(existing); mocks.seal.mockReturnValue("sealed-new");
  mocks.claim.mockResolvedValue(claim); mocks.release.mockResolvedValue(true);
  mocks.revokeLeases.mockResolvedValue({ revoked: 2, deferred: 0 });
  mocks.persist.mockResolvedValue({ ok: true, id: integrationId });
  mocks.revokeOld.mockResolvedValue(undefined);
  mocks.revokeNew.mockResolvedValue(undefined);
});

describe("PlanetScale OAuth mutation boundary", () => {
  it("does not consume OAuth state or call the provider after authoritative session loss", async () => {
    mocks.authoritativeSession.mockResolvedValue(null);

    const response = await GET(request());

    expect(new URL(response.headers.get("location") ?? "https://bad").pathname).toBe("/auth/sign-in");
    expect(mocks.consumed).not.toHaveBeenCalled();
    expect(mocks.exchange).not.toHaveBeenCalled();
    expect(mocks.authorize).not.toHaveBeenCalled();
  });

  it("revalidates and persists reconnect only through the single store operation", async () => {
    const response = await GET(request());
    expect(status(response)).toBe("connected");
    expect(mocks.claim).toHaveBeenCalledWith({ kind: "integration", organizationId: workspaceId, integrationId });
    expect(mocks.revokeLeases.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.persist.mock.invocationCallOrder[0],
    );
    expect(mocks.persist).toHaveBeenCalledWith(expect.objectContaining({
      provider: "planetScale", existing, reconnectClaimId: claim.claimId,
      credentialExpiresAt: expect.any(Date), principalClaims: [],
    }));
    expect(mocks.revokeOld).toHaveBeenCalledWith(existing);
  });

  it("releases the gate, writes no durable response and revokes only the new token after authority loss", async () => {
    mocks.persist.mockResolvedValue({ ok: false });
    const response = await GET(request());
    expect(status(response)).toBe("failed");
    expect(mocks.release).toHaveBeenCalledWith(claim);
    expect(mocks.revokeOld).not.toHaveBeenCalled();
    expect(mocks.revokeNew).toHaveBeenCalledWith("rotated-refresh");
  });

  it("does not persist or expose a rotated credential when lease revocation is deferred", async () => {
    mocks.revokeLeases.mockResolvedValue({ revoked: 0, deferred: 1 });
    const response = await GET(request());
    expect(status(response)).toBe("failed");
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(mocks.revokeNew).toHaveBeenCalledWith("rotated-refresh");
  });

  it("lets fresh OAuth safely supersede an ambiguous disconnect without replaying revocation", async () => {
    const ambiguous = {
      ...existing,
      status: "reconnect_required",
      revocationPendingAt: new Date("2026-07-27T00:00:00Z"),
      revocationClaimId: ambiguousDisconnectClaimId,
      generation: 8n,
    };
    mocks.find.mockResolvedValue(ambiguous);

    const response = await GET(request());

    expect(status(response)).toBe("connected");
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.revokeLeases).not.toHaveBeenCalled();
    expect(mocks.persist).toHaveBeenCalledWith(expect.objectContaining({
      existing: ambiguous,
      reconnectClaimId: ambiguousDisconnectClaimId,
    }));
    expect(mocks.revokeOld).not.toHaveBeenCalled();
  });
});
