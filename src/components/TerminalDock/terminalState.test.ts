// Reducer contract tests for connection pinning and concurrent Terminal sessions.
import { describe, expect, it } from "vitest";
import type { TerminalSessionSummary } from "../../ipc/types";
import {
  initialTerminalDockState,
  terminalConnectionMismatch,
  terminalDockReducer,
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

    expect(state.activeId).toBe("current-new");
    expect(state.sessions.map(({ id }) => id)).toEqual([
      "current-old",
      "current-new",
      "other",
    ]);
  });

  it("keeps the active session when the workbench connection changes", () => {
    const loaded = terminalDockReducer(initialTerminalDockState, {
      type: "loaded",
      sessions: [session("pinned", "db-1", "2026-07-25T00:00:00Z")],
      currentConnectionId: "db-1",
    });
    const afterSwitch = terminalDockReducer(loaded, {
      type: "loaded",
      sessions: loaded.sessions,
      currentConnectionId: "db-2",
    });

    expect(afterSwitch.activeId).toBe("pinned");
    expect(
      terminalConnectionMismatch(afterSwitch.sessions[0], "db-2"),
    ).toBe(true);
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
    expect(restarted.activeId).toBe("new");
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
