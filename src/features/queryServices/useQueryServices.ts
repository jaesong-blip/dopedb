import { useCallback, useState } from "react";

import type { QueryServiceSession } from "./domain";

const MAX_SESSIONS = 20;

export function useQueryServices() {
  const [sessions, setSessions] = useState<QueryServiceSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  const updateSession = useCallback((session: QueryServiceSession) => {
    setSessions((current) => {
      const existingIndex = current.findIndex(
        (candidate) => candidate.id === session.id,
      );
      if (existingIndex < 0) {
        return [session, ...current].slice(0, MAX_SESSIONS);
      }
      const next = [...current];
      next[existingIndex] = session;
      return next;
    });
    setActiveSessionId((current) => current ?? session.id);
  }, []);

  const activateSession = useCallback((id: string) => {
    setActiveSessionId(id);
  }, []);

  const activateNewestSession = useCallback((id: string) => {
    setActiveSessionId(id);
  }, []);

  return {
    sessions,
    activeSessionId,
    updateSession,
    activateSession,
    activateNewestSession,
  };
}
