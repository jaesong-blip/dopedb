import "server-only";

import { randomUUID } from "node:crypto";

import { neonSql } from "../db";
import {
  analyzeCodeFile,
  buildCodeIndexArtifactFragment,
  codeIndexGraphRevisionId,
  codeIndexSourceRevisionSha256,
  compareCodeIndexPath,
  codeIndexManifestWindow,
  codeIndexPhaseHasStartBudget,
  codeIndexQueryTimeoutMs,
  codeLanguageForPath,
  MAX_CODE_INDEX_ENTITIES,
  MAX_CODE_INDEX_FILE_BYTES,
  MAX_CODE_INDEX_FILES,
  validateCodeFileAnalysis,
  type CodeFileAnalysis,
  type CodeIndexArtifactFile,
} from "./code-index-core";
import {
  readGithubBlobs,
} from "./github-app";
import { type KnowledgeSqlQuery } from "./graph-activation-core";
import { canonicalKnowledgeJson } from "./canonical-json";

import {
  claimCodeIndexJob,
  failCodeIndexJob,
  number,
  productionActivationDeadlineQuery,
  productionDeadlineQuery,
  productionQuery,
  transitionJob,
  CodeIndexFailure,
  type CodeIndexPhase,
} from "./code-index-store";
import { indexingPhase, manifestPhase } from "./code-index-indexing";
import { activatingPhase } from "./code-index-activation";

export function categoricalFailure(error: unknown) {
  return error instanceof CodeIndexFailure
    ? error
    : new CodeIndexFailure("code_index_internal", true);
}

export function phaseHasStartBudget(phase: CodeIndexPhase, deadline: number) {
  return codeIndexPhaseHasStartBudget(phase, deadline - Date.now());
}

export async function processCodeIndexQueue(input: {
  maxSteps?: number;
  deadlineMs?: number;
  query?: KnowledgeSqlQuery;
} = {}) {
  const maxSteps = Math.min(Math.max(input.maxSteps ?? 3, 1), 10);
  const deadline = Date.now() + Math.min(Math.max(input.deadlineMs ?? 45_000, 1_000), 50_000);
  const query = input.query ?? productionDeadlineQuery(deadline, 20_000);
  const activationQuery = input.query
    ?? productionActivationDeadlineQuery(deadline, 20_000);
  const cleanupQuery = input.query ?? productionQuery(4_000);
  const workerId = randomUUID();
  let completed = 0;
  let advanced = 0;
  let failed = 0;
  let yielded = 0;
  for (let step = 0; step < maxSteps && Date.now() < deadline; step += 1) {
    const job = await claimCodeIndexJob(query, workerId);
    if (!job) break;
    if (!phaseHasStartBudget(job.phase, deadline)) {
      await transitionJob(
        cleanupQuery,
        job,
        workerId,
        job.phase,
        job.totalFiles,
        job.processedFiles,
      );
      yielded += 1;
      break;
    }
    try {
      if (job.phase === "manifest") await manifestPhase(query, job, workerId);
      else if (job.phase === "indexing") await indexingPhase(query, job, workerId);
      else {
        const result = await activatingPhase(query, job, workerId, { deadline, activationQuery });
        if (result === "completed") completed += 1;
        else advanced += 1;
        continue;
      }
      advanced += 1;
    } catch (error) {
      await failCodeIndexJob(cleanupQuery, job, workerId, categoricalFailure(error));
      failed += 1;
    }
  }
  return { completed, advanced, failed, yielded };
}
