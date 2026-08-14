// HTTP transport owns Analysis management endpoints and their response envelopes.
import type {
  AnalysisArticle,
  AnalysisMigrationFailure,
  AnalysisNotification,
  AnalysisResult,
  AnalysisRunner,
  AnalysisRun,
  AnalysisSignal,
  AnalysisPublication,
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

async function requiredResponse(
  request: Promise<Response | null>,
  fallback: string,
) {
  const response = await request;
  if (!response?.ok) throw new Error(await responseError(response, fallback));
  return response;
}

export type AnalysisOverview = Readonly<{
  articles: AnalysisArticle[];
  runners: AnalysisRunner[];
  notifications: AnalysisNotification[];
  migrationFailures: AnalysisMigrationFailure[];
}>;

export async function loadAnalysisOverview(
  workspaceId: string,
  canEdit: boolean,
  fallback: string,
  signal?: AbortSignal,
): Promise<AnalysisOverview> {
  const base = `/api/v1/workspaces/${workspaceId}/analyses`;
  const [articleResponse, runnerResponse, notificationResponse, migrationResponse] = await Promise.all([
    fetch(base, { cache: "no-store", signal }).catch(() => null),
    fetch(`${base}/runners`, { cache: "no-store", signal }).catch(() => null),
    fetch(`${base}/notifications?channel=workspace_web`, {
      cache: "no-store",
      signal,
    }).catch(() => null),
    canEdit
      ? fetch(`${base}/migration-failures`, {
      cache: "no-store",
      signal,
      }).catch(() => null)
      : Promise.resolve(null),
  ]);
  const failed = [articleResponse, runnerResponse, notificationResponse, ...(canEdit
    ? [migrationResponse]
    : [])].find((response) => !response?.ok) ?? null;
  if (failed) throw new Error(await responseError(failed, fallback));
  const [articleBody, runnerBody, notificationBody, migrationBody] = await Promise.all([
    articleResponse!.json().catch(() => null),
    runnerResponse!.json().catch(() => null),
    notificationResponse!.json().catch(() => null),
    migrationResponse?.json().catch(() => null) ?? null,
  ]);
  return {
    articles: array<AnalysisArticle>(object(articleBody)?.articles),
    runners: array<AnalysisRunner>(object(runnerBody)?.runners),
    notifications: array<AnalysisNotification>(object(notificationBody)?.notifications),
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
  const [runResponse, signalResponse, publicationResponse] = await Promise.all([
    fetch(`${prefix}/runs`, { cache: "no-store", signal }).catch(() => null),
    fetch(`${prefix}/signals`, { cache: "no-store", signal }).catch(() => null),
    fetch(`${prefix}/publications`, { cache: "no-store", signal }).catch(() => null),
  ]);
  const failed = [runResponse, signalResponse, publicationResponse]
    .find((response) => !response?.ok) ?? null;
  if (failed) throw new Error(await responseError(failed, fallback));
  const [runBody, signalBody, publicationBody] = await Promise.all([
    runResponse!.json().catch(() => null),
    signalResponse!.json().catch(() => null),
    publicationResponse!.json().catch(() => null),
  ]);
  return {
    runs: array<AnalysisRun>(object(runBody)?.runs),
    signals: array<AnalysisSignal>(object(signalBody)?.signals),
    publications: array<AnalysisPublication>(object(publicationBody)?.publications),
  };
}

export async function loadAnalysisResult(
  workspaceId: string,
  articleId: string,
  runId: string,
  fallback: string,
  signal?: AbortSignal,
): Promise<AnalysisResult> {
  const response = await requiredResponse(fetch(
    `/api/v1/workspaces/${workspaceId}/analyses/${articleId}/runs/${runId}/results`,
    { cache: "no-store", signal },
  ).catch(() => null), fallback);
  return response.json() as Promise<AnalysisResult>;
}

async function patchAnalysis(
  url: string,
  body: object,
  fallback: string,
) {
  await requiredResponse(fetch(url, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => null), fallback);
}

export function markAnalysisNotificationsRead(
  workspaceId: string,
  notificationIds: readonly string[],
  fallback: string,
) {
  return patchAnalysis(
    `/api/v1/workspaces/${workspaceId}/analyses/notifications?channel=workspace_web`,
    { notificationIds },
    fallback,
  );
}

export function resolveAnalysisMigrationFailure(
  workspaceId: string,
  failureId: string,
  articleId: string,
  fallback: string,
) {
  return patchAnalysis(
    `/api/v1/workspaces/${workspaceId}/analyses/migration-failures`,
    { failureId, articleId },
    fallback,
  );
}
