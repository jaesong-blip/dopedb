import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { errMessage, type SafetySettings } from "../../ipc/types";
import { safetyQueryKeys, safetySettingsQuery } from "../safetySettings/queries";

export function useSafetySettings(connectionId: string | null) {
  const queryClient = useQueryClient();
  const query = useQuery(safetySettingsQuery(connectionId));

  return {
    safety: query.data ?? null,
    error: query.error ? errMessage(query.error) : null,
    refresh: useCallback(() => {
      if (connectionId) {
        void queryClient.invalidateQueries({
          queryKey: safetyQueryKeys.detail(connectionId),
          exact: true,
          refetchType: "active",
        });
      }
    }, [connectionId, queryClient]),
    accept: useCallback(
      (id: string, settings: SafetySettings) => {
        if (connectionId !== id) return;
        queryClient.setQueryData(safetyQueryKeys.detail(id), settings);
      },
      [connectionId, queryClient],
    ),
    clear: useCallback(() => {
      if (connectionId) {
        queryClient.removeQueries({
          queryKey: safetyQueryKeys.detail(connectionId),
          exact: true,
        });
      }
    }, [connectionId, queryClient]),
  };
}
