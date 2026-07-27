import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  activeMock,
  authorizeMock,
  discoverMock,
  openProofMock,
  projectionMock,
  receiptMock,
  revalidateMock,
  sealProofMock,
} = vi.hoisted(() => ({
  activeMock: vi.fn(),
  authorizeMock: vi.fn(),
  discoverMock: vi.fn(),
  openProofMock: vi.fn(),
  projectionMock: vi.fn(),
  receiptMock: vi.fn(),
  revalidateMock: vi.fn(),
  sealProofMock: vi.fn(),
}));

vi.mock("../../../../../../../../lib/env", () => ({
  env: { appOrigin: () => "https://app.example" },
}));
vi.mock("../../../../../../../../lib/provider-discovery-proof", () => ({
  canonicalProviderDiscoverySelection: (
    _provider: string,
    _kind: string,
    selection: Record<string, string>,
  ) => selection,
  openProviderDiscoveryProof: openProofMock,
  sameProviderResourceItem: (left: Record<string, unknown>, right: Record<string, unknown>) => (
    JSON.stringify(left) === JSON.stringify(right)
  ),
  sealProviderDiscoveryProof: sealProofMock,
}));
vi.mock("../../../../../../../../lib/provider-integrations", () => ({
  activeProviderIntegration: activeMock,
  discoverProviderResources: discoverMock,
  discoveredProviderResource: projectionMock,
  recordProviderDiscoveryReceipt: receiptMock,
  revalidateProviderDiscoveryAuthority: revalidateMock,
}));
vi.mock("../../../../../../../../lib/providers/gcp-cloud-sql", () => ({
  vercelOidcToken: () => null,
}));
vi.mock("../../../../../../../../lib/workspace-authorization", () => ({
  authorizeWorkspace: authorizeMock,
}));

import { GET, POST } from "./route";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const integrationId = "22222222-2222-4222-8222-222222222222";
const context = { params: Promise.resolve({ workspaceId, integrationId }) };
const receiptId = "33333333-3333-4333-8333-333333333333";
const proofExpiresAt = Date.parse("2026-07-27T00:05:00.000Z");
const item = {
  id: "database-id",
  value: "app",
  name: "app",
  kind: "postgres",
  production: false,
  ready: true,
};

function proof(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: workspaceId,
    integrationId,
    integrationGeneration: 7n,
    receiptId,
    memberId: "member-id",
    userId: "user-id",
    sessionId: "session-id",
    provider: "neon",
    kind: "databases",
    selection: { project: "p", branch: "b" },
    item,
    expiresAt: proofExpiresAt,
    ...overrides,
  };
}

function getRequest() {
  return new Request(
    `https://app.example/resources?kind=databases&project=p&branch=b`,
  );
}

function postRequest(
  body: unknown = { selectionProof: "opaque-proof" },
  headers: Record<string, string> = { origin: "https://app.example" },
) {
  return new Request("https://app.example/resources", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  authorizeMock.mockResolvedValue({
    ok: true,
    role: "admin",
    membership: { id: "member-id" },
    session: { session: { id: "session-id" }, user: { id: "user-id" } },
  });
  activeMock.mockResolvedValue({
    id: integrationId,
    organizationId: workspaceId,
    provider: "neon",
    generation: 7n,
  });
  discoverMock.mockResolvedValue([item]);
  projectionMock.mockReturnValue({ fingerprint: "a".repeat(64) });
  receiptMock.mockResolvedValue({
    id: receiptId,
    expiresAt: new Date("2026-07-27T00:05:00.000Z"),
  });
  revalidateMock.mockResolvedValue(true);
  sealProofMock.mockReturnValue("opaque-proof");
  openProofMock.mockReturnValue(proof());
});

describe("read-only provider discovery and one-leaf receipt finalization", () => {
  it("lists redacted resources without durable writes and seals only an importable leaf", async () => {
    const response = await GET(getRequest(), context);

    expect(response.status).toBe(200);
    expect(discoverMock).toHaveBeenCalledWith(expect.objectContaining({
      integration: expect.objectContaining({ id: integrationId, generation: 7n }),
      kind: "databases",
      selection: { project: "p", branch: "b" },
    }));
    expect(sealProofMock).toHaveBeenCalledOnce();
    expect(sealProofMock).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: workspaceId,
      integrationId,
      integrationGeneration: 7n,
      memberId: "member-id",
      userId: "user-id",
      sessionId: "session-id",
      item,
    }));
    expect(receiptMock).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      resources: [{ ...item, selectionProof: "opaque-proof" }],
    });
  });

  it("does not issue a proof when the policy projection declines the resource", async () => {
    projectionMock.mockReturnValue(null);
    const response = await GET(getRequest(), context);

    expect(response.status).toBe(200);
    expect(sealProofMock).not.toHaveBeenCalled();
    expect(receiptMock).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({ resources: [item] });
  });

  it("returns no raw items when authority is lost after provider discovery", async () => {
    revalidateMock.mockResolvedValueOnce(false);
    const response = await GET(getRequest(), context);
    expect(response.status).toBe(403);
    expect(discoverMock).toHaveBeenCalledOnce();
    expect(sealProofMock).not.toHaveBeenCalled();
    expect(receiptMock).not.toHaveBeenCalled();
  });

  it("rejects malformed and duplicate discovery queries before provider I/O", async () => {
    const malformed = await GET(new Request(
      "https://app.example/resources?kind=databases&kind=branches&project=p",
    ), context);
    expect(malformed.status).toBe(400);
    expect(authorizeMock).not.toHaveBeenCalled();
    expect(discoverMock).not.toHaveBeenCalled();
  });

  it("rejects missing and cross-site origins before authorization or provider I/O", async () => {
    expect((await POST(postRequest(undefined, {}), context)).status).toBe(403);
    expect((await POST(postRequest(undefined, {
      origin: "https://attacker.example",
    }), context)).status).toBe(403);
    expect(authorizeMock).not.toHaveBeenCalled();
    expect(discoverMock).not.toHaveBeenCalled();
    expect(receiptMock).not.toHaveBeenCalled();
  });

  it("accepts bearer mutation authority without Origin", async () => {
    const response = await POST(postRequest(undefined, {
      authorization: "Bearer api-token",
    }), context);
    expect(response.status).toBe(200);
    expect(receiptMock).toHaveBeenCalledOnce();
  });

  it("revalidates the exact sealed leaf and mints at most one receipt", async () => {
    const response = await POST(postRequest(), context);

    expect(response.status).toBe(200);
    expect(openProofMock).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: workspaceId,
      integrationId,
      proof: "opaque-proof",
    }));
    expect(discoverMock).toHaveBeenCalledOnce();
    expect(discoverMock).toHaveBeenCalledWith(expect.objectContaining({
      kind: "databases",
      selection: { project: "p", branch: "b" },
    }));
    expect(receiptMock).toHaveBeenCalledOnce();
    expect(receiptMock).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: workspaceId,
      integrationId,
      integrationGeneration: 7n,
      receiptId,
      expiresAt: new Date(proofExpiresAt),
      projection: { fingerprint: "a".repeat(64) },
    }));
    await expect(response.json()).resolves.toEqual({
      receipt: receiptId,
      receiptExpiresAt: "2026-07-27T00:05:00.000Z",
    });
  });

  it("does not accept raw external resource identifiers in the finalization body", async () => {
    const response = await POST(postRequest({
      kind: "databases",
      selection: { project: "p", branch: "b" },
      resourceId: "crafted",
    }), context);
    expect(response.status).toBe(400);
    expect(openProofMock).not.toHaveBeenCalled();
    expect(activeMock).not.toHaveBeenCalled();
    expect(discoverMock).not.toHaveBeenCalled();
    expect(receiptMock).not.toHaveBeenCalled();
  });

  it.each([
    ["memberId", "other-member"],
    ["userId", "other-user"],
    ["sessionId", "other-session"],
    ["provider", "gcpCloudSql"],
  ])("rejects a proof with a foreign %s before provider I/O", async (field, value) => {
    openProofMock.mockReturnValue(proof({ [field]: value }));
    expect((await POST(postRequest(), context)).status).toBe(409);
    expect(discoverMock).not.toHaveBeenCalled();
    expect(receiptMock).not.toHaveBeenCalled();
  });

  it("rejects duplicate exact rediscovery matches and a declined final projection", async () => {
    discoverMock.mockResolvedValueOnce([item, { ...item }]);
    expect((await POST(postRequest(), context)).status).toBe(409);
    expect(receiptMock).not.toHaveBeenCalled();

    vi.clearAllMocks();
    authorizeMock.mockResolvedValue({
      ok: true,
      role: "admin",
      membership: { id: "member-id" },
      session: { session: { id: "session-id" }, user: { id: "user-id" } },
    });
    activeMock.mockResolvedValue({
      id: integrationId,
      organizationId: workspaceId,
      provider: "neon",
      generation: 7n,
    });
    openProofMock.mockReturnValue(proof());
    discoverMock.mockResolvedValue([item]);
    revalidateMock.mockResolvedValue(true);
    projectionMock.mockReturnValue(null);
    expect((await POST(postRequest(), context)).status).toBe(409);
    expect(receiptMock).not.toHaveBeenCalled();
  });

  it("fails closed when final receipt recording loses authority", async () => {
    receiptMock.mockResolvedValue(null);
    expect((await POST(postRequest(), context)).status).toBe(403);
    expect(receiptMock).toHaveBeenCalledOnce();
  });

  it("reuses the proof-bound receipt identity on an exact POST replay", async () => {
    const first = await POST(postRequest(), context);
    const second = await POST(postRequest(), context);
    expect(await first.json()).toEqual(await second.json());
    expect(receiptMock).toHaveBeenCalledTimes(2);
    expect(receiptMock.mock.calls[0]?.[0]).toEqual(receiptMock.mock.calls[1]?.[0]);
    expect(receiptMock.mock.calls[0]?.[0]).toMatchObject({
      receiptId,
      expiresAt: new Date(proofExpiresAt),
    });
  });

  it("rejects changed generations and remote leaf changes without a durable write", async () => {
    openProofMock.mockReturnValueOnce(proof({ integrationGeneration: 6n }));
    expect((await POST(postRequest(), context)).status).toBe(409);
    expect(discoverMock).not.toHaveBeenCalled();
    expect(receiptMock).not.toHaveBeenCalled();

    vi.clearAllMocks();
    authorizeMock.mockResolvedValue({
      ok: true,
      role: "admin",
      membership: { id: "member-id" },
      session: { session: { id: "session-id" }, user: { id: "user-id" } },
    });
    activeMock.mockResolvedValue({
      id: integrationId,
      organizationId: workspaceId,
      provider: "neon",
      generation: 7n,
    });
    openProofMock.mockReturnValue(proof());
    discoverMock.mockResolvedValue([{ ...item, ready: false }]);
    revalidateMock.mockResolvedValue(true);
    expect((await POST(postRequest(), context)).status).toBe(409);
    expect(receiptMock).not.toHaveBeenCalled();
  });
});
