import { queryOptions } from "@tanstack/react-query";

import { isTransientDbError } from "../../lib/queries";
import type { ConnectionProfile } from "./domain";
import { bigQueryAuthMode } from "./bigQueryOnboardingModel";
import {
  discoverBigQueryDatasets,
  discoverBigQueryProjects,
  getBigQueryAuthState,
  listConnections,
} from "./tauriAdapter";

export const connectionQueryKeys = {
  all: (scopeKey: string) => ["connections", scopeKey] as const,
  bigQueryAuth: (profile: ConnectionProfile) =>
    ["bigQueryOnboarding", profile.id, bigQueryAuthMode(profile), "auth"] as const,
  bigQueryProjects: (profile: ConnectionProfile) =>
    ["bigQueryOnboarding", profile.id, bigQueryAuthMode(profile), "projects"] as const,
  bigQueryDatasets: (profile: ConnectionProfile, projectId: string) =>
    [
      "bigQueryOnboarding",
      profile.id,
      bigQueryAuthMode(profile),
      "datasets",
      projectId,
    ] as const,
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

export function bigQueryAuthStateQuery(profile: ConnectionProfile) {
  return queryOptions({
    queryKey: connectionQueryKeys.bigQueryAuth(profile),
    queryFn: () => getBigQueryAuthState(profile),
    staleTime: 10_000,
    retry: false,
  });
}

export function bigQueryProjectsQuery(profile: ConnectionProfile) {
  return queryOptions({
    queryKey: connectionQueryKeys.bigQueryProjects(profile),
    queryFn: () => discoverBigQueryProjects(profile),
    staleTime: 30_000,
    retry: false,
  });
}

export function bigQueryDatasetsQuery(
  profile: ConnectionProfile,
  projectId: string,
) {
  return queryOptions({
    queryKey: connectionQueryKeys.bigQueryDatasets(profile, projectId),
    queryFn: () => discoverBigQueryDatasets(profile, projectId),
    staleTime: 30_000,
    retry: false,
  });
}
