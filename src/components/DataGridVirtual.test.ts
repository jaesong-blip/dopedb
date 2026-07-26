import { describe, expect, it } from "vitest";
import { virtualGridWindow } from "./DataGridVirtual";

const offsets = Array.from({ length: 51 }, (_, index) => 56 + index * 180);

describe("DataGridVirtual window", () => {
  it("keeps a 50k by 50 grid bounded at a 360px viewport", () => {
    const window = virtualGridWindow(50_000, 50, offsets, {
      top: 20_000 * 32,
      left: 2_000,
      width: 360,
      height: 240,
    });
    const cellCount =
      (window.endRow - window.startRow) * window.visibleColumns.length;
    expect(window.startRow).toBeGreaterThan(0);
    expect(window.endRow).toBeLessThan(50_000);
    expect(window.visibleColumns.length).toBeLessThan(15);
    expect(cellCount).toBeLessThan(400);
  });

  it("includes the first and final keyboard-scrollable coordinates", () => {
    expect(
      virtualGridWindow(1_000, 50, offsets, {
        top: 0,
        left: 0,
        width: 360,
        height: 240,
      }).startRow,
    ).toBe(0);
    const final = virtualGridWindow(1_000, 50, offsets, {
      top: 999 * 32,
      left: 8_000,
      width: 360,
      height: 240,
    });
    expect(final.endRow).toBe(1_000);
    expect(final.visibleColumns[final.visibleColumns.length - 1]).toBe(49);
  });
});
