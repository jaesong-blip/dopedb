import { describe, expect, it } from "vitest";
import { readOnlyProjection } from "./adapter-contract";
import {
  allowDiscoveryImport,
  providerImportAdapters,
  providerImportProjection,
} from "./import-projection";

describe("provider-neutral read-only import projections", () => {
  it.each([
    ["neon", { project: "project-a", branch: "dev", database: "app", engine: "postgres", schemas: ["public"] }],
    ["gcpCloudSql", { project: "sample-project-123", instance: "db", database: "app", engine: "postgres", networkMode: "PRIVATE_SERVICES_ACCESS" }],
    ["planetScale", { organization: "team", database: "app", branch: "dev", engine: "mysql" }],
  ])("projects %s without secrets or write capability", (provider, resource) => {
    const projection = providerImportProjection(provider as "neon" | "gcpCloudSql" | "planetScale", resource as never);
    expect(projection.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(projection.capabilities).toEqual({ discover: true, importReadOnly: true, managedLease: true, write: false });
    // The final leaf decision is server-derived and becomes a durable predicate
    // for the later local-target authority query.
    expect(projection.metadata.production).toBe(false);
    expect(JSON.stringify(projection)).not.toMatch(/token|secret|password|credential/i);
  });

  it("denies production and not-ready discoveries before provider scope is considered", () => {
    expect(allowDiscoveryImport({ production: true, ready: true })).toBe(false);
    expect(allowDiscoveryImport({ production: false, ready: false })).toBe(false);
    expect(allowDiscoveryImport({ production: false, ready: true })).toBe(true);
    expect(allowDiscoveryImport({ ready: true })).toBe(false);
    expect(allowDiscoveryImport({ production: "unknown", ready: true })).toBe(false);
    expect(allowDiscoveryImport({ production: false })).toBe(false);
  });

  it("uses real provider adapter capability implementations rather than one shared literal", () => {
    for (const provider of ["neon", "gcpCloudSql", "planetScale"] as const) {
      const adapter = providerImportAdapters[provider];
      expect(adapter.provider).toBe(provider);
      expect(adapter.capabilities(adapter.reconstruct(
        provider === "neon"
          ? { project: "project-a", branch: "dev", database: "app", engine: "postgres" }
          : provider === "gcpCloudSql"
            ? { project: "sample-project-123", instance: "db", database: "app", engine: "postgres", networkMode: "PUBLIC" }
            : { organization: "team", database: "app", branch: "dev", engine: "mysql" },
      )).write).toBe(false);
    }
  });

  it("rejects nested secret/unknown fields and oversized projection values", () => {
    expect(() => providerImportProjection("neon", {
      project: "project-a", branch: "dev", database: "app", engine: "postgres",
      nested: { token: "never" },
    })).toThrow(/unsupported fields/);
    expect(() => readOnlyProjection({
      provider: "neon", resource: { project: { password: "never" } }, metadata: {},
      capabilities: { discover: true, importReadOnly: true, managedLease: true, write: false },
      host: "neon.managed.invalid", port: 5432, database: "app", engine: "postgres", sslmode: "verify-full",
    })).toThrow(/secret-bearing|nested/);
    expect(() => readOnlyProjection({
      provider: "neon", resource: { project: "x".repeat(513) }, metadata: {},
      capabilities: { discover: true, importReadOnly: true, managedLease: true, write: false },
      host: "neon.managed.invalid", port: 5432, database: "app", engine: "postgres", sslmode: "verify-full",
    })).toThrow(/projection string/);
  });
});
