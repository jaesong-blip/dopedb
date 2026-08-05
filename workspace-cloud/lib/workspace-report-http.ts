// Shared report HTTP creation boundary. The route, not caller-controlled JSON,
// chooses whether a draft is human-authored or an Agent proposal.
import "server-only";

import { and, asc, eq, isNull } from "drizzle-orm";

import { db } from "./db";
import { env } from "./env";
import { boundedJsonBody, jsonError, mutationAllowed, privateJson } from "./http";
import { workspaceReport, workspaceReportEvidence } from "./schema";
import { authorizeWorkspaceConnection } from "./workspace-authorization";
import {
  commitReportCreate,
  type ReportMutationAuthority,
} from "./workspace-report-store";
import {
  parseSharedReportCreate,
  publicReportEvidence,
  publicReportSummary,
  type ReportSource,
} from "./workspace-reports";
import { hasWorkspaceCapability } from "./workspace-permissions";
import { canonicalHash, parseExpectedRevision } from "./workspace-versioning";

export function reportAuthority(authorization: {
  role: string;
  session: { session: { id: string }; user: { id: string } };
  membership: { id: string };
}): ReportMutationAuthority {
  return {
    sessionId: authorization.session.session.id,
    userId: authorization.session.user.id,
    membershipId: authorization.membership.id,
    role: authorization.role,
  };
}

function uniqueViolation(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const row = error as { code?: unknown; cause?: { code?: unknown } };
  return row.code === "23505" || row.cause?.code === "23505";
}

export async function createSharedReport(
  request: Request,
  workspaceId: string,
  source: ReportSource,
) {
  if (!mutationAllowed(request, env.appOrigin())) {
    return jsonError("Invalid request origin", 403);
  }
  let expectedRevision: number | null;
  try {
    expectedRevision = parseExpectedRevision(request);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Invalid If-Match", 400);
  }
  if (expectedRevision === null) return jsonError("If-Match is required", 428);
  if (expectedRevision !== 0) return jsonError("New reports require If-Match: \"0\"", 409);
  const body = await boundedJsonBody(request, 2 * 1024 * 1024);
  if (!body.ok) return jsonError("Invalid report request", 400);
  let input;
  try {
    input = parseSharedReportCreate(body.value);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Invalid report", 400);
  }
  const authorization = await authorizeWorkspaceConnection(
    request,
    workspaceId,
    input.connectionId,
    "use",
  );
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  if (!hasWorkspaceCapability(authorization.role, "write")) {
    return jsonError("Report editing requires workspace Editor access", 403);
  }
  try {
    const report = await commitReportCreate({
      organizationId: workspaceId,
      report: input,
      source,
      authority: reportAuthority(authorization),
    });
    if (!report) return jsonError("Report authority changed. Retry creation.", 409);
    return privateJson({
      report: {
        ...publicReportSummary(report, report.evidenceCount),
        evidence: input.evidence.map((item) => ({
          ...item,
          addedAtRevision: 1,
          createdByMemberId: authorization.membership.id,
          createdAt: report.createdAt.toISOString(),
        })),
      },
    }, { status: 201 });
  } catch (error) {
    if (!uniqueViolation(error)) throw error;
    // Retrying a lost create response is safe only for the exact first draft and
    // exact immutable evidence set. Any reused identity remains a real conflict.
    const existing = await db.query.workspaceReport.findFirst({
      where: and(
        eq(workspaceReport.organizationId, workspaceId),
        eq(workspaceReport.id, input.id),
        isNull(workspaceReport.deletedAt),
      ),
    });
    if (
      !existing
      || existing.connectionId !== input.connectionId
      || existing.ownerMemberId !== authorization.membership.id
      || existing.revision !== 1
      || existing.state !== "draft"
      || existing.source !== source
      || canonicalHash({
        title: existing.title,
        question: existing.question,
        conclusion: existing.conclusion,
        preflightWarnings: existing.preflightWarnings,
        claims: existing.claims,
      }) !== canonicalHash({
        title: input.title,
        question: input.question,
        conclusion: input.conclusion,
        preflightWarnings: input.preflightWarnings,
        claims: input.claims,
      })
    ) {
      return jsonError("Report already exists", 409);
    }
    const storedEvidence = await db.select({ evidence: workspaceReportEvidence })
      .from(workspaceReportEvidence)
      .where(and(
        eq(workspaceReportEvidence.organizationId, workspaceId),
        eq(workspaceReportEvidence.reportId, input.id),
      ))
      .orderBy(asc(workspaceReportEvidence.id));
    const expectedEvidence = [...input.evidence].sort((left, right) => left.id.localeCompare(right.id));
    if (
      storedEvidence.length !== expectedEvidence.length
      || storedEvidence.some(({ evidence }, index) => {
        const expected = expectedEvidence[index];
        return evidence.id !== expected.id
          || evidence.queryRunId !== expected.queryRunId
          || evidence.sql !== expected.sql
          || evidence.executedAt.toISOString() !== expected.executedAt;
      })
    ) {
      return jsonError("Report already exists", 409);
    }
    return privateJson({
      report: {
        ...publicReportSummary(existing, storedEvidence.length),
        evidence: storedEvidence.map(({ evidence }) => publicReportEvidence(evidence)),
      },
    });
  }
}
