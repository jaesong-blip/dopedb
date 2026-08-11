// GitHub does not redeliver every failed webhook automatically. This bounded
// reconciler periodically compares each tracked ref with the shared source and
// repairs a missing queue transition without asking workspace members to do it.
import "server-only";

import {
  GithubKnowledgeRequestError,
  resolveGithubCommit,
} from "./github-app";
import {
  listGithubKnowledgeReconciliationCandidates,
  reconcileGithubKnowledgeCommit,
  recordGithubKnowledgeReconciliationFailure,
} from "./sync-queue";

export type GithubKnowledgeReconciliationResult = {
  checked: number;
  advanced: number;
  unchanged: number;
  unavailable: number;
  deferred: number;
};

export async function reconcileGithubKnowledgeSources(
  limit = 10,
): Promise<GithubKnowledgeReconciliationResult> {
  const candidates = await listGithubKnowledgeReconciliationCandidates(limit);
  const result: GithubKnowledgeReconciliationResult = {
    checked: 0,
    advanced: 0,
    unchanged: 0,
    unavailable: 0,
    deferred: 0,
  };
  for (const candidate of candidates) {
    try {
      const observedCommitSha = await resolveGithubCommit(
        candidate.installationId,
        candidate.repositoryFullName,
        candidate.refName,
      );
      await reconcileGithubKnowledgeCommit({
        organizationId: candidate.organizationId,
        sourceId: candidate.sourceId,
        observedCommitSha,
      });
      result.checked += 1;
      if (observedCommitSha === candidate.commitSha) result.unchanged += 1;
      else result.advanced += 1;
    } catch (error) {
      const unavailable = error instanceof GithubKnowledgeRequestError && error.status === 404;
      await recordGithubKnowledgeReconciliationFailure({
        organizationId: candidate.organizationId,
        sourceId: candidate.sourceId,
        refMissing: unavailable,
      });
      result.checked += 1;
      if (unavailable) result.unavailable += 1;
      else result.deferred += 1;
    }
  }
  return result;
}
