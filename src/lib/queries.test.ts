import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import {
  catalogQuery,
  catalogOverviewQuery,
  catalogSnapshotQuery,
  dashboardTileRunQueries,
  isTransientDbError,
  legacyMcpCleanupStatusQuery,
  qk,
  readCatalogInScope,
  replaceFreshCatalog,
  skillStatusQuery,
} from "./queries";

describe("isTransientDbError", () => {
  it("treats network-shaped failures as transient", () => {
    expect(isTransientDbError(new Error("connection refused"))).toBe(true);
    expect(isTransientDbError("host unreachable")).toBe(true);
  });

  it("keeps deterministic failures out of transient retry", () => {
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

  it("refreshes the full catalog while invalidating derived overview and snapshot metadata", async () => {
    const client = new QueryClient();
    const scope = "workspace:team:one:account:alice";
    const catalog = { tables: [], objects: [] };
    client.setQueryData(qk.catalogOverview("connection-id", scope), { relations: [] });
    client.setQueryData(qk.catalogSnapshot("connection-id", scope), { relations: [] });

    await replaceFreshCatalog(client, "connection-id", scope, catalog);

    expect(client.getQueryData(qk.catalog("connection-id", scope))).toBe(catalog);
    expect(client.getQueryState(qk.catalogOverview("connection-id", scope))?.isInvalidated).toBe(true);
    expect(client.getQueryState(qk.catalogSnapshot("connection-id", scope))?.isInvalidated).toBe(true);
  });

  it("isolates a settled workspace/account scope and does not fetch while it changes", () => {
    const oldScope = { key: "workspace:team:one:account:alice", ready: true };
    const nextScope = { key: "workspace:team:two:account:bob", ready: true };
    const switchingScope = { key: nextScope.key, ready: false };

    expect(catalogQuery("connection-id", oldScope).queryKey).toEqual(
      qk.catalog("connection-id", oldScope.key),
    );
    expect(catalogQuery("connection-id", nextScope).queryKey).toEqual(
      qk.catalog("connection-id", nextScope.key),
    );
    expect(catalogQuery("connection-id", oldScope).queryKey).not.toEqual(
      catalogQuery("connection-id", nextScope).queryKey,
    );
    expect(catalogQuery("connection-id", switchingScope).enabled).toBe(false);
    expect(catalogOverviewQuery("connection-id", switchingScope).enabled).toBe(false);
    expect(catalogSnapshotQuery("connection-id", true, switchingScope).enabled).toBe(false);
    expect(catalogOverviewQuery("connection-id", oldScope).queryKey).not.toEqual(
      catalogOverviewQuery("connection-id", nextScope).queryKey,
    );
    expect(catalogQuery("connection-id", oldScope).retry).toBe(false);
    expect(catalogOverviewQuery("connection-id", oldScope).retry).toBe(false);
  });

  it("surfaces and recovers a cold scope failure instead of disabling catalog reads", async () => {
    const error = new Error("workspace context unavailable");
    const recover = vi.fn().mockResolvedValue(undefined);
    const read = vi.fn().mockResolvedValue({ tables: [], objects: [] });
    const scope = {
      key: "workspace:unresolved",
      ready: true,
      error,
      recover,
    };

    expect(catalogOverviewQuery("connection-id", scope).enabled).toBe(true);
    await expect(readCatalogInScope(scope, read)).rejects.toBe(error);
    expect(recover).toHaveBeenCalledOnce();
    expect(read).not.toHaveBeenCalled();
  });

  it("leaves a healthy settled scope on the direct backend read path", async () => {
    const read = vi.fn().mockResolvedValue("catalog");

    await expect(readCatalogInScope({ key: "personal", ready: true }, read)).resolves.toBe("catalog");
    expect(read).toHaveBeenCalledOnce();
  });
});

describe("legacy cleanup query lifecycle", () => {
  it("uses one global key and keeps a warm result between settings mounts", () => {
    const query = legacyMcpCleanupStatusQuery();

    expect(query.queryKey).toEqual(qk.legacyMcpCleanup());
    expect(query.staleTime).toBe(30_000);
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
