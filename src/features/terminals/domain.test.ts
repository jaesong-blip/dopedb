import { describe, expect, it } from "vitest";

import { skillSetupCommandDraft } from "./domain";

describe("skillSetupCommandDraft", () => {
  it("accepts a visible single-line command", () => {
    expect(
      skillSetupCommandDraft("dopedb skill install --target all"),
    ).toBe("dopedb skill install --target all");
  });

  it.each(["\r", "\n", "\r\n", "\0", "\u001b", "\t", "\u0085"])(
    "rejects an execution control suffix %j",
    (suffix) => {
      expect(() =>
        skillSetupCommandDraft(
          `dopedb skill install --target codex${suffix}`,
        ),
      ).toThrow(/control character/);
    },
  );
});
