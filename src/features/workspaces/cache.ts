/**
 * Workspace Query cache ownership.
 *
 * Components and transport adapters never mutate shared workspace state directly.
 * Every authoritative replacement and scope transition passes through this module.
 */

import type { QueryClient } from "@tanstack/react-query";

import { resetWorkspaceResourceQueries } from "../../lib/queryClient";
import type { WorkspaceAuthState } from "./domain";
import {
  workspaceAuthStateQuery,
  workspaceContextQuery,
  workspaceQueryKeys,
} from "./queries";

export function replaceWorkspaceAuth(
  queryClient: QueryClient,
  state: WorkspaceAuthState,
) {
  queryClient.setQueryData(workspaceQueryKeys.auth(), state);
}

export async function invalidateWorkspaceAuth(queryClient: QueryClient) {
  await queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.auth() });
}

export async function invalidateWorkspaceContext(
  queryClient: QueryClient,
  refetchType: "active" | "none" = "active",
) {
  await queryClient.invalidateQueries({
    queryKey: workspaceQueryKeys.context(),
    refetchType,
  });
}

export async function invalidateWorkspaceState(queryClient: QueryClient) {
  await Promise.all([
    invalidateWorkspaceAuth(queryClient),
    invalidateWorkspaceContext(queryClient),
  ]);
}

export async function fetchWorkspaceContext(queryClient: QueryClient) {
  return queryClient.fetchQuery(workspaceContextQuery());
}

export async function resetWorkspaceScope(
  queryClient: QueryClient,
  refetchType: "active" | "none" = "active",
) {
  await resetWorkspaceResourceQueries(queryClient);
  await invalidateWorkspaceContext(queryClient, refetchType);
}

export async function recoverWorkspaceAuth(queryClient: QueryClient) {
  return queryClient.fetchQuery(workspaceAuthStateQuery());
}
