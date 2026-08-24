// Real-PostgreSQL contract for Desktop-only Analysis Article results: the
// remote run closes with receipts while plaintext fragments remain local.
import { randomUUID } from "node:crypto";

import { expect } from "vitest";

import type { commitAnalysisArticleMutation } from "../workspace-analysis-article-store";
import type { SharedAnalysisArticleCreate } from "../workspace-analysis-articles";
import type * as AnalysisRunStore from "../workspace-analysis-run-store";
import type * as AnalysisRunContract from "../workspace-analysis-runs";
import type { AnalysisQueryReceiptInput } from "../workspace-analysis-runs";
import type { ProviderImportPostgresHarness } from "./fixture";

type LocalResultScenarioInput = Readonly<{
  fixture: ProviderImportPostgresHarness;
  articleId: string;
  article: SharedAnalysisArticleCreate;
  queryReceipt: AnalysisQueryReceiptInput;
  runnerId: string;
  runnerCapabilityHash: string;
  createRun: (revision: number) => Promise<string>;
  mutateArticle: typeof commitAnalysisArticleMutation;
  runStore: typeof AnalysisRunStore;
  runContract: typeof AnalysisRunContract;
}>;

/** Proves that a draft run closes remotely without uploading its local result. */
export async function returnDraftAndVerifyLocalOnlyCompletion(
  input: LocalResultScenarioInput,
) {
  const { authority, memberId, organizationId, sql } = input.fixture;
  const returnedDraft = await input.mutateArticle({
    organizationId,
    article: input.article,
    expectedRevision: 3,
    state: "draft",
    ownerMemberId: memberId,
    authority,
    operation: "return_draft",
  });
  expect(returnedDraft).toMatchObject({ revision: 4, state: "draft" });

  const localOnlyReceipt = { ...input.queryReceipt, queryRunId: randomUUID() };
  const payload = {
    state: "succeeded",
    queryReceipts: [localOnlyReceipt],
    fragmentManifest: [],
    error: null,
  } as const;
  const localOnlyCompletion = input.runContract.parseAnalysisRunCompletion(
    payload,
    input.article.definition,
  );
  expect(input.runContract.analysisResultFragmentsAreComplete(
    input.article.definition,
    [],
  )).toBe(false);

  const runId = await input.createRun(4);
  const completionInput = {
    organizationId,
    articleId: input.articleId,
    runId,
    runnerId: input.runnerId,
    runnerCapabilityHash: input.runnerCapabilityHash,
    completion: localOnlyCompletion,
    fragmentManifest: [],
    authority,
  } as const;
  const completed = await input.runStore.commitAnalysisRunCompletion(completionInput);
  expect(completed).toMatchObject({
    id: runId,
    state: "succeeded",
    rowCount: 2,
    byteCount: 0,
    resultHash: input.runContract.analysisRunResultHash([localOnlyReceipt], []),
  });
  await expect(input.runStore.commitAnalysisRunCompletion(completionInput))
    .resolves.toMatchObject({ id: runId, state: "succeeded" });

  const durability = await sql<{
    fragments: number;
    receipts: number;
    completionAudits: number;
  }[]>`
    SELECT
      (SELECT count(*)::int
       FROM "workspace_control"."workspace_analysis_result_fragment"
       WHERE "organization_id" = ${organizationId}
         AND "run_id" = ${runId}::uuid) AS "fragments",
      (SELECT count(*)::int
       FROM "workspace_control"."workspace_analysis_article_query_receipt"
       WHERE "organization_id" = ${organizationId}
         AND "run_id" = ${runId}::uuid) AS "receipts",
      (SELECT count(*)::int
       FROM "workspace_control"."workspace_audit_event"
       WHERE "organization_id" = ${organizationId}
         AND "action" = 'analysis_article.run_complete'
         AND "resource_id" = ${runId}) AS "completionAudits"
  `;
  expect(durability[0]).toEqual({ fragments: 0, receipts: 1, completionAudits: 1 });
}
