import { describe, expect, it } from "vitest";

import { jobRelationRef } from "./domain";

describe("job relation boundary", () => {
  it("preserves canonical relation identities", () => {
    expect(
      jobRelationRef({
        catalog: "app",
        namespace: "public",
        name: "users",
        kind: "table",
        nativeId: "42",
      }),
    ).toEqual({
      catalog: "app",
      namespace: "public",
      name: "users",
      kind: "table",
      nativeId: "42",
    });
  });

  it("rejects catalog-only object kinds before invoking Tauri", () => {
    expect(() =>
      jobRelationRef({
        catalog: null,
        namespace: "public",
        name: "users_email_idx",
        kind: "index",
        nativeId: null,
      }),
    ).toThrow("not a supported job relation");
  });
});
