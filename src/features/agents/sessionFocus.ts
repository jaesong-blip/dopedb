import type { AcpSessionId } from "./domain";

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
