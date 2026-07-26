import { describe, expect, it, vi } from "vitest";

import { terminalSessionId, type TerminalSessionSummary } from "./domain";
import {
  runTerminalCloseBatch,
  shouldCloseTerminalFromShortcut,
  terminalCloseTargetIds,
} from "./commands";

const sessions = ["one", "two", "three"].map(
  (id, index) =>
    ({ id: terminalSessionId(id), createdAt: String(index) }) as TerminalSessionSummary,
);

describe("Terminal close commands", () => {
  it("never expands a stale target outside the visible scoped sessions", () => {
    expect(terminalCloseTargetIds(sessions, terminalSessionId("missing"), "others")).toEqual([]);
    expect(terminalCloseTargetIds(sessions, terminalSessionId("two"), "others")).toEqual([
      "one",
      "three",
    ]);
    expect(terminalCloseTargetIds(sessions, terminalSessionId("two"), "right")).toEqual([
      "three",
    ]);
  });

  it("stops Close Others and Close Right after any running-session confirmation is cancelled", async () => {
    const close = vi.fn(async (id) => (id === "two" ? "cancelled" : "closed"));
    await expect(
      runTerminalCloseBatch([terminalSessionId("one"), terminalSessionId("two"), terminalSessionId("three")], close),
    ).resolves.toEqual(["closed", "cancelled"]);
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("handles Cmd-W and Ctrl-W from any Terminal Dock focus, including xterm", () => {
    expect(
      shouldCloseTerminalFromShortcut({
        key: "w", metaKey: false, ctrlKey: true, altKey: false, shiftKey: false, focusInsideDock: true,
      }),
    ).toBe(true);
    expect(
      shouldCloseTerminalFromShortcut({
        key: "w", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, focusInsideDock: true,
      }),
    ).toBe(true);
    expect(
      shouldCloseTerminalFromShortcut({
        key: "w", metaKey: false, ctrlKey: true, altKey: false, shiftKey: false, focusInsideDock: false,
      }),
    ).toBe(false);
  });
});
