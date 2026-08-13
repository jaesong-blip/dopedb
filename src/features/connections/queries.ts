import { queryOptions } from "@tanstack/react-query";

import { isTransientDbError } from "../../lib/queries";
import { listConnections } from "./tauriAdapter";

export const connectionQueryKeys = {
  all: (scopeKey: string) => ["connections", scopeKey] as const,
};

export function connectionsQuery(scopeKey: string) {
  return queryOptions({
    queryKey: connectionQueryKeys.all(scopeKey),
    queryFn: listConnections,
    retry: (failureCount, error) =>
      failureCount < 3 && isTransientDbError(error),
    retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 8_000),
  });
}
