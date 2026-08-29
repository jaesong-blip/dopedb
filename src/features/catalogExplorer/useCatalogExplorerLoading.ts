import { useQueryClient } from "@tanstack/react-query";

import { qk, type CatalogScope } from "../../lib/queries";
import type { useCatalogExplorerState } from "./state";

type CatalogExplorerCommands = ReturnType<
  typeof useCatalogExplorerState
>["commands"];

export function useCatalogExplorerLoading(
  catalogScope: CatalogScope,
  commands: CatalogExplorerCommands,
) {
  const queryClient = useQueryClient();

  function ensureLoaded(connectionId: string) {
    commands.want(connectionId);
    commands.clearRefreshError(connectionId);
    if (
      queryClient.getQueryState(
        qk.connectionDatabases(connectionId, catalogScope.key),
      )?.status === "error"
    ) {
      void queryClient.refetchQueries({
        queryKey: qk.connectionDatabases(connectionId, catalogScope.key),
      });
    }
  }

  function retryOverview(connectionId: string, database: string) {
    commands.clearRefreshError(connectionId);
    void queryClient.refetchQueries({
      queryKey: qk.databaseCatalogOverview(
        connectionId,
        database,
        catalogScope.key,
      ),
      exact: true,
    });
  }

  return { ensureLoaded, retryOverview };
}
