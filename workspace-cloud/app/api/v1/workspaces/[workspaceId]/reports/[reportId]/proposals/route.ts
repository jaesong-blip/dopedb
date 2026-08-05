// Agent-only append surface. The Agent may add new claims backed by new immutable
// query-run evidence, but cannot replace existing content, publish, or archive.
import { and, eq, isNull } from "drizzle-orm";

import { db } from "../../../../../../../../lib/db";
import { env } from "../../../../../../../../lib/env";
import {
  boundedJsonBody,
  isUuid,
  jsonError,
  mutationAllowed,
  privateJson,
} from "../../../../../../../../lib/http";
import { workspaceReport } from "../../../../../../../../lib/schema";
import { authorizeWorkspaceConnection } from "../../../../../../../../lib/workspace-authorization";
import { reportAuthority } from "../../../../../../../../lib/workspace-report-http";
import { commitReportMutation } from "../../../../../../../../lib/workspace-report-store";
import {
  parseSharedReportDefinition,
  parseSharedReportEvidenceAppend,
  publicReportSummary,
} from "../../../../../../../../lib/workspace-reports";
import { hasWorkspaceCapability } from "../../../../../../../../lib/workspace-permissions";
import { parseExpectedRevision } from "../../../../../../../../lib/workspace-versioning";

type RouteContext = { params: Promise<{ workspaceId: string; reportId: string }> };

export async function POST(request: Request, context: RouteContext) {
  if (!mutationAllowed(request, env.appOrigin())) {
    return jsonError("Invalid request origin", 403);
  }
  const { workspaceId, reportId } = await context.params;
  if (!isUuid(workspaceId) || !isUuid(reportId)) {
    return jsonError("Invalid workspace or report id", 400);
  }
  let expectedRevision: number | null;
  try {
    expectedRevision = parseExpectedRevision(request);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Invalid If-Match", 400);
  }
  if (expectedRevision === null || expectedRevision < 1) {
    return jsonError("An existing report revision is required", 428);
  }
  const body = await boundedJsonBody(request, 2 * 1024 * 1024);
  if (!body.ok) return jsonError("Invalid report evidence request", 400);
  let input;
  try {
    input = parseSharedReportEvidenceAppend(body.value);
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Invalid report evidence append",
      400,
    );
  }
  const authorization = await authorizeWorkspaceConnection(
    request,
    workspaceId,
    input.connectionId,
    "use",
  );
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  if (!hasWorkspaceCapability(authorization.role, "write")) {
    return jsonError("Report evidence append requires workspace Editor access", 403);
  }
  const report = await db.query.workspaceReport.findFirst({
    where: and(
      eq(workspaceReport.organizationId, workspaceId),
      eq(workspaceReport.id, reportId),
      eq(workspaceReport.connectionId, input.connectionId),
      isNull(workspaceReport.deletedAt),
    ),
  });
  if (!report) return jsonError("Report not found", 404);
  if (report.state === "archived") {
    return jsonError("Restore the report before adding evidence", 409);
  }
  if (report.revision !== expectedRevision) {
    return jsonError("Report changed concurrently. New evidence was not appended.", 409);
  }
  let definition;
  try {
    const current = parseSharedReportDefinition({
      title: report.title,
      question: report.question,
      conclusion: report.conclusion,
      preflightWarnings: report.preflightWarnings,
      claims: report.claims,
    });
    const currentClaimIds = new Set(current.claims.map((claim) => claim.id));
    if (
      current.claims.length + input.claims.length > 32
      || input.claims.some((claim) => currentClaimIds.has(claim.id))
    ) {
      return jsonError("Appended report claims conflict with existing content", 409);
    }
    definition = parseSharedReportDefinition({
      ...current,
      claims: [...current.claims, ...input.claims],
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Invalid report", 409);
  }
  const updated = await commitReportMutation({
    organizationId: workspaceId,
    reportId,
    connectionId: input.connectionId,
    expectedRevision,
    definition,
    state: "draft",
    source: report.source as "human" | "agent_proposal",
    ownerMemberId: report.ownerMemberId,
    authority: reportAuthority(authorization),
    operation: "append_evidence",
    evidence: input.evidence,
  });
  if (!updated) {
    return jsonError("Report authority or evidence changed. Nothing was appended.", 409);
  }
  return privateJson({
    report: {
      ...publicReportSummary(updated, updated.evidenceCount),
      evidence: input.evidence.map((evidence) => ({
        ...evidence,
        addedAtRevision: updated.revision,
        createdByMemberId: authorization.membership.id,
        createdAt: updated.updatedAt.toISOString(),
      })),
    },
  });
}
