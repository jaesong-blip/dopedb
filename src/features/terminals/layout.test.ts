import { describe, expect, it } from "vitest";

import {
  clampTerminalDockWidth,
  terminalPopupPosition,
  TERMINAL_DOCK_DEFAULT_WIDTH,
  TERMINAL_DOCK_MAX_WIDTH,
  TERMINAL_DOCK_MIN_WIDTH,
} from "./layout";

describe("Terminal Dock geometry", () => {
  it("keeps the 360px minimum while respecting a narrow viewport", () => {
    expect(clampTerminalDockWidth(100, 360)).toBe(TERMINAL_DOCK_MIN_WIDTH);
    expect(clampTerminalDockWidth(720, 640)).toBe(TERMINAL_DOCK_MIN_WIDTH);
  });

  it("clamps normal and maximized-width restoration requests", () => {
    expect(clampTerminalDockWidth(TERMINAL_DOCK_DEFAULT_WIDTH, 1600)).toBe(
      TERMINAL_DOCK_DEFAULT_WIDTH,
    );
    expect(clampTerminalDockWidth(9999, 2000)).toBe(TERMINAL_DOCK_MAX_WIDTH);
  });

  it("keeps portal menus within a 360px overlay and flips above a bottom trigger", () => {
    expect(
      terminalPopupPosition(
        { left: 350, top: 320, bottom: 344 },
        { width: 272, height: 132 },
        { width: 360, height: 360 },
      ),
    ).toEqual({ left: 80, top: 184, width: 272 });
  });
});
