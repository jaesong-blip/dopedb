import { describe, expect, it } from "vitest";

import { resolvePtyTheme } from "./ptyTheme";

describe("resolvePtyTheme", () => {
  it("maps every xterm color to a canonical design token", () => {
    const requested: string[] = [];
    const theme = resolvePtyTheme({
      getPropertyValue(property) {
        requested.push(property);
        return ` value-for-${property} `;
      },
    });

    expect(theme.background).toBe("value-for---ds-background");
    expect(theme.selectionBackground).toBe("value-for---ds-selection");
    expect(theme.black).toBe("value-for---ds-terminal-ansi-black");
    expect(theme.brightWhite).toBe(
      "value-for---ds-terminal-ansi-bright-white",
    );
    expect(requested).toHaveLength(21);
    expect(new Set(requested).size).toBe(19);
  });

  it("lets xterm use its own fallback when a token is unavailable", () => {
    expect(
      resolvePtyTheme({ getPropertyValue: () => "" }).background,
    ).toBeUndefined();
  });
});
