import type {
  AcpSessionId,
  AcpSessionLifecycle,
  AcpSessionSummary,
  AgentProvider,
} from "./domain";

export function isLiveSession(lifecycle: AcpSessionLifecycle) {
  return ["starting", "ready", "running", "waitingPermission"].includes(
    lifecycle,
  );
}

export function selectWorkspaceSessions(
  sessions: readonly AcpSessionSummary[],
  enabledProviders: readonly AgentProvider[],
) {
  return sessions
    .filter((session) => enabledProviders.includes(session.provider))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export type AcpFocusRequest = {
  requestId: number;
  scopeKey: string;
  selectionGeneration: number;
  selectedSessionId: AcpSessionId | null;
};

export function isCurrentAcpFocusRequest(
  request: AcpFocusRequest,
  current: AcpFocusRequest,
) {
  return (
    request.requestId === current.requestId &&
    request.scopeKey === current.scopeKey &&
    request.selectionGeneration === current.selectionGeneration &&
    request.selectedSessionId === current.selectedSessionId
  );
}

export function ownsStartedAcpSession(
  request: AcpFocusRequest,
  current: AcpFocusRequest,
  startedSessionId: AcpSessionId,
) {
  return (
    isCurrentAcpFocusRequest(request, current) ||
    (request.scopeKey === current.scopeKey &&
      current.selectedSessionId === startedSessionId)
  );
}
