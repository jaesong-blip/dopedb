import type { KnowledgeEnvironment, KnowledgeRevision } from "./domain";

export function knowledgeRevisionLabel(revision: KnowledgeRevision): string {
  if (revision.kind === "github") {
    return `${revision.refName} · ${revision.commitSha.slice(0, 8)}`;
  }
  if (revision.kind === "local_git") {
    return `${revision.refName} · ${revision.commitSha.slice(0, 8)}${revision.dirty ? " · dirty" : ""}`;
  }
  return `Snapshot ${revision.snapshotSha256.slice(0, 8)}`;
}

export function knowledgeEnvironmentBadge(
  riskClass: KnowledgeEnvironment["riskClass"],
): string {
  if (riskClass === "production") return "prod";
  if (riskClass === "development") return "dev";
  return riskClass;
}
