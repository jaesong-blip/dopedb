// Owns explicit Explorer loading and authentication recovery. Provider login runs
// through the existing connection adapter; this hook only coordinates catalog cache
// refresh after the member-local credential becomes usable again.
import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  authenticateBigQueryGoogleAccount,
  authenticateBigQueryServiceAccount,
  pickConnectionFile,
} from "../connections/tauriAdapter";
import { bigQueryAuthMode } from "../connections/bigQueryOnboardingModel";
import type { ConnectionProfile } from "../connections/domain";
import { qk, type CatalogScope } from "../../lib/queries";
import { catalogLoadIssue } from "./catalogDomain";
import type { useCatalogExplorerState } from "./state";

type CatalogExplorerCommands = ReturnType<
  typeof useCatalogExplorerState
>["commands"];

export function useCatalogExplorerLoading(
  catalogScope: CatalogScope,
  commands: CatalogExplorerCommands,
) {
  const queryClient = useQueryClient();
  const authenticationRecovery = useMutation({
    mutationFn: async ({ connection }: {
      connection: ConnectionProfile;
      scopeKey: string;
    }) => {
      if (bigQueryAuthMode(connection) === "googleAccount") {
        await authenticateBigQueryGoogleAccount(connection);
        return true;
      }
      const credentialFile = await pickConnectionFile();
      if (!credentialFile) return false;
      await authenticateBigQueryServiceAccount(connection, credentialFile);
      return true;
    },
    onSuccess: async (recovered, { connection, scopeKey }) => {
      if (!recovered) return;
      await queryClient.invalidateQueries({
        queryKey: ["bigQueryOnboarding", connection.id],
      });
      if (scopeKey !== catalogScope.key) return;
      commands.clearRefreshError(connection.id);
      await Promise.all([
        queryClient.refetchQueries({
          queryKey: qk.connectionDatabases(connection.id, scopeKey),
          exact: true,
          type: "all",
        }),
        queryClient.refetchQueries({
          queryKey: ["databaseCatalogOverview", connection.id],
          type: "all",
        }),
        queryClient.refetchQueries({
          queryKey: ["databaseCatalog", connection.id],
          type: "all",
        }),
      ]);
    },
  });

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

  const recoveryConnectionId = authenticationRecovery.variables?.connection.id
    ?? null;
  return {
    ensureLoaded,
    retryOverview,
    recoverAuthentication: (connection: ConnectionProfile) => {
      if (connection.engine !== "bigquery" || authenticationRecovery.isPending) {
        return;
      }
      authenticationRecovery.mutate({
        connection,
        scopeKey: catalogScope.key,
      });
    },
    authenticationRecoveryPendingId: authenticationRecovery.isPending
      ? recoveryConnectionId
      : null,
    authenticationRecoveryErrorId: authenticationRecovery.isError
      ? recoveryConnectionId
      : null,
    authenticationRecoveryError: authenticationRecovery.error
      ? catalogLoadIssue(authenticationRecovery.error)
      : undefined,
  };
}
