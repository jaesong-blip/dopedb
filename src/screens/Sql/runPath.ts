// Pure execution branching: backend classification remains authoritative, while
// the screen decides only whether a read can use combined or planned streaming.
import type { SqlOperationProposal } from "../../features/queries/domain";

export type SqlRunPath =
  | "combinedReadStream"
  | "plannedReadStream"
  | "approval";

export function initialSqlRunPath(autoRunReads: boolean): SqlRunPath {
  return autoRunReads ? "combinedReadStream" : "plannedReadStream";
}

export function proposalSqlRunPath(proposal: SqlOperationProposal): SqlRunPath {
  return proposal.approvalRequired || proposal.classification.kind !== "read"
    ? "approval"
    : "plannedReadStream";
}

/** Only a typed pre-target proposal signal may enter the separate proposal flow. */
export function canFallbackFromCombinedRead(errorKind: string | null): boolean {
  return errorKind === "proposalRequired";
}
