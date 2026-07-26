import { describe, expect, it } from "vitest";
import type { SqlOperationProposal } from "../../features/queries/domain";
import {
  canFallbackFromCombinedRead,
  initialSqlRunPath,
  proposalSqlRunPath,
} from "./runPath";

const proposal = (
  kind: "read" | "write" | "ddl",
  approvalRequired = false,
): SqlOperationProposal => ({
  operationId: "operation",
  payloadHash: "hash",
  state: "ready",
  approvalRequired,
  autoRun: !approvalRequired,
  confirmationPhrase: null,
  expiresAt: "2026-01-01T00:00:00Z",
  classification: {
    kind,
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
});

describe("SQL streaming execution paths", () => {
  it("uses one combined request only for auto-read mode", () => {
    expect(initialSqlRunPath(true)).toBe("combinedReadStream");
    expect(initialSqlRunPath(false)).toBe("plannedReadStream");
    expect(canFallbackFromCombinedRead("proposalRequired")).toBe(true);
    expect(canFallbackFromCombinedRead("blocked")).toBe(false);
    expect(canFallbackFromCombinedRead("db")).toBe(false);
  });

  it("keeps UPDATE and DDL on the exact ApprovalCard proposal path", () => {
    expect(proposalSqlRunPath(proposal("read"))).toBe("plannedReadStream");
    expect(proposalSqlRunPath(proposal("write"))).toBe("approval");
    expect(proposalSqlRunPath(proposal("ddl"))).toBe("approval");
    expect(proposalSqlRunPath(proposal("read", true))).toBe("approval");
  });
});
