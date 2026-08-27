// HTTP transport owns only the bounded Article, run, publication, and legacy
// recovery requests used by the simplified management surface.
import type {
  AnalysisArticle,
  AnalysisMigrationFailure,
  AnalysisPublication,
  AnalysisRun,
  Detail,
} from "./domain";

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function array<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

async function responseError(response: Response | null, fallback: string) {
  const body = await response?.json().catch(() => null);
  return typeof body?.error === "string" ? body.error : fallback;
}

async function requiredResponse(request: Promise<Response | null>, fallback: string) {
  const response = await request;
  if (!response?.ok) throw new Error(await responseError(response, fallback));
  return response;
}

export type AnalysisOverview = Readonly<{
  articles: AnalysisArticle[];
  migrationFailures: AnalysisMigrationFailure[];
}>;

export async function loadAnalysisOverview(
  workspaceId: string,
  canEdit: boolean,
  fallback: string,
  signal?: AbortSignal,
): Promise<AnalysisOverview> {
  const base = `/api/v1/workspaces/${workspaceId}/analyses`;
  const [articleResponse, migrationResponse] = await Promise.all([
    fetch(base, { cache: "no-store", signal }).catch(() => null),
    canEdit
      ? fetch(`${base}/migration-failures`, { cache: "no-store", signal }).catch(() => null)
      : Promise.resolve(null),
  ]);
  const failed = [articleResponse, ...(canEdit ? [migrationResponse] : [])]
    .find((response) => !response?.ok) ?? null;
  if (failed) throw new Error(await responseError(failed, fallback));
  const [articleBody, migrationBody] = await Promise.all([
    articleResponse!.json().catch(() => null),
    migrationResponse?.json().catch(() => null) ?? null,
  ]);
  return {
    articles: array<AnalysisArticle>(object(articleBody)?.articles),
    migrationFailures: array<AnalysisMigrationFailure>(object(migrationBody)?.failures),
  };
}

export async function loadAnalysisDetail(
  workspaceId: string,
  articleId: string,
  fallback: string,
  signal?: AbortSignal,
): Promise<Detail> {
  const prefix = `/api/v1/workspaces/${workspaceId}/analyses/${articleId}`;
  const [runResponse, publicationResponse] = await Promise.all([
    fetch(`${prefix}/runs`, { cache: "no-store", signal }).catch(() => null),
    fetch(`${prefix}/publications`, { cache: "no-store", signal }).catch(() => null),
  ]);
  const failed = [runResponse, publicationResponse].find((response) => !response?.ok) ?? null;
  if (failed) throw new Error(await responseError(failed, fallback));
  const [runBody, publicationBody] = await Promise.all([
    runResponse!.json().catch(() => null),
    publicationResponse!.json().catch(() => null),
  ]);
  return {
    runs: array<AnalysisRun>(object(runBody)?.runs),
    publications: array<AnalysisPublication>(object(publicationBody)?.publications),
  };
}

export async function resolveAnalysisMigrationFailure(
  workspaceId: string,
  failureId: string,
  articleId: string,
  fallback: string,
) {
  await requiredResponse(fetch(
    `/api/v1/workspaces/${workspaceId}/analyses/migration-failures`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ failureId, articleId }),
    },
  ).catch(() => null), fallback);
}
