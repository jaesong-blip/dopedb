// @vitest-environment happy-dom
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  SqlStreamBatch,
  SqlStreamController,
  SqlStreamReceipt,
} from "../../features/queries/domain";
import { useSqlResultStream } from "../../features/queries/useSqlResultStream";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;

afterEach(() => {
  root?.unmount();
  root = null;
  document.body.replaceChildren();
  performance.clearMarks();
  performance.clearMeasures();
});

describe("useSqlResultStream", () => {
  it("commits an accepted chunk before resolving the transport callback and cancels pre-ready unmount", async () => {
    let api: ReturnType<typeof useSqlResultStream> | undefined;
    let onBatch: ((batch: SqlStreamBatch) => Promise<void>) | undefined;
    const cancel = vi.fn().mockResolvedValue(undefined);
    let resolveCompletion:
      | ((value: {
          operationId: string;
          rowCount: number;
          truncated: boolean;
          durationMs: number;
        }) => void)
      | undefined;
    const controller: SqlStreamController = {
      completion: new Promise((resolve) => {
        resolveCompletion = resolve;
      }),
      cancel,
    };
    function Harness() {
      api = useSqlResultStream("workspace:connection");
      return (
        <output
          data-phase={api.stream.phase}
          data-rows={api.stream.rowSource.rowCount}
        />
      );
    }
    const container = document.body.appendChild(document.createElement("div"));
    root = createRoot(container);
    await act(async () => root?.render(<Harness />));
    let running: Promise<void> | undefined;
    await act(async () => {
      running = api!.start((handler) => {
        onBatch = handler;
        return controller;
      });
    });
    await act(async () => {
      await Promise.resolve();
    });
    performance.mark("desktop_query_interaction_start");
    performance.mark("desktop_query_stream_first_batch_received");
    const accepted = onBatch!({
      operationId: "operation",
      sequence: 0,
      columns: ["id"],
      rows: [[1]],
    });
    await act(async () => {});
    await accepted;
    expect(container.querySelector("output")?.dataset.rows).toBe("1");
    expect(
      performance.getEntriesByName(
        "desktop_query_interaction_to_first_batch",
      ),
    ).toHaveLength(1);
    expect(
      performance.getEntriesByName(
        "desktop_query_interaction_to_react_interactive",
      ),
    ).toHaveLength(1);
    await act(async () => root?.unmount());
    expect(cancel).toHaveBeenCalledTimes(1);
    resolveCompletion?.({
      operationId: "operation",
      rowCount: 1,
      truncated: false,
      durationMs: 1,
    });
    await running;
  });

  it("does not construct a controller after unmounting before the connecting commit", async () => {
    let api: ReturnType<typeof useSqlResultStream> | undefined;
    const factory = vi.fn();
    function Harness() {
      api = useSqlResultStream("workspace:connection");
      return null;
    }
    const container = document.body.appendChild(document.createElement("div"));
    root = createRoot(container);
    await act(async () => root?.render(<Harness />));
    const running = api!.start(factory);
    root.unmount();
    await expect(running).rejects.toThrow("no longer active");
    expect(factory).not.toHaveBeenCalled();
  });

  it("cancels the connecting owner before registering a replacement", async () => {
    let api: ReturnType<typeof useSqlResultStream> | undefined;
    const firstCancel = vi.fn().mockResolvedValue(undefined);
    const secondCancel = vi.fn().mockResolvedValue(undefined);
    const pending = () => new Promise<SqlStreamReceipt>(() => undefined);
    function Harness() {
      api = useSqlResultStream("workspace:connection");
      return null;
    }
    const container = document.body.appendChild(document.createElement("div"));
    root = createRoot(container);
    await act(async () => root?.render(<Harness />));
    const first = api!.start(() => ({ completion: pending(), cancel: firstCancel }));
    await act(async () => {});
    const second = api!.start(() => ({ completion: pending(), cancel: secondCancel }));
    await act(async () => {});
    await expect(first).resolves.toBeUndefined();
    expect(firstCancel).toHaveBeenCalledOnce();
    await api!.cancel();
    await expect(second).resolves.toBeUndefined();
    expect(secondCancel).toHaveBeenCalledOnce();
  });

  it("keeps StrictMode setup from creating a stale stream controller", async () => {
    let api: ReturnType<typeof useSqlResultStream> | undefined;
    const cancel = vi.fn().mockResolvedValue(undefined);
    const factory = vi.fn(() => ({
      completion: Promise.resolve({
        operationId: "operation",
        rowCount: 0,
        truncated: false,
        durationMs: 1,
      }),
      cancel,
    }));
    function Harness() {
      api = useSqlResultStream("workspace:connection");
      return null;
    }
    const container = document.body.appendChild(document.createElement("div"));
    root = createRoot(container);
    await act(async () =>
      root?.render(
        <StrictMode>
          <Harness />
        </StrictMode>,
      ),
    );
    await api!.start(factory);
    expect(factory).toHaveBeenCalledOnce();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("completes a batchless zero-row receipt from connecting", async () => {
    let api: ReturnType<typeof useSqlResultStream> | undefined;
    function Harness() {
      api = useSqlResultStream("workspace:connection");
      return <output data-phase={api.stream.phase} data-rows={api.stream.rowCount} />;
    }
    const container = document.body.appendChild(document.createElement("div"));
    root = createRoot(container);
    await act(async () => root?.render(<Harness />));
    let running: Promise<void> | undefined;
    await act(async () => {
      running = api!.start(() => ({
        completion: Promise.resolve({
          operationId: "operation-empty",
          rowCount: 0,
          truncated: false,
          durationMs: 1,
        }),
        cancel: vi.fn().mockResolvedValue(undefined),
      }));
    });
    await act(async () => {});
    await running;
    expect(container.querySelector("output")?.dataset.phase).toBe("complete");
    expect(container.querySelector("output")?.dataset.rows).toBe("0");
  });

  it("moves a synchronous factory failure to error and permits the next run", async () => {
    let api: ReturnType<typeof useSqlResultStream> | undefined;
    function Harness() {
      api = useSqlResultStream("workspace:connection");
      return <output data-phase={api.stream.phase} />;
    }
    const container = document.body.appendChild(document.createElement("div"));
    root = createRoot(container);
    await act(async () => root?.render(<Harness />));

    let failed: Promise<void> | undefined;
    await act(async () => {
      failed = api!.start(() => {
        throw new Error("factory construction failed");
      });
      void failed.catch(() => undefined);
    });
    await act(async () => {});
    await expect(failed).rejects.toThrow("factory construction failed");
    expect(container.querySelector("output")?.dataset.phase).toBe("error");

    let recovered: Promise<void> | undefined;
    await act(async () => {
      recovered = api!.start(() => ({
        completion: Promise.resolve({
          operationId: "operation-recovered",
          rowCount: 0,
          truncated: false,
          durationMs: 1,
        }),
        cancel: vi.fn().mockResolvedValue(undefined),
      }));
    });
    await act(async () => {});
    await recovered;
    expect(container.querySelector("output")?.dataset.phase).toBe("complete");
  });

  it("settles a pending batch acknowledgement on unmount without cross-run flushing", async () => {
    let api: ReturnType<typeof useSqlResultStream> | undefined;
    let onBatch: ((batch: SqlStreamBatch) => Promise<void>) | undefined;
    const cancel = vi.fn().mockResolvedValue(undefined);
    function Harness() {
      api = useSqlResultStream("workspace:connection");
      return null;
    }
    const container = document.body.appendChild(document.createElement("div"));
    root = createRoot(container);
    await act(async () => root?.render(<Harness />));
    void api!.start((handler) => {
      onBatch = handler;
      return { completion: new Promise<SqlStreamReceipt>(() => undefined), cancel };
    });
    await act(async () => {});
    const acknowledgement = onBatch!({
      operationId: "operation",
      sequence: 0,
      columns: ["id"],
      rows: [[1]],
    });
    root.unmount();
    await expect(acknowledgement).rejects.toThrow("no longer active");
    expect(cancel).toHaveBeenCalledOnce();
  });
});
