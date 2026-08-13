// App-wide query cache plus the single place backend events are translated into cache
// invalidations. Keeping the listeners here (rather than in each screen) means a screen
// that is not currently mounted still shows fresh data the next time it is opened.
import { useEffect, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import type { JobChangedEvent } from "../features/jobs/domain";
import type {
  ManualTransactionChangedEvent,
  ManualTransactionStatus,
} from "../features/queries/domain";
import { qk } from "./queries";

// Scope changes are a security boundary, so new feature queries are private by
// default. Only machine-global inventories and the two queries that establish the
// next workspace scope may survive. This avoids an incomplete deny-list silently
// leaking a newly introduced workspace resource into another account.
const WORKSPACE_QUERY_ALLOWLIST = new Set([
  "workspaceAuth",
  "workspaceContext",
  "drivers",
  "cliInstallation",
  "skillStatus",
  "legacyMcpCleanup",
]);

const isWorkspaceResource = (query: { queryKey: readonly unknown[] }) =>
  !WORKSPACE_QUERY_ALLOWLIST.has(String(query.queryKey[0]));

const CONNECTION_RESOURCE_QUERY_ROOTS = new Set([
  "catalog",
  "catalogOverview",
  "catalogSnapshot",
  "connectionDatabases",
  "databaseCatalog",
  "databaseCatalogOverview",
  "databaseCatalogSnapshot",
  "history",
  "audit",
  "monitoring",
  "manualTransaction",
  "tableRows",
  "tableCount",
  "documentRows",
  "documentCount",
  "erdLayouts",
  "jobs",
  "safety",
  "tableDdl",
]);

/** Clear only data tied to the previous workspace; identity and global catalogs stay warm. */
export async function resetWorkspaceResourceQueries(queryClient: QueryClient) {
  await queryClient.cancelQueries({ predicate: isWorkspaceResource });
  // A removed query can leave an already-mounted observer holding its last result.
  // Reset active observers directly so private data disappears synchronously. Do
  // not refetch here: during an authority transition an old observer may still
  // carry its old key while the native backend already holds the new authority.
  queryClient.getQueryCache().findAll({ predicate: isWorkspaceResource })
    .filter((query) => query.isActive())
    .forEach((query) => query.reset());
  queryClient.removeQueries({ predicate: isWorkspaceResource, type: "inactive" });
}

/** Freeze private reads before a native authority refresh can change its active scope. */
export async function cancelWorkspaceResourceQueries(queryClient: QueryClient) {
  await queryClient.cancelQueries({ predicate: isWorkspaceResource });
}

/** Re-read mounted private resources only after the current native authority is proven unchanged. */
export async function refetchWorkspaceResourceQueries(queryClient: QueryClient) {
  await queryClient.refetchQueries({ predicate: isWorkspaceResource, type: "active" });
}

/** Drop stale database state when a synchronized shared connection changes authority. */
export async function resetConnectionResourceQueries(
  queryClient: QueryClient,
  connectionIds: readonly string[],
) {
  if (connectionIds.length === 0) return;
  const ids = new Set(connectionIds);
  const isConnectionResource = (query: { queryKey: readonly unknown[] }) =>
    CONNECTION_RESOURCE_QUERY_ROOTS.has(String(query.queryKey[0]))
    && ids.has(String(query.queryKey[1]));
  await queryClient.cancelQueries({ predicate: isConnectionResource });
  await queryClient.resetQueries(
    { predicate: isConnectionResource, type: "active" },
    { cancelRefetch: true },
  );
  queryClient.removeQueries({ predicate: isConnectionResource, type: "inactive" });
}

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Desktop app: the window regaining focus is not a signal that database state
        // changed, and a blanket refetch would re-run every open table query.
        refetchOnWindowFocus: false,
        // Failures here are deterministic (bad credentials, invalid SQL, dropped table),
        // so a retry only doubles the wait — and a retried runSql would double-write the
        // query history. Screens surface the error and offer an explicit refresh instead.
        retry: false,
        // Long enough that a cached tab survives a detour through the rest of the app.
        gcTime: 30 * 60_000,
      },
    },
  });
}

type CacheInvalidationLease = {
  references: number;
  disposed: boolean;
  teardownScheduled: boolean;
  pending: readonly Promise<() => void>[];
};

const cacheInvalidationLeases = new WeakMap<QueryClient, CacheInvalidationLease>();

// Backend events name the connection they concern, so each one invalidates exactly that
// connection's logs. One reference-counted lease also prevents React StrictMode's
// setup-cleanup-setup probe from registering two native listener sets.
function retainCacheInvalidation(queryClient: QueryClient) {
  let lease = cacheInvalidationLeases.get(queryClient);
  if (!lease) {
    lease = {
      references: 0,
      disposed: false,
      teardownScheduled: false,
      pending: [],
    };
    const active = () => !lease?.disposed && (lease?.references ?? 0) > 0;
    lease.pending = [
      listen<{ connectionId: string | null }>("operation:changed", (event) => {
        if (!active()) return;
        const connectionId = event.payload.connectionId;
        if (!connectionId) return;
        void queryClient.invalidateQueries({ queryKey: qk.history(connectionId) });
        void queryClient.invalidateQueries({ queryKey: qk.audit(connectionId) });
      }),
      listen<JobChangedEvent>("job:changed", (event) => {
        if (!active()) return;
        void queryClient.invalidateQueries({
          queryKey: qk.jobs(event.payload.connectionId),
        });
      }),
      listen<ManualTransactionChangedEvent>(
        "manual-transaction:changed",
        (event) => {
          if (!active()) return;
          const { connectionId, status } = event.payload;
          queryClient.setQueryData(qk.manualTransaction(connectionId), status);
          queryClient.setQueryData<ManualTransactionStatus[]>(
            qk.manualTransactions(),
            (current) => {
              if (!current && !status) return current;
              const next = (current ?? []).filter(
                (item) => item.connectionId !== connectionId,
              );
              if (status) next.push(status);
              next.sort((left, right) =>
                left.connectionId.localeCompare(right.connectionId),
              );
              return next;
            },
          );
          // If an event raced the initial snapshot, cancel that older response and
          // converge through one backend-owned snapshot instead of N connection calls.
          void queryClient.invalidateQueries({
            queryKey: qk.manualTransactions(),
            exact: true,
            refetchType: "active",
          });
        },
      ).then((unlisten) => {
        if (active()) {
          // Close the listener-registration race with one consolidated snapshot.
          void queryClient.invalidateQueries({
            queryKey: qk.manualTransactions(),
            refetchType: "active",
          });
        }
        return unlisten;
      }),
      listen("manual-transaction:resync", () => {
        if (!active()) return;
        void queryClient.invalidateQueries({
          queryKey: qk.manualTransactions(),
          exact: true,
          refetchType: "active",
        });
      }),
    ];
    cacheInvalidationLeases.set(queryClient, lease);
  }

  lease.references += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    lease.references -= 1;
    if (lease.references !== 0 || lease.teardownScheduled) return;
    lease.teardownScheduled = true;
    queueMicrotask(() => {
      lease.teardownScheduled = false;
      if (lease.references !== 0 || lease.disposed) return;
      lease.disposed = true;
      if (cacheInvalidationLeases.get(queryClient) === lease) {
        cacheInvalidationLeases.delete(queryClient);
      }
      for (const pending of lease.pending) {
        void pending.then((unlisten) => unlisten()).catch(() => {});
      }
    });
  };
}

function CacheInvalidation({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();

  useEffect(() => retainCacheInvalidation(queryClient), [queryClient]);

  return <>{children}</>;
}

export function QueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(createQueryClient);
  return (
    <QueryClientProvider client={client}>
      <CacheInvalidation>{children}</CacheInvalidation>
    </QueryClientProvider>
  );
}
