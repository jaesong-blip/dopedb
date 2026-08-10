// Pure execution branching: backend classification remains authoritative, while
// the screen decides only whether a read can use combined or planned streaming.
import type { SqlOperationProposal } from "../../features/queries/domain";

export type SqlRunPath =
  | "combinedReadStream"
  | "plannedReadStream"
  | "approval";

function combinedReadCandidate(sql: string): boolean {
  const compact = sql
    .replace(/^\s*(?:(?:--[^\n]*(?:\n|$))|(?:\/\*[\s\S]*?\*\/\s*))*/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // This hint only chooses which backend command performs the authoritative
  // classification. Keep it deliberately narrow: ambiguous statements enter
  // the explicit proposal path, while ordinary SELECTs retain the one-IPC
  // fast path. SELECT INTO and locking SELECTs are writes in the backend.
  return (
    /^select\b/i.test(compact) &&
    !/\binto\b/i.test(compact) &&
    !/\bfor\s+(?:(?:no\s+)?key\s+)?(?:update|share)\b/i.test(compact)
  );
}

export function initialSqlRunPath(
  autoRunReads: boolean,
  sql: string,
): SqlRunPath {
  return autoRunReads && combinedReadCandidate(sql)
    ? "combinedReadStream"
    : "plannedReadStream";
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
