// Pure Terminal Dock reducer. Session ordering, activation, replacement, and replay
// warnings stay deterministic and independently testable from the xterm lifecycle.
import type {
  TerminalProfile,
  TerminalSessionSummary,
} from "../../ipc/types";

export interface TerminalDockState {
  sessions: TerminalSessionSummary[];
  activeId: string | null;
  loading: boolean;
  error: string | null;
  creatingProfile: TerminalProfile | null;
  replayTruncated: string[];
}

export type TerminalDockAction =
  | {
      type: "loaded";
      sessions: TerminalSessionSummary[];
      currentConnectionId: string;
    }
  | { type: "loadFailed"; error: string }
  | { type: "upsert"; session: TerminalSessionSummary }
  | {
      type: "replace";
      previousId: string;
      session: TerminalSessionSummary;
    }
  | { type: "activate"; id: string }
  | { type: "creating"; profile: TerminalProfile | null }
  | { type: "error"; error: string | null }
  | { type: "replayTruncated"; id: string };

export const initialTerminalDockState: TerminalDockState = {
  sessions: [],
  activeId: null,
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
  currentConnectionId: string,
): string | null {
  const matching = sessions.filter(
    (session) => session.connection.connectionId === currentConnectionId,
  );
  return (
    matching[matching.length - 1]?.id ??
    sessions[sessions.length - 1]?.id ??
    null
  );
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
      const byId = new Map(
        state.sessions.map((session) => [session.id, session]),
      );
      for (const session of action.sessions) byId.set(session.id, session);
      const sessions = sortSessions(byId.values());
      const activeId = sessions.some(
        (session) => session.id === state.activeId,
      )
        ? state.activeId
        : preferredSessionId(sessions, action.currentConnectionId);
      return {
        ...state,
        sessions,
        activeId,
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
      return {
        ...state,
        sessions,
        activeId: state.activeId ?? action.session.id,
      };
    }
    case "replace": {
      const sessions = upsertSession(
        state.sessions.filter((session) => session.id !== action.previousId),
        action.session,
      );
      return {
        ...state,
        sessions,
        activeId:
          state.activeId === action.previousId || state.activeId === null
            ? action.session.id
            : state.activeId,
        replayTruncated: state.replayTruncated.filter(
          (id) => id !== action.previousId,
        ),
      };
    }
    case "activate":
      return state.sessions.some((session) => session.id === action.id)
        ? { ...state, activeId: action.id }
        : state;
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

export function terminalSessionIsRunning(
  session: TerminalSessionSummary,
): boolean {
  return (
    session.lifecycle === "starting" ||
    session.lifecycle === "running" ||
    session.lifecycle === "stopping"
  );
}

export function terminalConnectionMismatch(
  session: TerminalSessionSummary,
  currentConnectionId: string,
): boolean {
  return session.connection.connectionId !== currentConnectionId;
}
