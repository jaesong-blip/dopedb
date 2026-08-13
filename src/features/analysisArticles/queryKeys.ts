// Analysis Article cache identity is always rooted in the authenticated workspace
// generation. Article UUIDs are not sufficient isolation because hosted accounts may
// legitimately contain records with the same client-generated identifier.
export const analysisQueryKeys = {
  articles: (scopeKey: string, environmentId?: string) =>
    environmentId === undefined
      ? (["analysis-articles", scopeKey] as const)
      : (["analysis-articles", scopeKey, environmentId] as const),
  runners: (scopeKey: string) => ["analysis-runners", scopeKey] as const,
  collaborators: (scopeKey: string) =>
    ["analysis-collaborators", scopeKey] as const,
  revisions: (scopeKey: string, articleId?: string) =>
    articleId === undefined
      ? (["analysis-article-revisions", scopeKey] as const)
      : (["analysis-article-revisions", scopeKey, articleId] as const),
  runs: (scopeKey: string, articleId?: string) =>
    articleId === undefined
      ? (["analysis-article-runs", scopeKey] as const)
      : (["analysis-article-runs", scopeKey, articleId] as const),
  localResult: (scopeKey: string, articleId: string | undefined) =>
    ["analysis-article-local-result", scopeKey, articleId] as const,
  result: (
    scopeKey: string,
    articleId: string | undefined,
    runId: string | null | undefined,
  ) => ["analysis-article-result", scopeKey, articleId, runId] as const,
  signals: (scopeKey: string, articleId: string) =>
    ["analysis-signals", scopeKey, articleId] as const,
  signalReceipts: (
    scopeKey: string,
    articleId: string,
    signalId?: string | null,
  ) => ["analysis-signal-receipts", scopeKey, articleId, signalId] as const,
  notifications: (scopeKey: string) =>
    ["analysis-notifications", scopeKey] as const,
  publication: (scopeKey: string, articleId: string) =>
    ["analysis-publication", scopeKey, articleId] as const,
};
