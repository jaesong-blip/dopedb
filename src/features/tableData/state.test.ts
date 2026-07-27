import { describe, expect, it } from "vitest";

import { initialTableDataState, tableDataReducer } from "./state";

describe("tableDataReducer", () => {
  it("resets every table-owned interaction when the relation changes", () => {
    const dirty = {
      ...initialTableDataState("public.users"),
      page: 4,
      filters: { email: "example.com" },
      staged: [{ id: "write-1", sql: "UPDATE users SET active = true" }],
      reviewing: true,
      jobsOpen: true,
    };

    expect(
      tableDataReducer(dirty, {
        type: "reset",
        viewKey: "public.accounts",
      }),
    ).toEqual(initialTableDataState("public.accounts"));
  });

  it("settles filters and paging in one reducer transition", () => {
    const filtered = tableDataReducer(initialTableDataState("users"), {
      type: "filter",
      column: "email",
      value: "@example.com",
    });
    const paged = {
      ...filtered,
      page: 7,
    };

    expect(
      tableDataReducer(paged, { type: "settleFilters" }),
    ).toMatchObject({
      page: 0,
      filters: { email: "@example.com" },
      appliedFilters: { email: "@example.com" },
    });
  });

  it("owns the complete staged-write lifecycle", () => {
    const staged = tableDataReducer(initialTableDataState("users"), {
      type: "stage",
      write: { id: "write-1", sql: "DELETE FROM users WHERE id = 1" },
    });

    expect(staged.staged).toHaveLength(1);
    expect(
      tableDataReducer(staged, { type: "removeStaged", id: "write-1" })
        .staged,
    ).toEqual([]);
  });
});
