import { boundedJsonBody, isUuid, jsonError, privateJson } from "@/lib/http";
import {
  readPinnedGithubSource,
  searchPinnedGithubSource,
} from "@/lib/knowledge/source-browser-application";
import {
  validSourceBrowsePath,
  validSourceBrowseRange,
  validSourceBrowseSearch,
} from "@/lib/knowledge/source-browser";

type RouteContext = { params: Promise<{ workspaceId: string; sourceId: string }> };

function exactQuery(url: URL) {
  const environmentId = url.searchParams.get("environmentId");
  const revision = Number(url.searchParams.get("environmentRevision"));
  const connectionId = url.searchParams.get("connectionId");
  const connectionRevision = Number(url.searchParams.get("connectionRevision"));
  const commitSha = url.searchParams.get("commitSha");
  if (
    !environmentId
    || !isUuid(environmentId)
    || !Number.isSafeInteger(revision)
    || revision < 1
    || !connectionId
    || !isUuid(connectionId)
    || !Number.isSafeInteger(connectionRevision)
    || connectionRevision < 1
    || !commitSha
    || !/^[0-9a-f]{40}$/.test(commitSha)
  ) return null;
  return {
    environmentId,
    environmentRevision: revision,
    connectionId,
    connectionRevision,
    commitSha,
  };
}

export async function GET(request: Request, context: RouteContext) {
  const { workspaceId, sourceId } = await context.params;
  const url = new URL(request.url);
  const exact = exactQuery(url);
  const query = url.searchParams.get("query") ?? "";
  const limit = Number(url.searchParams.get("limit") ?? "20");
  if (
    !isUuid(workspaceId)
    || !isUuid(sourceId)
    || !exact
    || !validSourceBrowseSearch(query, limit)
  ) {
    return jsonError("Invalid source browse request", 400);
  }
  const result = await searchPinnedGithubSource(
    request,
    { workspaceId, sourceId, ...exact, query, limit },
  );
  return result.ok ? privateJson(result.value) : jsonError(result.error, result.status);
}

export async function POST(request: Request, context: RouteContext) {
  const { workspaceId, sourceId } = await context.params;
  const parsed = await boundedJsonBody(request, 16 * 1024);
  if (!parsed.ok) {
    return jsonError(
      parsed.reason === "too_large" ? "Source file request is too large" : "Invalid source file request",
      parsed.reason === "too_large" ? 413 : 400,
    );
  }
  const body = parsed.ok ? parsed.value as Record<string, unknown> : null;
  if (
    !isUuid(workspaceId)
    || !isUuid(sourceId)
    || !body
    || typeof body.environmentId !== "string"
    || !isUuid(body.environmentId)
    || typeof body.environmentRevision !== "number"
    || !Number.isSafeInteger(body.environmentRevision)
    || body.environmentRevision < 1
    || typeof body.connectionId !== "string"
    || !isUuid(body.connectionId)
    || typeof body.connectionRevision !== "number"
    || !Number.isSafeInteger(body.connectionRevision)
    || body.connectionRevision < 1
    || typeof body.commitSha !== "string"
    || !/^[0-9a-f]{40}$/.test(body.commitSha)
    || typeof body.path !== "string"
    || !validSourceBrowsePath(body.path)
    || typeof body.lineStart !== "number"
    || typeof body.lineEnd !== "number"
    || !validSourceBrowseRange(body.lineStart, body.lineEnd)
  ) return jsonError("Invalid source file request", 400);
  const result = await readPinnedGithubSource(
    request,
    {
      workspaceId,
      sourceId,
      environmentId: body.environmentId,
      environmentRevision: body.environmentRevision,
      connectionId: body.connectionId,
      connectionRevision: body.connectionRevision,
      commitSha: body.commitSha,
      path: body.path,
      lineStart: body.lineStart,
      lineEnd: body.lineEnd,
    },
  );
  return result.ok ? privateJson(result.value) : jsonError(result.error, result.status);
}
