// Reducer contract tests for connection pinning and concurrent Terminal sessions.
import { describe, expect, it } from "vitest";
import type { TerminalSessionSummary } from "../../ipc/types";
import {
  initialTerminalDockState,
  terminalActiveIdForConnection,
  terminalDockReducer,
  terminalSessionsForConnection,
} from "./terminalState";

function session(
  id: string,
  connectionId: string,
  createdAt: string,
): TerminalSessionSummary {
  return {
    id,
    name: id,
    profile: "shell",
    lifecycle: "running",
    size: {
      cols: 100,
      rows: 30,
      pixelWidth: 0,
      pixelHeight: 0,
    },
    connection: {
      workspaceId: "workspace",
      accountScope: "local",
      scopeGeneration: 1,
      connectionId,
      connectionRevision: 1,
      connectionName: connectionId,
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
  it("prefers the newest session pinned to the current connection", () => {
    const state = terminalDockReducer(initialTerminalDockState, {
      type: "loaded",
      sessions: [
        session("other", "db-2", "2026-07-25T00:00:03Z"),
        session("current-old", "db-1", "2026-07-25T00:00:01Z"),
        session("current-new", "db-1", "2026-07-25T00:00:02Z"),
      ],
      currentConnectionId: "db-1",
    });

    expect(terminalActiveIdForConnection(state, "db-1")).toBe(
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
      currentConnectionId: "db-1",
    });
    const selectedOld = terminalDockReducer(loaded, {
      type: "activate",
      id: "db-1-old",
    });
    const selectedOther = terminalDockReducer(selectedOld, {
      type: "activate",
      id: "db-2-only",
    });

    expect(terminalActiveIdForConnection(selectedOther, "db-1")).toBe(
      "db-1-old",
    );
    expect(terminalActiveIdForConnection(selectedOther, "db-2")).toBe(
      "db-2-only",
    );
    expect(
      terminalSessionsForConnection(selectedOther.sessions, "db-1").map(
        ({ id }) => id,
      ),
    ).toEqual(["db-1-old", "db-1-new"]);
  });

  it("replaces a restarted process with its new immutable session", () => {
    const previous = session("old", "db-1", "2026-07-25T00:00:00Z");
    const loaded = terminalDockReducer(initialTerminalDockState, {
      type: "loaded",
      sessions: [previous],
      currentConnectionId: "db-1",
    });
    const next = session("new", "db-1", "2026-07-25T00:00:01Z");
    const restarted = terminalDockReducer(loaded, {
      type: "replace",
      previousId: previous.id,
      session: next,
    });

    expect(restarted.sessions.map(({ id }) => id)).toEqual(["new"]);
    expect(terminalActiveIdForConnection(restarted, "db-1")).toBe("new");
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
      currentConnectionId: "db-1",
    });
    const active = terminalDockReducer(loaded, {
      type: "activate",
      id: "active",
    });
    const closed = terminalDockReducer(active, {
      type: "remove",
      id: "active",
    });

    expect(terminalActiveIdForConnection(closed, "db-1")).toBe("next");
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
      currentConnectionId: "db-1",
    });
    const selectedOther = terminalDockReducer(loaded, {
      type: "activate",
      id: "db-2",
    });
    const closed = terminalDockReducer(selectedOther, {
      type: "remove",
      id: "db-1",
    });

    expect(terminalActiveIdForConnection(closed, "db-1")).toBeNull();
    expect(terminalActiveIdForConnection(closed, "db-2")).toBe("db-2");
  });

  it("records replay truncation once per session", () => {
    const first = terminalDockReducer(initialTerminalDockState, {
      type: "replayTruncated",
      id: "terminal-1",
    });
    const second = terminalDockReducer(first, {
      type: "replayTruncated",
      id: "terminal-1",
    });

    expect(second.replayTruncated).toEqual(["terminal-1"]);
  });
});
