import { describe, expect, it } from "vitest";

import {
  initialProviderAccessState,
  providerAccessReducer,
} from "./state";

describe("providerAccessReducer", () => {
  it("owns functional selection updates without a second writer", () => {
    const selected = providerAccessReducer(initialProviderAccessState, {
      type: "field",
      key: "selectedConnectionId",
      update: (current) => current || "connection-1",
    });

    expect(selected.selectedConnectionId).toBe("connection-1");
    expect(selected.providers).toBe(initialProviderAccessState.providers);
  });

  it("keeps resource discovery and mutation status independent", () => {
    const discovered = providerAccessReducer(initialProviderAccessState, {
      type: "field",
      key: "resourceOptions",
      update: {
        database: [
          {
            id: "db-1",
            name: "app",
            value: "app",
            production: false,
            ready: true,
          },
        ],
      },
    });
    const pending = providerAccessReducer(discovered, {
      type: "field",
      key: "mutation",
      update: "import:integration-1",
    });

    expect(pending.resourceOptions.database).toHaveLength(1);
    expect(pending.mutation).toBe("import:integration-1");
  });
});
