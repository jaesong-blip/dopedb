import { describe, expect, it } from "vitest";

import { defineCatalog } from "./types";

describe("catalogue type contract", () => {
  it("requires an exact Korean key set for each English source", () => {
    const matching = defineCatalog(
      { "test.one": "one" },
      { "test.one": "하나" },
    );
    expect(matching.ko["test.one"]).toBe("하나");

    // @ts-expect-error Korean cannot omit an English source key.
    defineCatalog({ "test.one": "one" }, {});
    // @ts-expect-error Korean cannot introduce a key its English source does not own.
    defineCatalog({ "test.one": "one" }, { "test.one": "하나", "test.two": "둘" });
  });
});
