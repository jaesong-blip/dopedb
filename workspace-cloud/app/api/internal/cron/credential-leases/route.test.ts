import { afterEach, describe, expect, it, vi } from "vitest";

const { cleanupMock, receiptCleanupMock } = vi.hoisted(() => ({
  cleanupMock: vi.fn(async () => ({ scanned: 1, revoked: 1, deferred: 0 })),
  receiptCleanupMock: vi.fn(async () => 4),
}));

vi.mock("server-only", () => ({}));
vi.mock("../../../../../lib/provider-integrations", () => ({
  cleanupExpiredManagedLeases: cleanupMock,
}));
vi.mock("../../../../../lib/provider-discovery-receipt-store", () => ({
  cleanupProviderDiscoveryReceipts: receiptCleanupMock,
}));

import { GET } from "./route";

afterEach(() => {
  cleanupMock.mockClear();
  receiptCleanupMock.mockClear();
  delete process.env.CRON_SECRET;
});

describe("managed credential cleanup cron", () => {
  it("fails closed without the configured bearer secret", async () => {
    const response = await GET(new Request("https://app.example/api/cron"));
    expect(response.status).toBe(401);
    expect(cleanupMock).not.toHaveBeenCalled();
    expect(receiptCleanupMock).not.toHaveBeenCalled();
  });

  it("runs a bounded cleanup for an authenticated Vercel invocation", async () => {
    process.env.CRON_SECRET = "c".repeat(32);
    const response = await GET(new Request("https://app.example/api/cron", {
      headers: { authorization: `Bearer ${"c".repeat(32)}` },
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      scanned: 1,
      revoked: 1,
      discoveryReceiptsDeleted: 4,
    });
    expect(cleanupMock).toHaveBeenCalledWith({ limit: 10 });
    expect(receiptCleanupMock).toHaveBeenCalledWith();
  });
});
