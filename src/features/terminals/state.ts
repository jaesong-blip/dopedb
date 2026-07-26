// Pure Terminal Dock reducer. Session ordering, activation, replacement, and replay
// warnings stay deterministic and independently testable from the xterm lifecycle.
import type {
  TerminalProfile,
  TerminalSessionId,
  TerminalSessionSummary,
} from "./domain";
import type { ConnectionId } from "../connections/domain";

export interface TerminalDockState {
  sessions: TerminalSessionSummary[];
  activeIdByConnection: Partial<
    Record<ConnectionId, TerminalSessionId>
  >;
  loading: boolean;
  error: string | null;
  creatingProfile: TerminalProfile | null;
  replayTruncated: TerminalSessionId[];
}

export type TerminalDockAction =
  | {
      type: "loaded";
      sessions: TerminalSessionSummary[];
      currentConnectionId: ConnectionId;
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
  | { type: "creating"; profile: TerminalProfile | null }
  | { type: "error"; error: string | null }
  | { type: "replayTruncated"; id: TerminalSessionId };

export const initialTerminalDockState: TerminalDockState = {
  sessions: [],
  activeIdByConnection: {},
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
  connectionId: ConnectionId,
): TerminalSessionId | null {
  const matching = sessions.filter(
    (session) => session.connection.connectionId === connectionId,
  );
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
      const activeIdByConnection: TerminalDockState["activeIdByConnection"] = {};
      for (const session of sessions) {
        const activeId = state.activeIdByConnection[session.connection.connectionId];
        if (activeId === session.id) {
          activeIdByConnection[session.connection.connectionId] = activeId;
        }
      }
      const preferred = preferredSessionId(
        sessions,
        action.currentConnectionId,
      );
      if (preferred && !activeIdByConnection[action.currentConnectionId]) {
        activeIdByConnection[action.currentConnectionId] = preferred;
      }
      return {
        ...state,
        sessions,
        activeIdByConnection,
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
      const connectionId = action.session.connection.connectionId;
      return {
        ...state,
        sessions,
        activeIdByConnection: {
          ...state.activeIdByConnection,
          [connectionId]:
            state.activeIdByConnection[connectionId] ?? action.session.id,
        },
      };
    }
    case "replace": {
      const sessions = upsertSession(
        state.sessions.filter((session) => session.id !== action.previousId),
        action.session,
      );
      const connectionId = action.session.connection.connectionId;
      return {
        ...state,
        sessions,
        activeIdByConnection: {
          ...state.activeIdByConnection,
          [connectionId]:
            state.activeIdByConnection[connectionId] === action.previousId ||
            state.activeIdByConnection[connectionId] === undefined
              ? action.session.id
              : state.activeIdByConnection[connectionId],
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
      const connectionId = removed.connection.connectionId;
      const scoped = terminalSessionsForConnection(
        state.sessions,
        connectionId,
      );
      const removedIndex = scoped.findIndex(
        (session) => session.id === action.id,
      );
      const nextActive =
        scoped[removedIndex + 1]?.id ?? scoped[removedIndex - 1]?.id;
      const activeIdByConnection = { ...state.activeIdByConnection };
      if (activeIdByConnection[connectionId] === action.id) {
        if (nextActive) activeIdByConnection[connectionId] = nextActive;
        else delete activeIdByConnection[connectionId];
      }
      return {
        ...state,
        sessions: state.sessions.filter(
          (session) => session.id !== action.id,
        ),
        activeIdByConnection,
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
            activeIdByConnection: {
              ...state.activeIdByConnection,
              [session.connection.connectionId]: action.id,
            },
          }
        : state;
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

export function terminalSessionsForConnection(
  sessions: TerminalSessionSummary[],
  connectionId: ConnectionId,
): TerminalSessionSummary[] {
  return sessions.filter(
    (session) => session.connection.connectionId === connectionId,
  );
}

export function terminalActiveIdForConnection(
  state: TerminalDockState,
  connectionId: ConnectionId,
): TerminalSessionId | null {
  const scoped = terminalSessionsForConnection(
    state.sessions,
    connectionId,
  );
  const stored = state.activeIdByConnection[connectionId];
  return stored !== undefined && scoped.some((session) => session.id === stored)
    ? stored
    : preferredSessionId(scoped, connectionId);
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
