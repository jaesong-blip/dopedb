// The ACP process inventory and backend event subscription are application state,
// not panel state. One external store closes the list/listen race once and lets the
// Agent tool window plus status bar observe the same authoritative projection.
import { useEffect, useMemo, useSyncExternalStore } from "react";

import type { AcpSessionChanged, AcpSessionSummary } from "./domain";
import { listAgentAcpSessions, onAgentAcpChanged } from "./tauriAdapter";

type Snapshot = {
  scopeKey: string | null;
  sessions: readonly AcpSessionSummary[];
  loading: boolean;
  error: unknown;
};

type Listener = () => void;
type ChangeListener = (change: AcpSessionChanged) => void;

const EMPTY_SNAPSHOT: Snapshot = {
  scopeKey: null,
  sessions: [],
  loading: false,
  error: null,
};

export function mergeAcpSessionSummaries(
  current: readonly AcpSessionSummary[],
  incoming: readonly AcpSessionSummary[],
): readonly AcpSessionSummary[] {
  if (incoming.length === 0) return current;
  const merged = new Map(current.map((session) => [session.id, session]));
  let changed = false;
  for (const session of incoming) {
    const previous = merged.get(session.id);
    if (previous && previous.updatedAt > session.updatedAt) continue;
    if (previous !== session) changed = true;
    merged.set(session.id, session);
  }
  return changed ? [...merged.values()] : current;
}

export class AcpSessionStore {
  private snapshot: Snapshot = EMPTY_SNAPSHOT;
  private listeners = new Set<Listener>();
  private changeListeners = new Set<ChangeListener>();
  private unlisten: (() => void) | null = null;
  private generation = 0;

  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  subscribeChanges = (listener: ChangeListener) => {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  };

  getSnapshot = () => this.snapshot;

  activate(scopeKey: string) {
    if (
      this.snapshot.scopeKey === scopeKey &&
      (this.snapshot.loading || this.snapshot.error === null)
    ) {
      return;
    }
    const generation = ++this.generation;
    this.unlisten?.();
    this.unlisten = null;
    this.publish({ scopeKey, sessions: [], loading: true, error: null });

    void onAgentAcpChanged((change) => {
      if (generation !== this.generation) return;
      this.upsert([change.session]);
      for (const listener of this.changeListeners) listener(change);
    })
      .then((unlisten) => {
        if (generation !== this.generation) {
          unlisten();
          return;
        }
        this.unlisten = unlisten;
        return listAgentAcpSessions().then((sessions) => {
          if (generation !== this.generation) return;
          this.publish({
            ...this.snapshot,
            sessions: mergeAcpSessionSummaries(this.snapshot.sessions, sessions),
            loading: false,
            error: null,
          });
        });
      })
      .catch((error) => {
        if (generation !== this.generation) return;
        this.publish({ ...this.snapshot, loading: false, error });
      });
  }

  upsert(sessions: readonly AcpSessionSummary[]) {
    const merged = mergeAcpSessionSummaries(this.snapshot.sessions, sessions);
    if (merged === this.snapshot.sessions) return;
    this.publish({
      ...this.snapshot,
      sessions: merged,
      // A change event proves only that one session changed; it is neither a complete
      // inventory receipt nor a recovery receipt. Preserve both the pending list and
      // a failed-list error until a full inventory read succeeds.
      loading: this.snapshot.loading,
      error: this.snapshot.error,
    });
  }

  private publish(snapshot: Snapshot) {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}

export const acpSessionStore = new AcpSessionStore();

export function useAcpSessionSnapshot(scopeKey: string, enabled = true) {
  useEffect(() => {
    if (enabled) acpSessionStore.activate(scopeKey);
  }, [enabled, scopeKey]);
  const snapshot = useSyncExternalStore(
    acpSessionStore.subscribe,
    acpSessionStore.getSnapshot,
    acpSessionStore.getSnapshot,
  );
  return useMemo(
    () => snapshot.scopeKey === scopeKey ? snapshot : EMPTY_SNAPSHOT,
    [scopeKey, snapshot],
  );
}

export function subscribeAcpSessionChanges(listener: ChangeListener) {
  return acpSessionStore.subscribeChanges(listener);
}

export function retryAcpSessionSnapshot(scopeKey: string) {
  acpSessionStore.activate(scopeKey);
}
