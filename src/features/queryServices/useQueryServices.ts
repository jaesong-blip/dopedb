import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  isTerminalQueryServiceSession,
  type QueryServiceSession,
} from "./domain";
import {
  listQueryServiceSessions,
  saveQueryServiceSession,
  type QueryServiceStorageScope,
} from "./tauriAdapter";
import { clearSqlResultPageCache } from "../queries/resultPageCache";

const MAX_SESSIONS = 20;

type QueryServiceScope = {
  key: string;
  ready: boolean;
  workspaceId: string | null;
  accountScope: string | null;
};

type ScopedSessions = {
  scopeKey: string;
  sessions: QueryServiceSession[];
  activeSessionId: string | null;
};

export function useQueryServices(
  scope: QueryServiceScope,
  onPersistenceError: (error: unknown) => void,
) {
  const [state, setState] = useState<ScopedSessions>(() => ({
    scopeKey: scope.key,
    sessions: [],
    activeSessionId: null,
  }));
  const scopeKeyRef = useRef(scope.key);
  const storageScopeRef = useRef<QueryServiceStorageScope | null>(null);
  const errorHandlerRef = useRef(onPersistenceError);
  const persistedSnapshots = useRef<Map<string, string>>(new Map());
  scopeKeyRef.current = scope.key;
  storageScopeRef.current = storageScope(scope);
  errorHandlerRef.current = onPersistenceError;

  useEffect(() => {
    clearSqlResultPageCache();
    persistedSnapshots.current.clear();
    const expectedScope = storageScope(scope);
    if (!scope.ready || !expectedScope) {
      setState({
        scopeKey: scope.key,
        sessions: [],
        activeSessionId: null,
      });
      return;
    }
    let cancelled = false;
    void listQueryServiceSessions(expectedScope)
      .then((loaded) => {
        if (cancelled || scopeKeyRef.current !== scope.key) return;
        setState((current) => {
          const currentSessions =
            current.scopeKey === scope.key ? current.sessions : [];
          const sessions = mergeSessions(currentSessions, loaded);
          const activeSessionId =
            current.scopeKey === scope.key &&
            current.activeSessionId &&
            sessions.some((session) => session.id === current.activeSessionId)
              ? current.activeSessionId
              : sessions[0]?.id ?? null;
          return { scopeKey: scope.key, sessions, activeSessionId };
        });
      })
      .catch((error) => {
        if (!cancelled && scopeKeyRef.current === scope.key) {
          errorHandlerRef.current(error);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [scope.key, scope.ready]);

  const updateSession = useCallback(
    (session: QueryServiceSession) => {
      const expectedScope = storageScope(scope);
      if (
        !scope.ready ||
        !expectedScope ||
        scopeKeyRef.current !== scope.key
      ) {
        return;
      }
      setState((current) => {
        const sessions =
          current.scopeKey === scope.key ? current.sessions : [];
        const next = mergeSessions(sessions, [session]);
        const activeSessionId =
          current.scopeKey === scope.key
            ? current.activeSessionId ?? session.id
            : session.id;
        return {
          scopeKey: scope.key,
          sessions: next,
          activeSessionId,
        };
      });
      if (!isTerminalQueryServiceSession(session)) return;
      const serialized = JSON.stringify(session);
      if (persistedSnapshots.current.get(session.id) === serialized) return;
      persistedSnapshots.current.set(session.id, serialized);
      const saveScopeKey = scope.key;
      void saveQueryServiceSession(expectedScope, session).catch(
        (error) => {
          if (
            scopeKeyRef.current !== saveScopeKey ||
            storageScopeRef.current?.workspaceId !==
              expectedScope.workspaceId ||
            storageScopeRef.current?.accountScope !==
              expectedScope.accountScope
          ) {
            return;
          }
          persistedSnapshots.current.delete(session.id);
          errorHandlerRef.current(error);
        },
      );
    },
    [
      scope.accountScope,
      scope.key,
      scope.ready,
      scope.workspaceId,
    ],
  );

  const activateSession = useCallback(
    (id: string) => {
      setState((current) =>
        current.scopeKey === scope.key
          ? { ...current, activeSessionId: id }
          : current,
      );
    },
    [scope.key],
  );

  const visible =
    state.scopeKey === scope.key
      ? state
      : { scopeKey: scope.key, sessions: [], activeSessionId: null };

  return {
    sessions: visible.sessions,
    activeSessionId: visible.activeSessionId,
    updateSession,
    activateSession,
    activateNewestSession: activateSession,
  };
}

function storageScope(
  scope: QueryServiceScope,
): QueryServiceStorageScope | null {
  if (!scope.workspaceId || !scope.accountScope) return null;
  return {
    workspaceId: scope.workspaceId,
    accountScope: scope.accountScope,
  };
}

function mergeSessions(
  current: QueryServiceSession[],
  incoming: QueryServiceSession[],
) {
  const byId = new Map(current.map((session) => [session.id, session]));
  for (const session of incoming) {
    const previous = byId.get(session.id);
    if (!previous || session.updatedAt >= previous.updatedAt) {
      byId.set(session.id, session);
    }
  }
  return [...byId.values()]
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_SESSIONS);
}
