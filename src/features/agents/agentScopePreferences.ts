export type AgentScopeKind = "project" | "database";

const STORAGE_KEY = "agentSessionScopeKinds.v1";
const MAX_ENTRIES = 100;

type StoredScope = { sessionId: string; kind: AgentScopeKind };

function readStoredScopes(): StoredScope[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.filter(
      (entry): entry is StoredScope =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as StoredScope).sessionId === "string" &&
        ["project", "database"].includes((entry as StoredScope).kind),
    );
  } catch {
    return [];
  }
}

export function storedAgentScopeKind(sessionId: string) {
  return readStoredScopes().find((entry) => entry.sessionId === sessionId)?.kind;
}

export function rememberAgentScopeKind(
  sessionId: string,
  kind: AgentScopeKind,
) {
  if (typeof localStorage === "undefined") return;
  const next = [
    ...readStoredScopes().filter((entry) => entry.sessionId !== sessionId),
    { sessionId, kind },
  ].slice(-MAX_ENTRIES);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Scope presentation is local UI state; authority remains in the ACP grant.
  }
}
