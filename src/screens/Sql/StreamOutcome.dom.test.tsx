// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import {
  appendSqlStreamRows,
  emptySqlStreamView,
  type SqlStreamPhase,
} from "../../features/queries/domain";
import { I18nProvider } from "../../lib/i18n";
import StreamOutcome from "./StreamOutcome";

let root: ReturnType<typeof createRoot> | null = null;

afterEach(() => {
  root?.unmount();
  root = null;
  document.body.replaceChildren();
});

function streamFor(phase: SqlStreamPhase) {
  const empty = emptySqlStreamView(1);
  return {
    ...empty,
    phase,
    operationId: "operation-1",
    columns: ["id"],
    rowSource: appendSqlStreamRows(empty.rowSource, [[1]]),
    rowCount: 1,
  };
}

describe("StreamOutcome export gating", () => {
  it.each([
    "idle",
    "connecting",
    "streaming",
    "cancelled",
    "error",
    "outcome_unknown",
  ] as const)("disables every export for a %s partial result", async (phase) => {
    const container = document.body.appendChild(document.createElement("div"));
    root = createRoot(container);
    await act(async () =>
      root?.render(
        <I18nProvider>
          <StreamOutcome stream={streamFor(phase)} sql="SELECT 1" maxRows={500} />
        </I18nProvider>,
      ),
    );
    const buttons = [...container.querySelectorAll(".result-tools button")];
    expect(buttons).toHaveLength(3);
    expect(buttons.every((button) => button.hasAttribute("disabled"))).toBe(true);
    expect(container.textContent).toContain("Partial result — export unavailable");
  });

  it("enables exports only for a complete result", async () => {
    const container = document.body.appendChild(document.createElement("div"));
    root = createRoot(container);
    await act(async () =>
      root?.render(
        <I18nProvider>
          <StreamOutcome
            stream={streamFor("complete")}
            sql="SELECT 1"
            maxRows={500}
          />
        </I18nProvider>,
      ),
    );
    const buttons = [...container.querySelectorAll(".result-tools button")];
    expect(buttons.every((button) => button.hasAttribute("disabled"))).toBe(false);
    expect(container.textContent).not.toContain(
      "Partial result — export unavailable",
    );
  });
});
