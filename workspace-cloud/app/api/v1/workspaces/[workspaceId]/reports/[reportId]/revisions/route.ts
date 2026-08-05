// Immutable report history. Revision payloads and referenced evidence are
// revalidated through the same allowlist used for current reports.
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";

import { db } from "../../../../../../../../lib/db";
import { isUuid, jsonError, privateJson } from "../../../../../../../../lib/http";
import {
  workspaceConnection,
  workspaceConnectionGrant,
  workspaceReport,
  workspaceReportEvidence,
  workspaceReportRevision,
} from "../../../../../../../../lib/schema";
import { authorizeWorkspace } from "../../../../../../../../lib/workspace-authorization";
import {
  evidenceIdsForClaims,
  parseReportVersionPayload,
  publicReportEvidence,
} from "../../../../../../../../lib/workspace-reports";
import { hasWorkspaceCapability } from "../../../../../../../../lib/workspace-permissions";

type RouteContext = { params: Promise<{ workspaceId: string; reportId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const { workspaceId, reportId } = await context.params;
  if (!isUuid(workspaceId) || !isUuid(reportId)) {
    return jsonError("Invalid workspace or report id", 400);
  }
  const authorization = await authorizeWorkspace(request, workspaceId, "view");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  if (!hasWorkspaceCapability(authorization.role, "write")) {
    return jsonError("Report history requires workspace Editor access", 403);
  }
  const rows = await db.select({ revision: workspaceReportRevision })
    .from(workspaceReportRevision)
    .innerJoin(
      workspaceReport,
      and(
        eq(workspaceReport.organizationId, workspaceReportRevision.organizationId),
        eq(workspaceReport.id, workspaceReportRevision.reportId),
      ),
    )
    .innerJoin(
      workspaceConnectionGrant,
      and(
        eq(workspaceConnectionGrant.organizationId, workspaceReport.organizationId),
        eq(workspaceConnectionGrant.connectionId, workspaceReport.connectionId),
        eq(workspaceConnectionGrant.memberId, authorization.membership.id),
      ),
    )
    .innerJoin(
      workspaceConnection,
      and(
        eq(workspaceConnection.organizationId, workspaceReport.organizationId),
        eq(workspaceConnection.id, workspaceReport.connectionId),
        isNull(workspaceConnection.deletedAt),
      ),
    )
    .where(and(
      eq(workspaceReportRevision.organizationId, workspaceId),
      eq(workspaceReportRevision.reportId, reportId),
    ))
    .orderBy(desc(workspaceReportRevision.revision))
    .limit(100);
  if (rows.length === 0) return jsonError("Report not found", 404);
  try {
    const revisions = rows.map(({ revision }) => ({
      revision: revision.revision,
      baseRevision: revision.baseRevision,
      operation: revision.operation,
      payload: parseReportVersionPayload(revision.payload),
      createdByMemberId: revision.createdByMemberId,
      createdAt: revision.createdAt.toISOString(),
    }));
    const evidenceIds = [...new Set(revisions.flatMap(({ payload }) => (
      evidenceIdsForClaims(payload.claims)
    )))];
    const evidenceRows = await db.select({ evidence: workspaceReportEvidence })
      .from(workspaceReportEvidence)
      .where(and(
        eq(workspaceReportEvidence.organizationId, workspaceId),
        eq(workspaceReportEvidence.reportId, reportId),
        inArray(workspaceReportEvidence.id, evidenceIds),
      ))
      .orderBy(asc(workspaceReportEvidence.executedAt), asc(workspaceReportEvidence.id));
    if (evidenceRows.length !== evidenceIds.length) {
      return jsonError("Report history evidence is incomplete", 409);
    }
    return privateJson({
      reportId,
      revisions,
      evidence: evidenceRows.map(({ evidence }) => publicReportEvidence(evidence)),
    });
  } catch {
    return jsonError("Report history is invalid", 409);
  }
}
