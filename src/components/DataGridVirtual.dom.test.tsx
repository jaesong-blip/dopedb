// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../lib/i18n";
import DataGrid from "./DataGrid";
import DataGridVirtual from "./DataGridVirtual";

const roots: Array<{ unmount(): void }> = [];

afterEach(() => {
  for (const root of roots.splice(0)) root.unmount();
  document.body.replaceChildren();
});

describe("DataGridVirtual DOM", () => {
  it("commits a bounded DOM window for a 50k × 50 result", async () => {
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    roots.push(root);
    const result = {
      columns: Array.from({ length: 50 }, (_, index) => `c${index}`),
      rows: Array.from({ length: 50_000 }, (_, row) =>
        Array.from({ length: 50 }, (_, column) => `${row}:${column}`),
      ),
      rowCount: 50_000,
      truncated: false,
      durationMs: 1,
    };
    await act(async () =>
      root.render(
        <I18nProvider>
          <DataGridVirtual result={result} startIndex={0} />
        </I18nProvider>,
      ),
    );
    expect(container.querySelectorAll('[role="gridcell"]').length).toBeLessThan(
      400,
    );
    expect(
      container.querySelector('[role="grid"]')?.getAttribute("aria-rowcount"),
    ).toBe("50001");
    expect(
      container.querySelector('[role="grid"]')?.getAttribute("aria-colcount"),
    ).toBe("51");
    expect(container.querySelector('[role="row"]')?.getAttribute("aria-rowindex")).toBe("1");
    expect(
      container.querySelector('[role="columnheader"]')?.getAttribute("aria-colindex"),
    ).toBe("1");
    expect(
      container.querySelector('[role="gridcell"]')?.getAttribute("aria-colindex"),
    ).toBe("2");
    expect(
      container.querySelector('[role="gridcell"]')?.closest('[role="row"]')?.getAttribute("aria-rowindex"),
    ).toBe("2");
  });

  it("keeps keyboard selection and header sorting accessible", async () => {
    const onCellClick = vi.fn();
    const onSort = vi.fn();
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    roots.push(root);
    const result = {
      columns: ["id", "name"],
      rows: [
        [1, "a"],
        [2, "b"],
      ],
      rowCount: 2,
      truncated: false,
      durationMs: 1,
    };
    await act(async () =>
      root.render(
        <I18nProvider>
          <DataGridVirtual
            result={result}
            startIndex={0}
            onCellClick={onCellClick}
            onSort={onSort}
          />
        </I18nProvider>,
      ),
    );
    const grid = container.querySelector('[role="grid"]') as HTMLElement;
    await act(async () =>
      grid.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      ),
    );
    expect(onCellClick).not.toHaveBeenCalled();
    await act(async () =>
      grid.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
    );
    expect(onCellClick).toHaveBeenCalledWith(1, 0, "id");
    const header = container.querySelector(
      '[role="columnheader"][tabindex="0"]',
    ) as HTMLElement;
    await act(async () =>
      header.dispatchEvent(
        new KeyboardEvent("keydown", { key: " ", bubbles: true }),
      ),
    );
    expect(onSort).toHaveBeenCalledWith("id");
  });

  it("does not expose sort semantics for a non-sortable header", async () => {
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    roots.push(root);
    await act(async () =>
      root.render(
        <I18nProvider>
          <DataGridVirtual
            result={{
              columns: ["id"],
              rows: [[1]],
              rowCount: 1,
              truncated: false,
              durationMs: 1,
            }}
            startIndex={0}
          />
        </I18nProvider>,
      ),
    );
    const header = container.querySelectorAll('[role="columnheader"]')[1];
    expect(header?.hasAttribute("aria-sort")).toBe(false);
    expect(header?.getAttribute("tabindex")).toBeNull();
  });

  it("keeps resize double-click out of header sorting", async () => {
    const onSort = vi.fn();
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    roots.push(root);
    await act(async () =>
      root.render(
        <I18nProvider>
          <DataGridVirtual
            result={{
              columns: ["id"],
              rows: [[1]],
              rowCount: 1,
              truncated: false,
              durationMs: 1,
            }}
            startIndex={0}
            onSort={onSort}
          />
        </I18nProvider>,
      ),
    );
    const handle = container.querySelector(".col-resizer") as HTMLElement;
    await act(async () =>
      handle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })),
    );
    expect(onSort).not.toHaveBeenCalled();
  });

  it("does not scan 50k × 50 cells in the DataGrid virtual wrapper", async () => {
    const rows = new Proxy(
      Array.from({ length: 50_000 }, (_, row) =>
        Array.from({ length: 50 }, (_, column) => `${row}:${column}`),
      ),
      {
        get(target, property, receiver) {
          if (property === "some" || property === "every")
            throw new Error("table-only numeric scan ran in virtual wrapper");
          return Reflect.get(target, property, receiver);
        },
      },
    );
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    roots.push(root);
    await act(async () =>
      root.render(
        <I18nProvider>
          <DataGrid
            result={{
              columns: Array.from({ length: 50 }, (_, index) => `c${index}`),
              rows,
              rowCount: 50_000,
              truncated: false,
              durationMs: 1,
            }}
          />
        </I18nProvider>,
      ),
    );
    expect(container.querySelector('[role="grid"]')).not.toBeNull();
  });
});
