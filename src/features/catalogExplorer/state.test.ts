import { describe, expect, it } from "vitest";

import {
  catalogExplorerReducer,
  initialCatalogExplorerState,
} from "./state";

describe("catalogExplorerReducer", () => {
  it("drops account-scoped navigation state as one transition", () => {
    const open = catalogExplorerReducer(
      initialCatalogExplorerState("account-a"),
      { type: "openConnection", id: "connection-a" },
    );
    const filtered = catalogExplorerReducer(open, {
      type: "filter",
      id: "connection-a",
      value: "users",
    });

    expect(
      catalogExplorerReducer(filtered, {
        type: "scopeChanged",
        scopeKey: "account-b",
      }),
    ).toEqual(initialCatalogExplorerState("account-b"));
  });

  it("keeps independent connection and object-section expansion", () => {
    const connectionOpen = catalogExplorerReducer(
      initialCatalogExplorerState("local"),
      { type: "toggleConnection", id: "connection-a" },
    );
    const objectOpen = catalogExplorerReducer(connectionOpen, {
      type: "toggleObjectSection",
      key: "connection-a:function",
    });

    expect([...objectOpen.openConnections]).toEqual(["connection-a"]);
    expect([...objectOpen.objectSectionsOpen]).toEqual([
      "connection-a:function",
    ]);
  });
});
