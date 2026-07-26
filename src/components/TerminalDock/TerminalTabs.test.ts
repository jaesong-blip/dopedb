import { describe, expect, it } from "vitest";

import { terminalPopupFocusIndex } from "./TerminalTabs";

describe("Terminal popup keyboard focus", () => {
  it("cycles Tab and Shift-Tab inside the portal menu", () => {
    expect(
      terminalPopupFocusIndex({
        currentIndex: 0,
        itemCount: 3,
        key: "Tab",
        shiftKey: false,
      }),
    ).toBe(1);
    expect(
      terminalPopupFocusIndex({
        currentIndex: 0,
        itemCount: 3,
        key: "Tab",
        shiftKey: true,
      }),
    ).toBe(2);
  });

  it("keeps menu arrow, Home, and End navigation deterministic", () => {
    expect(
      terminalPopupFocusIndex({
        currentIndex: 1,
        itemCount: 3,
        key: "ArrowDown",
        shiftKey: false,
      }),
    ).toBe(2);
    expect(
      terminalPopupFocusIndex({
        currentIndex: 1,
        itemCount: 3,
        key: "ArrowUp",
        shiftKey: false,
      }),
    ).toBe(0);
    expect(
      terminalPopupFocusIndex({
        currentIndex: 1,
        itemCount: 3,
        key: "Home",
        shiftKey: false,
      }),
    ).toBe(0);
    expect(
      terminalPopupFocusIndex({
        currentIndex: 1,
        itemCount: 3,
        key: "End",
        shiftKey: false,
      }),
    ).toBe(2);
  });
});
