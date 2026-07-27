// Query-key factory and shared query options for every cached backend read. Screens
// consume these via useQuery/useQueries so one fetch per (resource, connection) is shared
// app-wide: re-entering a tab repaints from cache and revalidates in the background.
// Invalidation lives in queryClient.tsx; nothing here fetches on its own.
import { useEffect, useState } from "react";
import {
  queryOptions,
  type QueryClient,
  useQuery,
} from "@tanstack/react-query";
import {
  auditSnapshot,
  auditVerify,
  cliInstallationStatus,
  cancelQuery,
  getCatalog,
  getCatalogOverview,
  getCatalogSnapshot,
  getMonitoringStatus,
  legacyMcpCleanupStatus,
  listHistory,
  refreshCatalog,
  runDocumentRead,
  skillStatus,
} from "../ipc/commands";
import type {
  Catalog,
  CatalogOverview,
  CatalogTable,
  Engine,
  QueryResult,
} from "../ipc/types";
import { errMessage } from "../ipc/types";
import { listDrivers } from "../features/connections/tauriAdapter";
import { connectionId as asConnectionId } from "../features/connections/domain";
import {
  dashboardId as asDashboardId,
  queryExecutionId as asQueryExecutionId,
} from "../features/dashboards/domain";
import {
  listDashboards,
  runDashboard,
} from "../features/dashboards/tauriAdapter";
import { listErdLayouts } from "../features/erd/tauriAdapter";
import { jobConnectionId } from "../features/jobs/domain";
import { listJobs } from "../features/jobs/tauriAdapter";
import { runSqlBoundedPage } from "../features/queries/tauriAdapter";
import {
  workspaceAuthStateQuery,
  workspaceContextQuery,
} from "../features/workspaces/queries";
import { buildCountQuery, buildPageQuery, type GridSort } from "./sqlBuild";
import { tableKey } from "./tableRef";

const CATALOG_STALE_MS = Infinity;
// Avoid redundant log and row refetches while users switch tabs quickly.
const LOG_STALE_MS = 10_000;
export type CatalogScope = {
  key: string;
  ready: boolean;
  error?: unknown;
  recover?: () => Promise<void>;
};
/** Surface and recover cold scope failures instead of disabling catalog reads forever. */
export async function readCatalogInScope<T>(
  scope: CatalogScope | undefined,
  read: () => Promise<T>,
): Promise<T> {
  if (scope?.error !== undefined) {
    await scope.recover?.();
    throw scope.error;
  }
  return read();
}

/** Gives catalog reads a settled workspace/account generation without auth-refresh flicker. */
export function useCatalogScope(): CatalogScope {
  const context = useQuery(workspaceContextQuery());
  const auth = useQuery(workspaceAuthStateQuery());
  const workspace = context.data?.active;
  const teamWorkspace = workspace?.kind === "team";
  // Local catalogs are account-independent, so auth refreshes cannot re-key them.
  const accountId = teamWorkspace ? (auth.data?.user?.id ?? "anonymous") : "local";
  const key = workspace
    ? `workspace:${workspace.kind}:${workspace.id}:account:${accountId}`
    : "workspace:unresolved";
  // Hold one committed render across a scope replacement before enabling new reads.
  const [settledKey, setSettledKey] = useState(key);
  useEffect(() => {
    setSettledKey(key);
  }, [key]);
  // Background errors with cached data must not hide a valid catalog.
  const error = context.data === undefined
    ? context.error ?? undefined
    : teamWorkspace && auth.data === undefined
      ? auth.error ?? undefined
      : undefined;
  const prerequisiteReady = !!workspace && (!teamWorkspace || auth.data !== undefined);
  return {
    key,
    ready: settledKey === key && (prerequisiteReady || error !== undefined),
    error,
    recover: error === undefined
      ? undefined
      : async () => {
        const refreshed = context.data === undefined ? await context.refetch() : undefined;
        const active = context.data?.active ?? refreshed?.data?.active;
        if (active?.kind === "team" && auth.data === undefined) {
          await auth.refetch();
        }
      },
  };
}

const TRANSIENT_ERROR = /connection (refused|reset|closed|aborted)|could not connect|unreachable|broken pipe|network|io error/i;

export function isTransientDbError(e: unknown): boolean {
  return TRANSIENT_ERROR.test(errMessage(e));
}

// Read-only network queries retry; runSql queries never do because they write history.
const transientRetry = {
  retry: (failureCount: number, error: unknown) =>
    failureCount < 3 && isTransientDbError(error),
  retryDelay: (attempt: number) => Math.min(1000 * 2 ** attempt, 8_000),
} as const;

export type TableRowsPage = { result: QueryResult | null; total: number | null };

export type DocumentRowsArgs = {
  connectionId: string;
  collection: string;
  pageSize: number;
  page: number;
};

export type TableRowsArgs = {
  connectionId: string;
  engine: Engine;
  table: CatalogTable;
  filters: Record<string, string>;
  sort: GridSort | null;
  pageSize: number;
  page: number;
};

// Every key starts with a resource segment plus the connection id, so a connection-scoped
// invalidation is a prefix match and never has to enumerate sub-resources.
export const qk = {
  // Keep connection id before scope so existing per-connection invalidation is a
  // prefix match, while a scope transition can never consume an old result.
  catalog: (connectionId: string, scope?: string) =>
    scope === undefined
      ? (["catalog", connectionId] as const)
      : (["catalog", connectionId, scope] as const),
  catalogOverview: (connectionId: string, scope?: string) =>
    scope === undefined
      ? (["catalogOverview", connectionId] as const)
      : (["catalogOverview", connectionId, scope] as const),
  catalogSnapshot: (connectionId: string, scope?: string) =>
    scope === undefined
      ? (["catalogSnapshot", connectionId] as const)
      : (["catalogSnapshot", connectionId, scope] as const),
  history: (connectionId: string) => ["history", connectionId] as const,
  audit: (connectionId: string) => ["audit", connectionId] as const,
  auditVerdict: (connectionId: string) => ["audit", connectionId, "verdict"] as const,
  auditSnapshot: (connectionId: string) => ["audit", connectionId, "snapshot"] as const,
  monitoring: (connectionId: string) => ["monitoring", connectionId] as const,
  dashboards: (connectionId: string) => ["dashboards", connectionId] as const,
  dashboardRun: (dashboardId: string) => ["dashboardRun", dashboardId] as const,
  drivers: () => ["drivers"] as const,
  cliInstallation: () => ["cliInstallation"] as const,
  skillStatus: () => ["skillStatus"] as const,
  legacyMcpCleanup: () => ["legacyMcpCleanup"] as const,
  tableRows: (args: TableRowsArgs) =>
    [
      "tableRows",
      args.connectionId,
      tableKey(args.table),
      { filters: args.filters, sort: args.sort, pageSize: args.pageSize, page: args.page },
    ] as const,
  documentRows: (args: DocumentRowsArgs) =>
    [
      "documentRows",
      args.connectionId,
      args.collection,
      { pageSize: args.pageSize, page: args.page },
    ] as const,
  documentCount: (connectionId: string, collection: string) =>
    ["documentCount", connectionId, collection] as const,
  erdLayouts: (connectionId: string) =>
    ["erdLayouts", connectionId] as const,
  jobs: (connectionId: string) => ["jobs", connectionId] as const,
};

export function driversQuery() {
  return queryOptions({
    queryKey: qk.drivers(),
    staleTime: Infinity,
    queryFn: listDrivers,
  });
}

export function cliInstallationStatusQuery() {
  return queryOptions({
    queryKey: qk.cliInstallation(),
    staleTime: 30_000,
    retry: false,
    queryFn: cliInstallationStatus,
  });
}

export function skillStatusQuery() {
  return queryOptions({
    queryKey: qk.skillStatus(),
    staleTime: 30_000,
    gcTime: Infinity,
    retry: false,
    refetchOnWindowFocus: true,
    queryFn: () => skillStatus("all"),
  });
}

export function legacyMcpCleanupStatusQuery() {
  return queryOptions({
    queryKey: qk.legacyMcpCleanup(),
    staleTime: 30_000,
    gcTime: Infinity,
    retry: false,
    refetchOnWindowFocus: true,
    queryFn: legacyMcpCleanupStatus,
  });
}

export function catalogQuery(connectionId: string, scope?: CatalogScope) {
  return queryOptions({
    queryKey: qk.catalog(connectionId, scope?.key),
    enabled: scope?.ready ?? true,
    staleTime: CATALOG_STALE_MS,
    retry: false,
    queryFn: () => readCatalogInScope(scope, () => getCatalog(connectionId)),
  });
}

export function catalogOverviewQuery(connectionId: string, scope?: CatalogScope) {
  return queryOptions({
    queryKey: qk.catalogOverview(connectionId, scope?.key),
    enabled: scope?.ready ?? true,
    staleTime: CATALOG_STALE_MS,
    retry: false,
    queryFn: (): Promise<CatalogOverview> =>
      readCatalogInScope(scope, () => getCatalogOverview(connectionId)),
  });
}

export function catalogSnapshotQuery(
  connectionId: string,
  enabled = true,
  scope?: CatalogScope,
) {
  return queryOptions({
    queryKey: qk.catalogSnapshot(connectionId, scope?.key),
    enabled: enabled && (scope?.ready ?? true),
    staleTime: CATALOG_STALE_MS,
    retry: false,
    queryFn: () => readCatalogInScope(scope, () => getCatalogSnapshot(connectionId)),
  });
}

export function erdLayoutsQuery(connectionId: string) {
  return queryOptions({
    queryKey: qk.erdLayouts(connectionId),
    staleTime: Infinity,
    queryFn: () => listErdLayouts(asConnectionId(connectionId)),
  });
}

export function jobsQuery(connectionId: string) {
  return queryOptions({
    queryKey: qk.jobs(connectionId),
    staleTime: Infinity,
    queryFn: () => listJobs(jobConnectionId(connectionId)),
  });
}

// Force a live re-introspection. The caller writes the result into qk.catalog(id) so every
// surface reading the catalog updates at once; a CATALOG_STALE_MS of Infinity means this
// is the only way a stale table list gets corrected.
export function fetchFreshCatalog(connectionId: string) {
  return refreshCatalog(connectionId);
}

/** Promotes a manual refresh and retires derived overview/snapshot metadata together. */
export async function replaceFreshCatalog(
  queryClient: QueryClient,
  connectionId: string,
  scopeKey: string,
  catalog: Catalog,
) {
  queryClient.setQueryData(qk.catalog(connectionId, scopeKey), catalog);
  await Promise.all([
    queryClient.invalidateQueries({
      queryKey: qk.catalogOverview(connectionId, scopeKey),
      refetchType: "active",
    }),
    queryClient.invalidateQueries({
      queryKey: qk.catalogSnapshot(connectionId, scopeKey),
      refetchType: "active",
    }),
  ]);
}

export function historyQuery(connectionId: string) {
  return queryOptions({
    queryKey: qk.history(connectionId),
    staleTime: LOG_STALE_MS,
    queryFn: () => listHistory(connectionId),
  });
}

export function monitoringStatusQuery(connectionId: string) {
  return queryOptions({
    queryKey: qk.monitoring(connectionId),
    staleTime: LOG_STALE_MS,
    ...transientRetry,
    queryFn: () => getMonitoringStatus(connectionId),
  });
}

// Verification alone, for the collapsed Activity banner. The full row list can be large,
// so it stays behind auditSnapshotQuery until the disclosure is opened.
export function auditVerdictQuery(connectionId: string) {
  return queryOptions({
    queryKey: qk.auditVerdict(connectionId),
    staleTime: LOG_STALE_MS,
    queryFn: () => auditVerify(connectionId),
  });
}

export function auditSnapshotQuery(connectionId: string, enabled: boolean) {
  return queryOptions({
    queryKey: qk.auditSnapshot(connectionId),
    enabled,
    staleTime: LOG_STALE_MS,
    queryFn: () => auditSnapshot(connectionId),
  });
}

export function dashboardsQuery(connectionId: string) {
  return queryOptions({
    queryKey: qk.dashboards(connectionId),
    staleTime: LOG_STALE_MS,
    queryFn: () => listDashboards(asConnectionId(connectionId)),
  });
}

// A dashboard rerun is a read against the live database, so it is cached until the user
// asks for a fresh run. The AbortSignal is wired to the backend's cancel_query so a
// superseded or explicitly cancelled run stops server-side instead of finishing unseen.
export function dashboardRunQuery(dashboardId: string | null) {
  return queryOptions({
    queryKey: qk.dashboardRun(dashboardId ?? ""),
    enabled: dashboardId !== null,
    staleTime: Infinity,
    queryFn: ({ signal }) => {
      const queryId = window.crypto.randomUUID();
      signal.addEventListener("abort", () => void cancelQuery(queryId), { once: true });
      return runDashboard(
        asDashboardId(dashboardId!),
        asQueryExecutionId(queryId),
      );
    },
  });
}

// Dashboard tiles subscribe to cached results so already-run previews repaint instantly,
// but only the explicitly selected tile may touch the live database. Keeping the
// selection rule here makes it difficult for a canvas refactor to accidentally turn a
// dashboard overview into an unbounded batch of SQL queries again.
export function dashboardTileRunQueries(
  dashboardIds: readonly string[],
  selectedDashboardId: string | null,
) {
  return dashboardIds.map((dashboardId) => ({
    ...dashboardRunQuery(dashboardId),
    enabled: dashboardId === selectedDashboardId,
  }));
}

// One page of documents — the MongoDB sibling of tableRowsQuery's page half. The exact
// total is cached separately (documentCountQuery) so paging through a large collection
// doesn't re-run count_documents on every page.
export function documentRowsQuery(args: DocumentRowsArgs) {
  const { connectionId, collection, pageSize, page } = args;
  return queryOptions({
    queryKey: qk.documentRows(args),
    staleTime: LOG_STALE_MS,
    queryFn: () =>
      runDocumentRead(
        connectionId,
        { op: "find", collection, skip: page * pageSize, limit: pageSize },
        "data-view",
      ),
  });
}

// A collection's exact document count, cached independent of page/pageSize so every page
// of the same collection shares one count_documents run.
export function documentCountQuery(connectionId: string, collection: string) {
  return queryOptions({
    queryKey: qk.documentCount(connectionId, collection),
    staleTime: LOG_STALE_MS,
    queryFn: async (): Promise<number | null> => {
      const countOut = await runDocumentRead(
        connectionId,
        { op: "count", collection },
        "data-view",
      );
      const count = (countOut.documents[0] as { count?: number } | undefined)?.count;
      return count == null ? null : Number(count);
    },
  });
}

// One page of table data plus its exact total. Both statements are issued together so a
// cached page always carries the row count that was true when it was read.
export function tableRowsQuery(args: TableRowsArgs) {
  const { connectionId, engine, table, filters, sort, pageSize, page } = args;
  return queryOptions({
    queryKey: qk.tableRows(args),
    staleTime: LOG_STALE_MS,
    queryFn: async (): Promise<TableRowsPage> => {
      const pageSql = buildPageQuery(engine, table, {
        filters,
        sort,
        limit: pageSize,
        offset: page * pageSize,
      });
      const [pageOut, countOut] = await Promise.all([
        runSqlBoundedPage(connectionId, pageSql, "data-view"),
        runSqlBoundedPage(
          connectionId,
          buildCountQuery(engine, table, filters),
          "data-view",
        ),
      ]);
      const total = countOut.result?.rows?.[0]?.[0];
      return {
        result: pageOut.result ?? null,
        total: total == null ? null : Number(total),
      };
    },
  });
}
