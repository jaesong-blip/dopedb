import { describe, expect, it } from "vitest";
import { placeFloatingMenu } from "./floatingMenu";

describe("placeFloatingMenu", () => {
  it("aligns the menu end below the trigger when there is room", () => {
    expect(
      placeFloatingMenu(
        { top: 40, right: 300, bottom: 72, left: 268, width: 32, height: 32 },
        { width: 176, height: 160 },
        { width: 800, height: 600 },
      ),
    ).toEqual({
      left: 124,
      top: 78,
      placement: "bottom",
      maxHeight: 514,
    });
  });

  it("clamps a menu inside the viewport gutter", () => {
    expect(
      placeFloatingMenu(
        { top: 40, right: 44, bottom: 72, left: 12, width: 32, height: 32 },
        { width: 176, height: 160 },
        { width: 320, height: 480 },
      ),
    ).toEqual({
      left: 8,
      top: 78,
      placement: "bottom",
      maxHeight: 394,
    });
  });

  it("flips above a low trigger and still clamps to the viewport", () => {
    expect(
      placeFloatingMenu(
        { top: 548, right: 792, bottom: 580, left: 760, width: 32, height: 32 },
        { width: 176, height: 220 },
        { width: 800, height: 600 },
      ),
    ).toEqual({
      left: 616,
      top: 322,
      placement: "top",
      maxHeight: 534,
    });
  });

  it("scrolls an oversized menu below the trigger instead of covering it", () => {
    expect(
      placeFloatingMenu(
        { top: 12, right: 300, bottom: 44, left: 268, width: 32, height: 32 },
        { width: 280, height: 700 },
        { width: 320, height: 480 },
      ),
    ).toEqual({
      left: 20,
      top: 50,
      placement: "bottom",
      maxHeight: 422,
    });
  });
});
