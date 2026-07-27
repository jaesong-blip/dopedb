import { beforeEach, describe, expect, it, vi } from "vitest";

const { authorizeMock, importMock } = vi.hoisted(() => ({
  authorizeMock: vi.fn(), importMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("../../../../../../../../lib/env", () => ({ env: { appOrigin: () => "https://app.example" } }));
vi.mock("../../../../../../../../lib/workspace-authorization", () => ({ authorizeWorkspace: authorizeMock }));
vi.mock("../../../../../../../../lib/provider-import-store", () => ({ importProviderReceipt: importMock }));
import { POST } from "./route";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const integrationId = "22222222-2222-4222-8222-222222222222";
const receipt = "33333333-3333-4333-8333-333333333333";
const context = { params: Promise.resolve({ workspaceId, integrationId }) };
function request(body: object) {
  return new Request("https://app.example/import", {
    method: "POST",
    headers: { origin: "https://app.example", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const connection = {
  id: "44444444-4444-4444-8444-444444444444", name: "Neon · app", engine: "postgres",
  provider: "neon", driverId: null, host: "neon.managed.invalid", port: 5432,
  databaseName: "app", sslmode: "verify-full", readonlyDefault: true, allowWrites: false,
  environment: null, schemaGroup: null, credentialMode: "managed", contentRevision: 1,
  updatedAt: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();
  authorizeMock.mockResolvedValue({
    ok: true, role: "admin", accessMode: "manage",
    session: { session: { id: "session" }, user: { id: "user" } }, membership: { id: "member" },
  });
  importMock.mockResolvedValue({ kind: "imported", connection });
});

describe("provider receipt import", () => {
  it("imports only a receipt through the atomic member/session-bound command", async () => {
    const response = await POST(request({ receipt, idempotencyKey: "receipt-import-key-0001", name: "Neon · app" }), context);
    expect(response.status).toBe(201);
    expect(importMock).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: workspaceId, integrationId, receiptId: receipt,
      authority: { sessionId: "session", userId: "user", membershipId: "member", role: "admin" },
    }));
    await expect(response.json()).resolves.toMatchObject({ connection: { credentialMode: "managed" } });
  });

  it("rejects a known external id before any import command", async () => {
    const response = await POST(request({ receipt: "known-external-project-id", idempotencyKey: "receipt-import-key-0003", name: "app" }), context);
    expect(response.status).toBe(400);
    expect(importMock).not.toHaveBeenCalled();
  });

  it("returns one generic conflict for stale, replayed, foreign, or changed-key receipt claims", async () => {
    importMock.mockResolvedValueOnce({ kind: "invalid_receipt" });
    importMock.mockResolvedValueOnce({ kind: "idempotency_conflict" });
    const stale = await POST(request({ receipt, idempotencyKey: "receipt-import-key-0002", name: "app" }), context);
    const foreign = await POST(request({ receipt, idempotencyKey: "receipt-import-key-0004", name: "app" }), context);
    expect(stale.status).toBe(409);
    expect(foreign.status).toBe(409);
    await expect(stale.json()).resolves.toEqual({ error: "Discovery receipt is invalid, expired, or already used" });
  });

  it("does not relabel an infrastructure transaction failure as a receipt conflict", async () => {
    importMock.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(POST(request({ receipt, idempotencyKey: "receipt-import-key-0009", name: "app" }), context))
      .rejects.toThrow("database unavailable");
  });
});
