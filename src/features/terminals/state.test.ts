// Reducer contract tests for connection pinning and concurrent Terminal sessions.
import { describe, expect, it } from "vitest";
import { connectionId } from "../connections/domain";
import { workspaceId } from "../workspaces/domain";
import {
  terminalSessionId,
  type TerminalSessionSummary,
} from "./domain";
import {
  initialTerminalDockState,
  terminalActiveIdForScope,
  terminalDockReducer,
  terminalLayoutForScope,
  terminalSessionsForScope,
  type TerminalSessionScope,
} from "./state";

function session(
  id: string,
  connection: string,
  createdAt: string,
  workspace = "workspace-a",
): TerminalSessionSummary {
  const idValue = terminalSessionId(id);
  const connectionIdValue = connectionId(connection);
  return {
    id: idValue,
    name: idValue,
    profile: "shell",
    lifecycle: "running",
    size: {
      cols: 100,
      rows: 30,
      pixelWidth: 0,
      pixelHeight: 0,
    },
    connection: {
      workspaceId: workspaceId(workspace),
      accountScope: "local",
      scopeGeneration: 1,
      connectionId: connectionIdValue,
      connectionRevision: 1,
      connectionName: connectionIdValue,
      database: "app",
      environment: "dev",
      engine: "postgres",
      policy: "readOnly",
    },
    createdAt,
    lastActivityAt: createdAt,
    exit: null,
  };
}

describe("Terminal Dock state", () => {
  const db1 = connectionId("db-1");
  const db2 = connectionId("db-2");
  const scopeA: TerminalSessionScope = {
    workspaceId: workspaceId("workspace-a"),
    connectionId: db1,
  };
  const scopeB: TerminalSessionScope = {
    workspaceId: workspaceId("workspace-b"),
    connectionId: db1,
  };
  const db2Scope: TerminalSessionScope = {
    workspaceId: workspaceId("workspace-a"),
    connectionId: db2,
  };

  it("prefers the newest session pinned to the current connection", () => {
    const state = terminalDockReducer(initialTerminalDockState, {
      type: "loaded",
      sessions: [
        session("other", "db-2", "2026-07-25T00:00:03Z"),
        session("current-old", "db-1", "2026-07-25T00:00:01Z"),
        session("current-new", "db-1", "2026-07-25T00:00:02Z"),
      ],
      currentScope: scopeA,
    });

    expect(terminalActiveIdForScope(state, scopeA)).toBe(
      "current-new",
    );
    expect(state.sessions.map(({ id }) => id)).toEqual([
      "current-old",
      "current-new",
      "other",
    ]);
  });

  it("keeps independent active sessions for each connection", () => {
    const loaded = terminalDockReducer(initialTerminalDockState, {
      type: "loaded",
      sessions: [
        session("db-1-old", "db-1", "2026-07-25T00:00:00Z"),
        session("db-1-new", "db-1", "2026-07-25T00:00:01Z"),
        session("db-2-only", "db-2", "2026-07-25T00:00:02Z"),
      ],
      currentScope: scopeA,
    });
    const selectedOld = terminalDockReducer(loaded, {
      type: "activate",
      id: terminalSessionId("db-1-old"),
    });
    const selectedOther = terminalDockReducer(selectedOld, {
      type: "activate",
      id: terminalSessionId("db-2-only"),
    });

    expect(terminalActiveIdForScope(selectedOther, scopeA)).toBe(
      "db-1-old",
    );
    expect(terminalActiveIdForScope(selectedOther, db2Scope)).toBe(
      "db-2-only",
    );
    expect(
      terminalSessionsForScope(selectedOther.sessions, scopeA).map(
        ({ id }) => id,
      ),
    ).toEqual(["db-1-old", "db-1-new"]);
  });

  it("replaces a restarted process with its new immutable session", () => {
    const previous = session("old", "db-1", "2026-07-25T00:00:00Z");
    const loaded = terminalDockReducer(initialTerminalDockState, {
      type: "loaded",
      sessions: [previous],
      currentScope: scopeA,
    });
    const next = session("new", "db-1", "2026-07-25T00:00:01Z");
    const restarted = terminalDockReducer(loaded, {
      type: "replace",
      previousId: previous.id,
      session: next,
    });

    expect(restarted.sessions.map(({ id }) => id)).toEqual(["new"]);
    expect(terminalActiveIdForScope(restarted, scopeA)).toBe("new");
  });

  it("selects an adjacent scoped tab after closing the active session", () => {
    const loaded = terminalDockReducer(initialTerminalDockState, {
      type: "loaded",
      sessions: [
        session("first", "db-1", "2026-07-25T00:00:00Z"),
        session("active", "db-1", "2026-07-25T00:00:01Z"),
        session("next", "db-1", "2026-07-25T00:00:02Z"),
        session("other", "db-2", "2026-07-25T00:00:03Z"),
      ],
      currentScope: scopeA,
    });
    const active = terminalDockReducer(loaded, {
      type: "activate",
      id: terminalSessionId("active"),
    });
    const closed = terminalDockReducer(active, {
      type: "remove",
      id: terminalSessionId("active"),
    });

    expect(terminalActiveIdForScope(closed, scopeA)).toBe("next");
    expect(closed.sessions.map(({ id }) => id)).toEqual([
      "first",
      "next",
      "other",
    ]);
  });

  it("leaves another connection selection untouched when closing a tab", () => {
    const loaded = terminalDockReducer(initialTerminalDockState, {
      type: "loaded",
      sessions: [
        session("db-1", "db-1", "2026-07-25T00:00:00Z"),
        session("db-2", "db-2", "2026-07-25T00:00:01Z"),
      ],
      currentScope: scopeA,
    });
    const selectedOther = terminalDockReducer(loaded, {
      type: "activate",
      id: terminalSessionId("db-2"),
    });
    const closed = terminalDockReducer(selectedOther, {
      type: "remove",
      id: terminalSessionId("db-1"),
    });

    expect(terminalActiveIdForScope(closed, scopeA)).toBeNull();
    expect(terminalActiveIdForScope(closed, db2Scope)).toBe("db-2");
  });

  it("restores independent selections when a connection id appears in A and B", () => {
    const loaded = terminalDockReducer(initialTerminalDockState, {
      type: "loaded",
      sessions: [
        session("a-first", "db-1", "2026-07-25T00:00:00Z", "workspace-a"),
        session("a-last", "db-1", "2026-07-25T00:00:01Z", "workspace-a"),
        session("b-only", "db-1", "2026-07-25T00:00:02Z", "workspace-b"),
      ],
      currentScope: scopeA,
    });
    const aSelected = terminalDockReducer(loaded, {
      type: "activate",
      id: terminalSessionId("a-first"),
    });
    const bSelected = terminalDockReducer(aSelected, {
      type: "activate",
      id: terminalSessionId("b-only"),
    });

    expect(terminalActiveIdForScope(bSelected, scopeA)).toBe("a-first");
    expect(terminalActiveIdForScope(bSelected, scopeB)).toBe("b-only");
    expect(terminalSessionsForScope(bSelected.sessions, scopeA)).toHaveLength(2);
    expect(terminalSessionsForScope(bSelected.sessions, scopeB)).toHaveLength(1);
  });

  it("keeps dock layout scoped with the workspace selection", () => {
    const maximizedA = terminalDockReducer(initialTerminalDockState, {
      type: "setLayout",
      scope: scopeA,
      layout: { maximized: true },
    });
    const restoredB = terminalDockReducer(maximizedA, {
      type: "setLayout",
      scope: scopeB,
      layout: { maximized: false },
    });

    expect(terminalLayoutForScope(restoredB, scopeA).maximized).toBe(true);
    expect(terminalLayoutForScope(restoredB, scopeB).maximized).toBe(false);
  });

  it("records replay truncation once per session", () => {
    const first = terminalDockReducer(initialTerminalDockState, {
      type: "replayTruncated",
      id: terminalSessionId("terminal-1"),
    });
    const second = terminalDockReducer(first, {
      type: "replayTruncated",
      id: terminalSessionId("terminal-1"),
    });

    expect(second.replayTruncated).toEqual(["terminal-1"]);
  });
});
