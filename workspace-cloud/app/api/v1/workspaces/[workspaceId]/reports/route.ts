// Evidence-bound report collection. Viewers see published reports only; report
// drafts and review state remain an Editor workflow.
import { and, desc, eq, isNull, sql } from "drizzle-orm";

import { db } from "../../../../../../lib/db";
import { isUuid, jsonError, privateJson } from "../../../../../../lib/http";
import {
  workspaceConnection,
  workspaceConnectionGrant,
  workspaceReport,
  workspaceReportEvidence,
} from "../../../../../../lib/schema";
import { authorizeWorkspace } from "../../../../../../lib/workspace-authorization";
import { createSharedReport } from "../../../../../../lib/workspace-report-http";
import { publicReportSummary } from "../../../../../../lib/workspace-reports";
import { hasWorkspaceCapability } from "../../../../../../lib/workspace-permissions";

type RouteContext = { params: Promise<{ workspaceId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const { workspaceId } = await context.params;
  if (!isUuid(workspaceId)) return jsonError("Invalid workspace id", 400);
  const authorization = await authorizeWorkspace(request, workspaceId, "view");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  const rows = await db.select({
    report: workspaceReport,
    evidenceCount: sql<number>`(
      SELECT count(*) FROM ${workspaceReportEvidence} evidence
      WHERE evidence."organization_id" = ${workspaceReport}."organization_id"
        AND evidence."report_id" = ${workspaceReport}."id"
    )::bigint`.mapWith(Number),
  })
    .from(workspaceReport)
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
        isNull(workspaceConnection.revocationPendingAt),
      ),
    )
    .where(and(
      eq(workspaceReport.organizationId, workspaceId),
      isNull(workspaceReport.deletedAt),
      hasWorkspaceCapability(authorization.role, "write")
        ? undefined
        : eq(workspaceReport.state, "published"),
    ))
    .orderBy(desc(workspaceReport.updatedAt), desc(workspaceReport.id))
    .limit(100);
  try {
    return privateJson({
      workspaceId,
      authority: {
        memberId: authorization.membership.id,
        canEdit: hasWorkspaceCapability(authorization.role, "write"),
        canManageAll: authorization.role === "admin" || authorization.role === "owner",
      },
      reports: rows.map(({ report, evidenceCount }) => (
        publicReportSummary(report, evidenceCount)
      )),
    });
  } catch {
    return jsonError("Report collection is invalid", 409);
  }
}

export async function POST(request: Request, context: RouteContext) {
  const { workspaceId } = await context.params;
  if (!isUuid(workspaceId)) return jsonError("Invalid workspace id", 400);
  return createSharedReport(request, workspaceId, "human");
}
