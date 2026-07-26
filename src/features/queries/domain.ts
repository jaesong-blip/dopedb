// Query-only wire contracts. Shared operation and result shapes stay in ipc/types so other
// feature slices can use them without importing this SQL proposal boundary.

import type { OperationState, QueryKind } from "../../ipc/types";

export type RiskLevel = "low" | "medium" | "high";

export interface Classification {
  kind: QueryKind;
  risk: RiskLevel;
  statementCount: number;
  noWhere: boolean;
  tables: string[];
  notes: string[];
  /** True only for a single cleanly-parsed write the L3 exec+ROLLBACK preview can undo. */
  rollbackSafe: boolean;
}

export type PreviewMode = "explain" | "execRollback" | "skipped";

export interface PreviewReport {
  mode: PreviewMode;
  estimatedRows: number | null;
  exactRows: number | null;
  plan: string | null;
  note: string | null;
}

/** Exact SQL operation projection; SQL itself remains only in the proposal request. */
export interface SqlOperationProposal {
  operationId: string;
  payloadHash: string;
  state: OperationState;
  approvalRequired: boolean;
  autoRun: boolean;
  confirmationPhrase: string | null;
  expiresAt: string;
  classification: Classification;
  preview: PreviewReport;
}
