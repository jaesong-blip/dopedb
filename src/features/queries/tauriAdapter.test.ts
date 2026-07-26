import { beforeEach, describe, expect, it, vi } from "vitest";

const channels: Array<{ onmessage: ((value: unknown) => void) | null }> = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage: ((value: unknown) => void) | null = null;

    constructor() {
      channels.push(this);
    }
  },
}));

import { invoke } from "@tauri-apps/api/core";

import type { ExecOutcome } from "../../ipc/types";
import type { SqlOperationProposal } from "./domain";
import {
  inspectSql,
  proposeSql,
  runSqlRead,
  runSqlReadStream,
  runSqlStream,
} from "./tauriAdapter";

const invokeMock = vi.mocked(invoke);

const readProposal: SqlOperationProposal = {
  operationId: "operation-1",
  payloadHash: "payload-hash",
  state: "ready",
  approvalRequired: false,
  autoRun: true,
  confirmationPhrase: null,
  expiresAt: "2026-01-01T00:00:00Z",
  classification: {
    kind: "read",
    risk: "low",
    statementCount: 1,
    noWhere: false,
    tables: [],
    notes: [],
    rollbackSafe: false,
  },
  preview: {
    mode: "explain",
    estimatedRows: null,
    exactRows: null,
    plan: null,
    note: null,
  },
};

describe("query Tauri adapter", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    channels.length = 0;
  });

  it("uses one backend-owned inspection command instead of a classify-preview race", async () => {
    invokeMock.mockResolvedValueOnce({
      classification: readProposal.classification,
      report: readProposal.preview,
    });

    await expect(inspectSql("connection-1", "SELECT 1")).resolves.toEqual({
      classification: readProposal.classification,
      report: readProposal.preview,
    });
    expect(invokeMock).toHaveBeenCalledWith("inspect_sql", {
      id: "connection-1",
      sql: "SELECT 1",
    });
  });

  it("preserves the propose SQL command and camelCase wire shape", async () => {
    invokeMock.mockResolvedValueOnce(readProposal);

    await proposeSql("connection-1", "SELECT 1");

    expect(invokeMock).toHaveBeenCalledWith("propose_sql", {
      id: "connection-1",
      sql: "SELECT 1",
      origin: null,
    });
  });

  it("runs only a proposal that is both read-only and approval-free", async () => {
    const outcome: ExecOutcome = { result: null, affected: null, committed: false };
    invokeMock.mockResolvedValueOnce(readProposal).mockResolvedValueOnce(outcome);

    await expect(runSqlRead("connection-1", "SELECT 1", "data-view")).resolves.toBe(
      outcome,
    );
    expect(invokeMock).toHaveBeenNthCalledWith(1, "propose_sql", {
      id: "connection-1",
      sql: "SELECT 1",
      origin: "data-view",
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "run_sql", {
      operationId: "operation-1",
    });
  });

  it("rejects a target-mutating proposal before run_sql", async () => {
    invokeMock.mockResolvedValueOnce({
      ...readProposal,
      classification: { ...readProposal.classification, kind: "write" },
    });

    await expect(runSqlRead("connection-1", "UPDATE users SET role = 'admin'")).rejects.toThrow(
      "read execution helper rejected a target-mutating proposal",
    );
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("streams an existing read proposal through one bounded-channel command", async () => {
    invokeMock.mockImplementation((command) => {
      if (command === "pull_sql_stream_batch") {
        return Promise.resolve({ operationId: "operation-1", sequence: 0, columns: ["id"], rows: [[1]] });
      }
      if (command === "run_sql_stream") {
        return Promise.resolve({ operationId: "operation-1", rowCount: 3, truncated: false, durationMs: 7 });
      }
      return Promise.resolve(true);
    });
    const batches: unknown[] = [];

    const controller = runSqlStream("operation-1", (batch) => { batches.push(batch); });
    await expect(controller.completion).resolves.toMatchObject({
      operationId: "operation-1",
      rowCount: 3,
    });
    expect(invokeMock).toHaveBeenCalledWith("run_sql_stream", {
      operationId: "operation-1",
      capability: expect.stringMatching(/^[0-9a-f]{64}$/),
      onRows: channels[0],
    });
    const capability = (invokeMock.mock.calls[0]?.[1] as { capability: string }).capability;
    channels[0]?.onmessage?.({
      operationId: "operation-1",
      sequence: 0,
      capability,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(batches).toEqual([
      { operationId: "operation-1", sequence: 0, columns: ["id"], rows: [[1]] },
    ]);
    expect(invokeMock).toHaveBeenLastCalledWith("ack_sql_stream", {
      operationId: "operation-1",
      sequence: 0,
      capability,
    });
  });

  it("atomically plans and streams an auto-run read in one IPC request", async () => {
    invokeMock.mockResolvedValueOnce({
      operationId: "operation-1",
      rowCount: 1,
      truncated: false,
      durationMs: 4,
    });
    const onBatch = vi.fn();

    const controller = runSqlReadStream("connection-1", "SELECT 1", onBatch, "data-view");
    await controller.completion;

    expect(invokeMock).toHaveBeenCalledOnce();
    expect(invokeMock).toHaveBeenCalledWith("run_sql_read_stream", {
      id: "connection-1",
      sql: "SELECT 1",
      origin: "data-view",
      capability: expect.stringMatching(/^[0-9a-f]{64}$/),
      onRows: channels[0],
    });
    await controller.cancel();
    expect(invokeMock).toHaveBeenLastCalledWith("cancel_sql_stream", {
      operationId: null,
      capability: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it("cancels the exact stream instead of ACKing when the consumer rejects a batch", async () => {
    invokeMock.mockImplementation((command) => {
      if (command === "pull_sql_stream_batch") {
        return Promise.resolve({ operationId: "operation-1", sequence: 0, columns: ["id"], rows: [[1]] });
      }
      if (command === "run_sql_stream") {
        return Promise.resolve({ operationId: "operation-1", rowCount: 1, truncated: false, durationMs: 4 });
      }
      return Promise.resolve(true);
    });
    const controller = runSqlStream("operation-1", () => {
      throw new Error("grid reducer rejected batch");
    });
    await controller.completion;

    const capability = (invokeMock.mock.calls[0]?.[1] as { capability: string }).capability;
    channels[0]?.onmessage?.({
      operationId: "operation-1",
      sequence: 0,
      capability,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(invokeMock).toHaveBeenLastCalledWith("cancel_sql_stream", {
      operationId: "operation-1",
      capability,
    });
    expect(invokeMock).not.toHaveBeenCalledWith("ack_sql_stream", expect.anything());
  });

  it("returns a pre-ready controller and never ACKs an async consumer after cancellation", async () => {
    let resolveBatch: (() => void) | undefined;
    invokeMock.mockImplementation((command) => {
      if (command === "pull_sql_stream_batch") {
        return Promise.resolve({ operationId: "operation-1", sequence: 0, columns: ["id"], rows: [[1]] });
      }
      if (command === "run_sql_stream") return Promise.resolve({ operationId: "operation-1", rowCount: 1, truncated: false, durationMs: 1 });
      return Promise.resolve(true);
    });
    const controller = runSqlStream("operation-1", async () => {
      await new Promise<void>((resolve) => { resolveBatch = resolve; });
    });
    await controller.cancel();
    channels[0]?.onmessage?.({ operationId: "operation-1", sequence: 0, capability: "c".repeat(64) });
    resolveBatch?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(invokeMock).not.toHaveBeenCalledWith("ack_sql_stream", expect.anything());
  });

  it("retries an auto-read cancellation with the operation revealed by its first ready event", async () => {
    invokeMock.mockResolvedValue(true);
    const controller = runSqlReadStream("connection-1", "SELECT 1", () => {});
    await controller.cancel();
    const capability = (invokeMock.mock.calls[0]?.[1] as { capability: string }).capability;
    channels[0]?.onmessage?.({ operationId: "operation-1", sequence: 0, capability });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(invokeMock).toHaveBeenLastCalledWith("cancel_sql_stream", {
      operationId: "operation-1",
      capability,
    });
    expect(invokeMock).not.toHaveBeenCalledWith("ack_sql_stream", expect.anything());
  });
});
