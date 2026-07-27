import { useCallback, useEffect, useState } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import type { Catalog, CatalogOverview } from "../../ipc/types";
import { errMessage } from "../../ipc/types";
import {
  catalogOverviewQuery,
  catalogQuery,
  qk,
  type CatalogScope,
} from "../../lib/queries";

export function shouldLoadCatalogDetails(
  scopeReady: boolean,
  overviewReady: boolean,
  explicitlyRequested: boolean,
) {
  return scopeReady && overviewReady && explicitlyRequested;
}

/**
 * Paints the bounded relation tree first. Full metadata is opt-in so merely
 * expanding a workspace connection cannot start a heavy catalog scan.
 */
export function useCatalogTree(
  connectionIds: string[],
  scope: CatalogScope,
) {
  const queryClient = useQueryClient();
  const [detailConnectionIds, setDetailConnectionIds] = useState<Set<string>>(
    new Set(),
  );
  useEffect(() => setDetailConnectionIds(new Set()), [scope.key]);
  const requestDetails = useCallback((connectionId: string) => {
    setDetailConnectionIds((ids) =>
      ids.has(connectionId) ? ids : new Set(ids).add(connectionId)
    );
    if (
      queryClient.getQueryState(qk.catalog(connectionId, scope.key))?.status
      === "error"
    ) {
      void queryClient.refetchQueries({
        queryKey: qk.catalog(connectionId, scope.key),
        exact: true,
      });
    }
  }, [queryClient, scope.key]);
  const forgetDetails = useCallback((connectionId: string) => {
    setDetailConnectionIds((ids) => {
      if (!ids.has(connectionId)) return ids;
      const next = new Set(ids);
      next.delete(connectionId);
      return next;
    });
  }, []);
  const { overviews, overviewErrs } = useQueries({
    queries: connectionIds.map((id) => catalogOverviewQuery(id, scope)),
    combine: (results) => {
      const overviews: Record<string, CatalogOverview> = {};
      const overviewErrs: Record<string, string> = {};
      results.forEach((result, index) => {
        const id = connectionIds[index];
        if (result.data) overviews[id] = result.data;
        else if (result.error) overviewErrs[id] = errMessage(result.error);
      });
      return { overviews, overviewErrs };
    },
  });
  const { catalogs, detailErrs } = useQueries({
    queries: connectionIds.map((id) => ({
      ...catalogQuery(id, scope),
      enabled: shouldLoadCatalogDetails(
        scope.ready,
        overviews[id] !== undefined,
        detailConnectionIds.has(id),
      ),
    })),
    combine: (results) => {
      const catalogs: Record<string, Catalog> = {};
      const detailErrs: Record<string, string> = {};
      results.forEach((result, index) => {
        const id = connectionIds[index];
        if (result.data) catalogs[id] = result.data;
        else if (result.error) detailErrs[id] = errMessage(result.error);
      });
      return { catalogs, detailErrs };
    },
  });
  return {
    overviews,
    overviewErrs,
    catalogs,
    detailErrs,
    requestDetails,
    forgetDetails,
  };
}
