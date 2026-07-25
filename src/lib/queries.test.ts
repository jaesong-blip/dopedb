import { describe, expect, it } from "vitest";
import {
  catalogSnapshotQuery,
  dashboardTileRunQueries,
  isTransientDbError,
  legacyMcpCleanupStatusQuery,
  platformFeatureFlagsQuery,
  qk,
  skillStatusQuery,
} from "./queries";

describe("isTransientDbError", () => {
  it("treats network-shaped failures as transient", () => {
    expect(isTransientDbError(new Error("connection refused"))).toBe(true);
    expect(isTransientDbError("host unreachable")).toBe(true);
  });

  it("keeps deterministic and uncancellable timeout failures failing fast", () => {
    expect(isTransientDbError("database error: pool timed out while waiting for an open connection")).toBe(false);
    expect(isTransientDbError("Schema loading timed out. Check the database connection or retry.")).toBe(false);
    expect(isTransientDbError("canceling statement due to statement timeout")).toBe(false);
    expect(isTransientDbError("password authentication failed for user")).toBe(false);
    expect(isTransientDbError('relation "users" does not exist')).toBe(false);
    expect(isTransientDbError("permission denied for table accounts")).toBe(false);
  });
});

describe("catalog snapshot query lifecycle", () => {
  it("can wait for the legacy catalog to finish a cold introspection", () => {
    expect(catalogSnapshotQuery("connection-id", false).enabled).toBe(false);
    expect(catalogSnapshotQuery("connection-id", true).enabled).toBe(true);
  });
});

describe("legacy cleanup query lifecycle", () => {
  it("uses one global key and keeps a warm result between settings mounts", () => {
    const query = legacyMcpCleanupStatusQuery();

    expect(query.queryKey).toEqual(qk.legacyMcpCleanup());
    expect(query.staleTime).toBe(30_000);
  });
});

describe("platform feature flag lifecycle", () => {
  it("uses one process-stable query and fails closed without retries", () => {
    const query = platformFeatureFlagsQuery();

    expect(query.queryKey).toEqual(qk.platformFeatureFlags());
    expect(query.staleTime).toBe(Infinity);
    expect(query.retry).toBe(false);
  });
});

describe("Skill inventory lifecycle", () => {
  it("runs at startup and rechecks the bounded inventory after app focus", () => {
    const query = skillStatusQuery();

    expect(query.queryKey).toEqual(qk.skillStatus());
    expect(query.staleTime).toBe(30_000);
    expect(query.gcTime).toBe(Infinity);
    expect(query.refetchOnWindowFocus).toBe(true);
    expect(query.retry).toBe(false);
  });
});

describe("dashboard tile query lifecycle", () => {
  it("subscribes every tile to cache while enabling only the selected dashboard", () => {
    const queries = dashboardTileRunQueries(["sales", "latency", "errors"], "latency");

    expect(queries.map((query) => query.queryKey)).toEqual([
      qk.dashboardRun("sales"),
      qk.dashboardRun("latency"),
      qk.dashboardRun("errors"),
    ]);
    expect(queries.map((query) => query.enabled)).toEqual([false, true, false]);
  });

  it("does not execute any dashboard before the user selects one", () => {
    const queries = dashboardTileRunQueries(["sales", "latency"], null);

    expect(queries.every((query) => query.enabled === false)).toBe(true);
  });
});
