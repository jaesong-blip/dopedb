// Refresh lease liveness/release endpoint used by Desktop cancellation polling.
import { and, eq, gt, isNull } from "drizzle-orm";

import { db } from "../../../../../../../../lib/db";
import { env } from "../../../../../../../../lib/env";
import { isUuid, jsonError, mutationAllowed, privateJson } from "../../../../../../../../lib/http";
import {
  workspaceAnalysisRefreshLease,
  workspaceAnalysisRunner,
} from "../../../../../../../../lib/schema";
import { authorizeWorkspace } from "../../../../../../../../lib/workspace-authorization";
import {
  analysisRunnerCapabilityHeader,
  hashAnalysisRunnerCapability,
  isAnalysisDesktopBearerRequest,
  parseAnalysisRunnerCapability,
} from "../../../../../../../../lib/workspace-analysis-runner-capability";
import { hashAnalysisLeaseCapability } from "../../../../../../../../lib/workspace-analysis-runner-store";

type RouteContext = { params: Promise<{ workspaceId: string; leaseId: string }> };

function capability(request: Request) {
  const value = request.headers.get("x-dopedb-analysis-capability")?.trim() ?? "";
  return /^[0-9a-f]{64}$/.test(value) ? value : null;
}

export async function GET(request: Request, context: RouteContext) {
  if (!isAnalysisDesktopBearerRequest(request)) {
    return jsonError("Analysis refresh lease checks require a Desktop bearer session", 401);
  }
  const { workspaceId, leaseId } = await context.params;
  if (!isUuid(workspaceId) || !isUuid(leaseId)) return jsonError("Invalid Analysis lease scope", 400);
  const token = capability(request);
  if (!token) return jsonError("Invalid Analysis lease capability", 403);
  const runnerCapability = parseAnalysisRunnerCapability(request);
  if (!runnerCapability) return jsonError(
    "Invalid Analysis runner capability",
    request.headers.has(analysisRunnerCapabilityHeader) ? 403 : 428,
  );
  const authorization = await authorizeWorkspace(request, workspaceId, "view");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  const row = await db.select({ id: workspaceAnalysisRefreshLease.id })
    .from(workspaceAnalysisRefreshLease)
    .innerJoin(
      workspaceAnalysisRunner,
      and(
        eq(workspaceAnalysisRunner.organizationId, workspaceAnalysisRefreshLease.organizationId),
        eq(workspaceAnalysisRunner.id, workspaceAnalysisRefreshLease.runnerId),
        eq(workspaceAnalysisRunner.memberId, authorization.membership.id),
        eq(
          workspaceAnalysisRunner.runnerCapabilityHash,
          hashAnalysisRunnerCapability(runnerCapability),
        ),
        eq(
          workspaceAnalysisRunner.runnerCapabilityGeneration,
          workspaceAnalysisRefreshLease.runnerCapabilityGeneration,
        ),
        isNull(workspaceAnalysisRunner.revokedAt),
      ),
    )
    .where(and(
      eq(workspaceAnalysisRefreshLease.organizationId, workspaceId),
      eq(workspaceAnalysisRefreshLease.id, leaseId),
      eq(workspaceAnalysisRefreshLease.leaseCapabilityHash, hashAnalysisLeaseCapability(token)),
      gt(workspaceAnalysisRefreshLease.expiresAt, new Date()),
      isNull(workspaceAnalysisRefreshLease.completedAt),
      isNull(workspaceAnalysisRefreshLease.revokedAt),
    )).limit(1);
  return privateJson({ active: row.length === 1 });
}

export async function DELETE(request: Request, context: RouteContext) {
  if (!mutationAllowed(request, env.appOrigin())) return jsonError("Invalid request origin", 403);
  if (!isAnalysisDesktopBearerRequest(request)) {
    return jsonError("Analysis refresh lease release requires a Desktop bearer session", 401);
  }
  const { workspaceId, leaseId } = await context.params;
  if (!isUuid(workspaceId) || !isUuid(leaseId)) return jsonError("Invalid Analysis lease scope", 400);
  const token = capability(request);
  if (!token) return jsonError("Invalid Analysis lease capability", 403);
  const runnerCapability = parseAnalysisRunnerCapability(request);
  if (!runnerCapability) return jsonError(
    "Invalid Analysis runner capability",
    request.headers.has(analysisRunnerCapabilityHeader) ? 403 : 428,
  );
  const authorization = await authorizeWorkspace(request, workspaceId, "view");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  const [owned] = await db.select({ runnerId: workspaceAnalysisRunner.id })
    .from(workspaceAnalysisRefreshLease)
    .innerJoin(workspaceAnalysisRunner, and(
      eq(workspaceAnalysisRunner.organizationId, workspaceAnalysisRefreshLease.organizationId),
      eq(workspaceAnalysisRunner.id, workspaceAnalysisRefreshLease.runnerId),
      eq(
        workspaceAnalysisRunner.runnerCapabilityGeneration,
        workspaceAnalysisRefreshLease.runnerCapabilityGeneration,
      ),
      eq(
        workspaceAnalysisRunner.runnerCapabilityHash,
        hashAnalysisRunnerCapability(runnerCapability),
      ),
    ))
    .where(and(
      eq(workspaceAnalysisRefreshLease.organizationId, workspaceId),
      eq(workspaceAnalysisRefreshLease.id, leaseId),
      eq(workspaceAnalysisRefreshLease.leaseCapabilityHash, hashAnalysisLeaseCapability(token)),
      eq(workspaceAnalysisRunner.memberId, authorization.membership.id),
      isNull(workspaceAnalysisRunner.revokedAt),
    )).limit(1);
  if (!owned) return privateJson({ revoked: false });
  const [revoked] = await db.update(workspaceAnalysisRefreshLease).set({
    revokedAt: new Date(),
  }).where(and(
    eq(workspaceAnalysisRefreshLease.organizationId, workspaceId),
    eq(workspaceAnalysisRefreshLease.id, leaseId),
    eq(workspaceAnalysisRefreshLease.leaseCapabilityHash, hashAnalysisLeaseCapability(token)),
    isNull(workspaceAnalysisRefreshLease.completedAt),
    isNull(workspaceAnalysisRefreshLease.revokedAt),
    eq(workspaceAnalysisRefreshLease.runnerId, owned.runnerId),
  )).returning({ id: workspaceAnalysisRefreshLease.id });
  return privateJson({ revoked: Boolean(revoked) });
}
