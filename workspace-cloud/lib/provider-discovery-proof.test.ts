import { beforeEach, describe, expect, it, vi } from "vitest";

const credentialKey = Buffer.alloc(32, 7).toString("base64url");

vi.mock("server-only", () => ({}));
vi.mock("./env", () => ({ env: { credentialKey: () => credentialKey } }));

import {
  canonicalProviderDiscoverySelection,
  openProviderDiscoveryProof,
  sameProviderResourceItem,
  sealProviderDiscoveryProof,
} from "./provider-discovery-proof";

const organizationId = "11111111-1111-4111-8111-111111111111";
const integrationId = "22222222-2222-4222-8222-222222222222";
const now = Date.parse("2026-07-27T00:00:00.000Z");
const input = {
  organizationId,
  integrationId,
  integrationGeneration: 42n,
  memberId: "member-id",
  userId: "user-id",
  sessionId: "session-id",
  provider: "neon" as const,
  kind: "databases" as const,
  selection: { project: "project", branch: "branch" },
  item: {
    id: "database-id",
    value: "database",
    name: "database",
    kind: "postgres" as const,
    production: false,
    ready: true,
  },
  now,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("opaque provider discovery selection proof", () => {
  it("round-trips only in the exact tenant/integration context", () => {
    const proof = sealProviderDiscoveryProof(input);
    expect(proof).not.toContain("database-id");
    expect(openProviderDiscoveryProof({
      organizationId,
      integrationId,
      proof,
      now: now + 1_000,
    })).toMatchObject({
      organizationId,
      integrationId,
      integrationGeneration: 42n,
      receiptId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      ),
      selection: { project: "project", branch: "branch" },
      item: input.item,
    });
    expect(openProviderDiscoveryProof({
      organizationId: "other-workspace",
      integrationId,
      proof,
      now: now + 1_000,
    })).toBeNull();
    expect(openProviderDiscoveryProof({
      organizationId,
      integrationId: "33333333-3333-4333-8333-333333333333",
      proof,
      now: now + 1_000,
    })).toBeNull();
  });

  it("canonicalizes only the exact provider/kind parent selector shape", () => {
    expect(canonicalProviderDiscoverySelection(
      "neon",
      "databases",
      { project: "project", branch: "branch" },
    )).toEqual({ project: "project", branch: "branch" });
    expect(canonicalProviderDiscoverySelection(
      "neon",
      "databases",
      { project: "project", branch: "branch", engine: "postgres" },
    )).toBeNull();
    expect(canonicalProviderDiscoverySelection(
      "gcpCloudSql",
      "databases",
      { project: "project", instance: "instance", networkMode: "PUBLIC" },
    )).toBeNull();
    expect(canonicalProviderDiscoverySelection(
      "planetScale",
      "projects",
      {},
    )).toBeNull();
  });

  it("rejects tampering and expiration without returning decrypted details", () => {
    const proof = sealProviderDiscoveryProof(input);
    const replacement = proof.endsWith("A") ? "B" : "A";
    expect(openProviderDiscoveryProof({
      organizationId,
      integrationId,
      proof: `${proof.slice(0, -1)}${replacement}`,
      now: now + 1_000,
    })).toBeNull();
    expect(openProviderDiscoveryProof({
      organizationId,
      integrationId,
      proof,
      now: now + 5 * 60 * 1_000,
    })).toBeNull();
  });

  it("requires an exact resource match during final server revalidation", () => {
    expect(sameProviderResourceItem(input.item, { ...input.item })).toBe(true);
    expect(sameProviderResourceItem(input.item, {
      ...input.item,
      production: "unknown",
    })).toBe(false);
    expect(sameProviderResourceItem(input.item, {
      ...input.item,
      value: "crafted-external-id",
    })).toBe(false);
  });

  it("refuses to seal an item carrying an unexpected runtime field", () => {
    expect(() => sealProviderDiscoveryProof({
      ...input,
      item: { ...input.item, password: "must-not-enter-proof" } as typeof input.item,
    })).toThrow("Invalid provider discovery proof payload");
  });
});
