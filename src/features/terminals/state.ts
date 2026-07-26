// Pure Terminal Dock reducer. Session ordering, activation, replacement, and replay
// warnings stay deterministic and independently testable from the xterm lifecycle.
import type {
  TerminalProfile,
  TerminalSessionId,
  TerminalSessionSummary,
} from "./domain";
import type { ConnectionId } from "../connections/domain";
import type { WorkspaceId } from "../workspaces/domain";

/**
 * A Terminal session is immutable and pinned to both its workspace and its
 * connection. Keeping the scope as a value instead of a connection-only map
 * prevents a same-id connection in another workspace from stealing a tab.
 */
export interface TerminalSessionScope {
  workspaceId: WorkspaceId;
  connectionId: ConnectionId;
}

export type TerminalScopeKey = string & {
  readonly __terminalScopeKey: unique symbol;
};

export interface TerminalDockLayout {
  maximized: boolean;
}

export function terminalScopeKey({
  workspaceId,
  connectionId,
}: TerminalSessionScope): TerminalScopeKey {
  return `${workspaceId}:${connectionId}` as TerminalScopeKey;
}

export function terminalSessionScope(
  session: TerminalSessionSummary,
): TerminalSessionScope {
  return {
    workspaceId: session.connection.workspaceId,
    connectionId: session.connection.connectionId,
  };
}

export interface TerminalDockState {
  sessions: TerminalSessionSummary[];
  activeIdByScope: Partial<Record<TerminalScopeKey, TerminalSessionId>>;
  layoutByScope: Partial<Record<TerminalScopeKey, TerminalDockLayout>>;
  loading: boolean;
  error: string | null;
  creatingProfile: TerminalProfile | null;
  replayTruncated: TerminalSessionId[];
}

export type TerminalDockAction =
  | {
      type: "loaded";
      sessions: TerminalSessionSummary[];
      currentScope: TerminalSessionScope | null;
    }
  | { type: "loadFailed"; error: string }
  | { type: "upsert"; session: TerminalSessionSummary }
  | {
      type: "replace";
      previousId: TerminalSessionId;
      session: TerminalSessionSummary;
    }
  | { type: "remove"; id: TerminalSessionId }
  | { type: "activate"; id: TerminalSessionId }
  | {
      type: "setLayout";
      scope: TerminalSessionScope;
      layout: Partial<TerminalDockLayout>;
    }
  | { type: "creating"; profile: TerminalProfile | null }
  | { type: "error"; error: string | null }
  | { type: "replayTruncated"; id: TerminalSessionId };

export const initialTerminalDockState: TerminalDockState = {
  sessions: [],
  activeIdByScope: {},
  layoutByScope: {},
  loading: true,
  error: null,
  creatingProfile: null,
  replayTruncated: [],
};

function byCreatedAt(
  left: TerminalSessionSummary,
  right: TerminalSessionSummary,
): number {
  return left.createdAt.localeCompare(right.createdAt);
}

function sortSessions(
  sessions: Iterable<TerminalSessionSummary>,
): TerminalSessionSummary[] {
  return [...sessions].sort(byCreatedAt);
}

function preferredSessionId(
  sessions: TerminalSessionSummary[],
  scope: TerminalSessionScope,
): TerminalSessionId | null {
  const matching = terminalSessionsForScope(sessions, scope);
  return matching[matching.length - 1]?.id ?? null;
}

function upsertSession(
  sessions: TerminalSessionSummary[],
  session: TerminalSessionSummary,
): TerminalSessionSummary[] {
  const byId = new Map(sessions.map((candidate) => [candidate.id, candidate]));
  byId.set(session.id, session);
  return sortSessions(byId.values());
}

export function terminalDockReducer(
  state: TerminalDockState,
  action: TerminalDockAction,
): TerminalDockState {
  switch (action.type) {
    case "loaded": {
      const sessions = sortSessions(action.sessions);
      const activeIdByScope: TerminalDockState["activeIdByScope"] = {};
      for (const session of sessions) {
        const scopeKey = terminalScopeKey(terminalSessionScope(session));
        const activeId = state.activeIdByScope[scopeKey];
        if (activeId === session.id) {
          activeIdByScope[scopeKey] = activeId;
        }
      }
      if (action.currentScope) {
        const key = terminalScopeKey(action.currentScope);
        const preferred = preferredSessionId(sessions, action.currentScope);
        if (preferred && !activeIdByScope[key]) {
          activeIdByScope[key] = preferred;
        }
      }
      return {
        ...state,
        sessions,
        activeIdByScope,
        loading: false,
        error: null,
      };
    }
    case "loadFailed":
      return {
        ...state,
        loading: false,
        error: action.error,
      };
    case "upsert": {
      const sessions = upsertSession(state.sessions, action.session);
      const key = terminalScopeKey(terminalSessionScope(action.session));
      return {
        ...state,
        sessions,
        activeIdByScope: {
          ...state.activeIdByScope,
          [key]: state.activeIdByScope[key] ?? action.session.id,
        },
      };
    }
    case "replace": {
      const sessions = upsertSession(
        state.sessions.filter((session) => session.id !== action.previousId),
        action.session,
      );
      const key = terminalScopeKey(terminalSessionScope(action.session));
      return {
        ...state,
        sessions,
        activeIdByScope: {
          ...state.activeIdByScope,
          [key]: state.activeIdByScope[key] === action.previousId ||
            state.activeIdByScope[key] === undefined
              ? action.session.id
              : state.activeIdByScope[key],
        },
        replayTruncated: state.replayTruncated.filter(
          (id) => id !== action.previousId,
        ),
      };
    }
    case "remove": {
      const removed = state.sessions.find(
        (session) => session.id === action.id,
      );
      if (!removed) return state;
      const scope = terminalSessionScope(removed);
      const key = terminalScopeKey(scope);
      const scoped = terminalSessionsForScope(state.sessions, scope);
      const removedIndex = scoped.findIndex(
        (session) => session.id === action.id,
      );
      const nextActive =
        scoped[removedIndex + 1]?.id ?? scoped[removedIndex - 1]?.id;
      const activeIdByScope = { ...state.activeIdByScope };
      if (activeIdByScope[key] === action.id) {
        if (nextActive) activeIdByScope[key] = nextActive;
        else delete activeIdByScope[key];
      }
      return {
        ...state,
        sessions: state.sessions.filter(
          (session) => session.id !== action.id,
        ),
        activeIdByScope,
        replayTruncated: state.replayTruncated.filter(
          (id) => id !== action.id,
        ),
      };
    }
    case "activate": {
      const session = state.sessions.find(
        (candidate) => candidate.id === action.id,
      );
      return session
        ? {
            ...state,
            activeIdByScope: {
              ...state.activeIdByScope,
              [terminalScopeKey(terminalSessionScope(session))]: action.id,
            },
          }
        : state;
    }
    case "setLayout": {
      const key = terminalScopeKey(action.scope);
      return {
        ...state,
        layoutByScope: {
          ...state.layoutByScope,
          [key]: {
            maximized: false,
            ...state.layoutByScope[key],
            ...action.layout,
          },
        },
      };
    }
    case "creating":
      return {
        ...state,
        creatingProfile: action.profile,
      };
    case "error":
      return {
        ...state,
        error: action.error,
      };
    case "replayTruncated":
      return state.replayTruncated.includes(action.id)
        ? state
        : {
            ...state,
            replayTruncated: [...state.replayTruncated, action.id],
          };
  }
}

export function terminalSessionsForScope(
  sessions: TerminalSessionSummary[],
  scope: TerminalSessionScope,
): TerminalSessionSummary[] {
  return sessions.filter(
    (session) =>
      session.connection.workspaceId === scope.workspaceId &&
      session.connection.connectionId === scope.connectionId,
  );
}

export function terminalActiveIdForScope(
  state: TerminalDockState,
  scope: TerminalSessionScope | null,
): TerminalSessionId | null {
  if (!scope) return null;
  const scoped = terminalSessionsForScope(state.sessions, scope);
  const stored = state.activeIdByScope[terminalScopeKey(scope)];
  return stored !== undefined && scoped.some((session) => session.id === stored)
    ? stored
    : preferredSessionId(scoped, scope);
}

export function terminalLayoutForScope(
  state: TerminalDockState,
  scope: TerminalSessionScope | null,
): TerminalDockLayout {
  return scope
    ? (state.layoutByScope[terminalScopeKey(scope)] ?? { maximized: false })
    : { maximized: false };
}

export function terminalSessionIsRunning(
  session: TerminalSessionSummary,
): boolean {
  return (
    session.lifecycle === "starting" ||
    session.lifecycle === "running" ||
    session.lifecycle === "stopping"
  );
}
