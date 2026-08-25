// Workspace identity stays visually stable while the server silently revalidates
// the OS-keychain session. Resource APIs still authorize every sensitive action.
export const WORKSPACE_AUTH_RECHECK_MS = 5 * 60_000;
export const WORKSPACE_AUTH_RETRY_MS = 30_000;
export const WORKSPACE_AUTH_RETRY_MAX_MS = 15 * 60_000;

export function workspaceAuthRetryDelay(
  failedAttempts: number,
  random = Math.random,
): number {
  const exponent = Math.max(0, Math.min(10, Math.floor(failedAttempts) - 1));
  const exponential = Math.min(
    WORKSPACE_AUTH_RETRY_MAX_MS,
    WORKSPACE_AUTH_RETRY_MS * 2 ** exponent,
  );
  // Positive jitter avoids retry herds without retrying sooner than the base delay.
  return Math.min(
    WORKSPACE_AUTH_RETRY_MAX_MS,
    Math.round(exponential * (1 + Math.max(0, Math.min(1, random())) * 0.25)),
  );
}

export function shouldRevalidateWorkspaceAuth(
  authenticated: boolean,
  dataUpdatedAt: number,
  isFetching: boolean,
  now = Date.now(),
): boolean {
  return (
    authenticated &&
    !isFetching &&
    now - dataUpdatedAt >= WORKSPACE_AUTH_RECHECK_MS
  );
}
