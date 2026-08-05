// One evidence-bound report's human mutation surface. Agent tooling only reaches
// the separate proposal endpoint and therefore cannot publish or replace reports.
import { and, asc, count, eq, inArray, isNull } from "drizzle-orm";

import { db } from "../../../../../../../lib/db";
import { env } from "../../../../../../../lib/env";
import {
  boundedJsonBody,
  isUuid,
  jsonError,
  mutationAllowed,
  privateJson,
} from "../../../../../../../lib/http";
import {
  workspaceConnection,
  workspaceConnectionGrant,
  workspaceReport,
  workspaceReportEvidence,
  workspaceReportRevision,
} from "../../../../../../../lib/schema";
import { authorizeWorkspace, authorizeWorkspaceConnection } from "../../../../../../../lib/workspace-authorization";
import { reportAuthority } from "../../../../../../../lib/workspace-report-http";
import {
  commitReportMutation,
} from "../../../../../../../lib/workspace-report-store";
import {
  evidenceIdsForClaims,
  parseReportVersionPayload,
  parseSharedReportDefinition,
  parseSharedReportEvidenceList,
  publicReportEvidence,
  publicReportSummary,
  type ReportState,
  type SharedReportDefinition,
} from "../../../../../../../lib/workspace-reports";
import { hasWorkspaceCapability } from "../../../../../../../lib/workspace-permissions";
import { canonicalHash, parseExpectedRevision } from "../../../../../../../lib/workspace-versioning";

type RouteContext = { params: Promise<{ workspaceId: string; reportId: string }> };
type AccessibleReport = typeof workspaceReport.$inferSelect;

async function accessibleReport(
  organizationId: string,
  reportId: string,
  memberId: string,
  includeUnpublished: boolean,
  includeDeleted = false,
): Promise<AccessibleReport | null> {
  const [row] = await db.select({ report: workspaceReport })
    .from(workspaceReport)
    .innerJoin(
      workspaceConnectionGrant,
      and(
        eq(workspaceConnectionGrant.organizationId, workspaceReport.organizationId),
        eq(workspaceConnectionGrant.connectionId, workspaceReport.connectionId),
        eq(workspaceConnectionGrant.memberId, memberId),
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
      eq(workspaceReport.organizationId, organizationId),
      eq(workspaceReport.id, reportId),
      includeDeleted ? undefined : isNull(workspaceReport.deletedAt),
      includeUnpublished ? undefined : eq(workspaceReport.state, "published"),
    ))
    .limit(1);
  return row?.report ?? null;
}

function currentDefinition(report: AccessibleReport): SharedReportDefinition {
  return parseSharedReportDefinition({
    title: report.title,
    question: report.question,
    conclusion: report.conclusion,
    preflightWarnings: report.preflightWarnings,
    claims: report.claims,
  });
}

async function evidenceCount(organizationId: string, reportId: string) {
  const [row] = await db.select({ value: count() })
    .from(workspaceReportEvidence)
    .where(and(
      eq(workspaceReportEvidence.organizationId, organizationId),
      eq(workspaceReportEvidence.reportId, reportId),
    ));
  return row?.value ?? 0;
}

async function currentEvidence(
  organizationId: string,
  reportId: string,
  definition: SharedReportDefinition,
) {
  const evidenceIds = evidenceIdsForClaims(definition.claims);
  const rows = await db.select({ evidence: workspaceReportEvidence })
    .from(workspaceReportEvidence)
    .where(and(
      eq(workspaceReportEvidence.organizationId, organizationId),
      eq(workspaceReportEvidence.reportId, reportId),
      inArray(workspaceReportEvidence.id, evidenceIds),
    ))
    .orderBy(asc(workspaceReportEvidence.executedAt), asc(workspaceReportEvidence.id));
  if (rows.length !== evidenceIds.length) throw new Error("Report evidence is incomplete");
  return rows.map(({ evidence }) => publicReportEvidence(evidence));
}

async function publicReportDetail(report: AccessibleReport) {
  const definition = currentDefinition(report);
  const [storedEvidenceCount, evidence] = await Promise.all([
    evidenceCount(report.organizationId, report.id),
    currentEvidence(report.organizationId, report.id, definition),
  ]);
  return {
    ...publicReportSummary(report, storedEvidenceCount),
    evidence,
  };
}

async function expectedRevision(request: Request) {
  try {
    const value = parseExpectedRevision(request);
    if (value === null) return { error: jsonError("If-Match is required", 428) } as const;
    return { value } as const;
  } catch (error) {
    return {
      error: jsonError(error instanceof Error ? error.message : "Invalid If-Match", 400),
    } as const;
  }
}

function sameReportOutcome(
  report: AccessibleReport,
  expectedRevisionValue: number,
  definition: SharedReportDefinition,
  state: ReportState,
  ownerMemberId: string,
) {
  const nextRevision = expectedRevisionValue + 1;
  return Number.isSafeInteger(nextRevision)
    && report.revision === nextRevision
    && report.state === state
    && report.ownerMemberId === ownerMemberId
    && canonicalHash(currentDefinition(report)) === canonicalHash(definition);
}

export async function GET(request: Request, context: RouteContext) {
  const { workspaceId, reportId } = await context.params;
  if (!isUuid(workspaceId) || !isUuid(reportId)) {
    return jsonError("Invalid workspace or report id", 400);
  }
  const authorization = await authorizeWorkspace(request, workspaceId, "view");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  const report = await accessibleReport(
    workspaceId,
    reportId,
    authorization.membership.id,
    hasWorkspaceCapability(authorization.role, "write"),
  );
  if (!report) return jsonError("Report not found", 404);
  try {
    return privateJson({ report: await publicReportDetail(report) });
  } catch {
    return jsonError("Report evidence is invalid", 409);
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  if (!mutationAllowed(request, env.appOrigin())) {
    return jsonError("Invalid request origin", 403);
  }
  const { workspaceId, reportId } = await context.params;
  if (!isUuid(workspaceId) || !isUuid(reportId)) {
    return jsonError("Invalid workspace or report id", 400);
  }
  const workspace = await authorizeWorkspace(request, workspaceId, "write");
  if (!workspace.ok) return jsonError(workspace.error, workspace.status);
  const report = await accessibleReport(workspaceId, reportId, workspace.membership.id, true);
  if (!report) return jsonError("Report not found", 404);
  const connectionAuthorization = await authorizeWorkspaceConnection(
    request,
    workspaceId,
    report.connectionId,
    "use",
  );
  if (!connectionAuthorization.ok) {
    return jsonError(connectionAuthorization.error, connectionAuthorization.status);
  }
  if (!hasWorkspaceCapability(connectionAuthorization.role, "write")) {
    return jsonError("Report editing requires workspace Editor access", 403);
  }
  const match = await expectedRevision(request);
  if ("error" in match) return match.error;
  const parsedBody = await boundedJsonBody(request, 2 * 1024 * 1024);
  const body = parsedBody.ok && parsedBody.value && typeof parsedBody.value === "object"
    && !Array.isArray(parsedBody.value)
    ? parsedBody.value as Record<string, unknown>
    : null;
  if (!body || typeof body.action !== "string") return jsonError("Invalid report action", 400);

  let definition = currentDefinition(report);
  let state = report.state as ReportState;
  let ownerMemberId = report.ownerMemberId;
  let operation:
    | "update"
    | "submit_review"
    | "return_draft"
    | "publish"
    | "archive"
    | "restore"
    | "transfer"
    | "append_evidence";
  let evidence: ReturnType<typeof parseSharedReportEvidenceList> = [];

  if (body.action === "update" && Object.keys(body).length === 2) {
    if (report.state === "archived") {
      return jsonError("Restore an archived report before editing it", 409);
    }
    try {
      definition = parseSharedReportDefinition(body.definition);
    } catch (error) {
      return jsonError(error instanceof Error ? error.message : "Invalid report definition", 400);
    }
    state = "draft";
    operation = "update";
  } else if (body.action === "submit_review" && Object.keys(body).length === 1) {
    if (report.state !== "draft") return jsonError("Only a draft can enter review", 409);
    state = "review";
    operation = "submit_review";
  } else if (body.action === "return_draft" && Object.keys(body).length === 1) {
    if (report.state !== "review") return jsonError("Only a report in review can return to draft", 409);
    state = "draft";
    operation = "return_draft";
  } else if (
    body.action === "publish"
    && Object.keys(body).length === 2
    && body.confirmation === "publish"
  ) {
    if (report.state !== "review") {
      return jsonError("A report must be reviewed before publication", 409);
    }
    state = "published";
    operation = "publish";
  } else if (body.action === "archive" && Object.keys(body).length === 1) {
    if (report.state === "archived") return jsonError("Report is already archived", 409);
    state = "archived";
    operation = "archive";
  } else if (
    body.action === "transfer"
    && Object.keys(body).length === 2
    && typeof body.ownerMemberId === "string"
    && isUuid(body.ownerMemberId)
  ) {
    ownerMemberId = body.ownerMemberId;
    operation = "transfer";
  } else if (
    body.action === "restore"
    && Object.keys(body).length === 2
    && typeof body.revision === "number"
    && Number.isSafeInteger(body.revision)
    && body.revision >= 1
  ) {
    const historical = await db.query.workspaceReportRevision.findFirst({
      where: and(
        eq(workspaceReportRevision.organizationId, workspaceId),
        eq(workspaceReportRevision.reportId, reportId),
        eq(workspaceReportRevision.revision, body.revision),
      ),
      columns: { payload: true },
    });
    if (!historical) return jsonError("Report revision not found", 404);
    try {
      const payload = parseReportVersionPayload(historical.payload);
      if (
        payload.connectionId !== report.connectionId
        || payload.source !== report.source
        || payload.deleted
      ) {
        return jsonError("Report revision cannot be restored", 409);
      }
      definition = payload;
      state = "draft";
    } catch {
      return jsonError("Report revision is invalid", 409);
    }
    operation = "restore";
  } else if (
    body.action === "append_evidence"
    && Object.keys(body).length === 3
  ) {
    if (report.state === "archived") {
      return jsonError("Restore an archived report before adding evidence", 409);
    }
    try {
      definition = parseSharedReportDefinition(body.definition);
      evidence = parseSharedReportEvidenceList(body.evidence);
    } catch (error) {
      return jsonError(error instanceof Error ? error.message : "Invalid report evidence", 400);
    }
    const referenced = new Set(evidenceIdsForClaims(definition.claims));
    if (evidence.some((item) => !referenced.has(item.id))) {
      return jsonError("New report evidence must support a claim", 400);
    }
    state = "draft";
    operation = "append_evidence";
  } else {
    return jsonError("Invalid report action", 400);
  }

  if (match.value !== report.revision) {
    if (
      evidence.length === 0
      && sameReportOutcome(report, match.value, definition, state, ownerMemberId)
    ) {
      return privateJson({ report: await publicReportDetail(report) });
    }
    return jsonError("Report changed concurrently. The stale edit was not applied.", 409);
  }
  const updated = await commitReportMutation({
    organizationId: workspaceId,
    reportId,
    connectionId: report.connectionId,
    expectedRevision: match.value,
    definition,
    state,
    source: report.source as "human" | "agent_proposal",
    ownerMemberId,
    authority: reportAuthority(connectionAuthorization),
    operation,
    evidence,
  });
  if (!updated) return jsonError("Report authority or evidence changed. Retry the action.", 409);
  const refreshed = await accessibleReport(workspaceId, reportId, workspace.membership.id, true);
  if (!refreshed || refreshed.revision !== updated.revision) {
    return jsonError("Report changed after the action. Refresh it.", 409);
  }
  return privateJson({ report: await publicReportDetail(refreshed) });
}

export async function DELETE(request: Request, context: RouteContext) {
  if (!mutationAllowed(request, env.appOrigin())) {
    return jsonError("Invalid request origin", 403);
  }
  const { workspaceId, reportId } = await context.params;
  if (!isUuid(workspaceId) || !isUuid(reportId)) {
    return jsonError("Invalid workspace or report id", 400);
  }
  const workspace = await authorizeWorkspace(request, workspaceId, "write");
  if (!workspace.ok) return jsonError(workspace.error, workspace.status);
  const match = await expectedRevision(request);
  if ("error" in match) return match.error;
  const report = await accessibleReport(
    workspaceId,
    reportId,
    workspace.membership.id,
    true,
    true,
  );
  if (!report) return jsonError("Report not found", 404);
  const connectionAuthorization = await authorizeWorkspaceConnection(
    request,
    workspaceId,
    report.connectionId,
    "use",
  );
  if (!connectionAuthorization.ok) {
    return jsonError(connectionAuthorization.error, connectionAuthorization.status);
  }
  if (!hasWorkspaceCapability(connectionAuthorization.role, "write")) {
    return jsonError("Report deletion requires workspace Editor access", 403);
  }
  if (report.deletedAt) {
    const deletedRevision = match.value + 1;
    if (Number.isSafeInteger(deletedRevision) && report.revision === deletedRevision) {
      return privateJson({ deleted: true, revision: report.revision });
    }
    return jsonError("Report deletion changed concurrently", 409);
  }
  if (match.value !== report.revision) {
    return jsonError("Report changed concurrently. Retry deletion.", 409);
  }
  const deleted = await commitReportMutation({
    organizationId: workspaceId,
    reportId,
    connectionId: report.connectionId,
    expectedRevision: match.value,
    definition: currentDefinition(report),
    state: "archived",
    source: report.source as "human" | "agent_proposal",
    ownerMemberId: report.ownerMemberId,
    authority: reportAuthority(connectionAuthorization),
    operation: "delete",
  });
  if (!deleted) return jsonError("Report authority changed. Retry deletion.", 409);
  return privateJson({ deleted: true, revision: deleted.revision });
}
