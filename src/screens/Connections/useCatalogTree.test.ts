import { describe, expect, it } from "vitest";
import { shouldLoadCatalogDetails } from "./useCatalogTree";

describe("workspace catalog tree lifecycle", () => {
  it("never starts full metadata from relation expansion alone", () => {
    expect(shouldLoadCatalogDetails(true, true, false)).toBe(false);
  });

  it("starts details only after scope, overview, and explicit intent are ready", () => {
    expect(shouldLoadCatalogDetails(false, true, true)).toBe(false);
    expect(shouldLoadCatalogDetails(true, false, true)).toBe(false);
    expect(shouldLoadCatalogDetails(true, true, true)).toBe(true);
  });
});
