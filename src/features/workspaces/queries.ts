import { queryOptions } from "@tanstack/react-query";

import { WORKSPACE_AUTH_RECHECK_MS } from "./authPolicy";
import {
  getActiveWorkspace,
  listWorkspaces,
  workspaceAuthState,
  workspaceFeatureState,
} from "./tauriAdapter";

export const workspaceQueryKeys = {
  context: () => ["workspaceContext"] as const,
  auth: () => ["workspaceAuth"] as const,
};

export async function readWorkspaceContext() {
  const [feature, workspaces, active] = await Promise.all([
    workspaceFeatureState(),
    listWorkspaces(),
    getActiveWorkspace(),
  ]);
  return { feature, workspaces, active };
}

export type WorkspaceContextState = Awaited<ReturnType<typeof readWorkspaceContext>>;

export function workspaceContextQuery() {
  return queryOptions({
    queryKey: workspaceQueryKeys.context(),
    staleTime: Infinity,
    queryFn: readWorkspaceContext,
  });
}

export function workspaceAuthStateQuery() {
  return queryOptions({
    queryKey: workspaceQueryKeys.auth(),
    // Public identity stays visually stable. Every sensitive Rust use case still
    // re-authorizes its hosted session and RBAC scope.
    staleTime: WORKSPACE_AUTH_RECHECK_MS,
    gcTime: Infinity,
    retry: false,
    queryFn: workspaceAuthState,
  });
}
