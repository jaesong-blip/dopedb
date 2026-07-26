import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";

import type { ExecOutcome } from "../../ipc/types";
import type { SqlOperationProposal } from "./domain";
import { inspectSql, proposeSql, runSqlRead } from "./tauriAdapter";

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
});
