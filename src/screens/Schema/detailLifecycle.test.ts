import { describe, expect, it } from "vitest";
import { schemaDetailsEnabled } from "./detailLifecycle";

describe("schema detail lifecycle", () => {
  it("keeps connection selection on the bounded overview path", () => {
    expect(schemaDetailsEnabled(false, true)).toBe(false);
  });

  it("loads full metadata only after explicit intent in a ready scope", () => {
    expect(schemaDetailsEnabled(true, false)).toBe(false);
    expect(schemaDetailsEnabled(true, true)).toBe(true);
  });
});
