// Read-only Neon branch tree for one exact integration/project. Mutation
// controls are intentionally absent until their approval and reconciliation
// contracts exist; this route only exposes live, redacted provider state and
// workspace references.
import { and, count, eq, gt, isNull } from "drizzle-orm";

import { db } from "../../../../../../../../lib/db";
import {
  activeProviderIntegration,
  revalidateProviderDiscoveryAuthority,
  verifiedNeonProjectCredential,
} from "../../../../../../../../lib/provider-integrations";
import {
  isSafeDisplayText,
  isUuid,
  jsonError,
  privateJson,
} from "../../../../../../../../lib/http";
import {
  listNeonBranchInventory,
} from "../../../../../../../../lib/providers/neon";
import {
  neonSegment,
  parseNeonResource,
} from "../../../../../../../../lib/providers/neon-core";
import { MAX_PROVIDER_RESULTS } from "../../../../../../../../lib/providers/adapter-contract";
import { ProviderRequestError } from "../../../../../../../../lib/providers/provider-types";
import {
  listNeonBranchManagedAccessBoundaries,
} from "../../../../../../../../lib/provider-operation-store";
import {
  workspaceConnection,
  workspaceCredentialLease,
} from "../../../../../../../../lib/schema";
import { authorizeWorkspace } from "../../../../../../../../lib/workspace-authorization";

type RouteContext = {
  params: Promise<{ workspaceId: string; integrationId: string }>;
};

export const maxDuration = 60;

function projectQuery(request: Request) {
  const params = new URL(request.url).searchParams;
  if (
    [...params.keys()].some((key) => key !== "project")
    || params.getAll("project").length !== 1
  ) {
    return null;
  }
  const projectId = params.get("project");
  return neonSegment(projectId) ? projectId : null;
}

function authorityFor(
  workspaceId: string,
  integrationId: string,
  generation: bigint,
  authorization: {
    membership: { id: string };
    session: { user: { id: string }; session: { id: string } };
    role: string;
  },
) {
  return {
    organizationId: workspaceId,
    integrationId,
    provider: "neon",
    integrationGeneration: generation,
    memberId: authorization.membership.id,
    userId: authorization.session.user.id,
    sessionId: authorization.session.session.id,
    role: authorization.role,
  };
}

export async function GET(request: Request, context: RouteContext) {
  const { workspaceId, integrationId } = await context.params;
  if (!isUuid(workspaceId) || !isUuid(integrationId)) {
    return jsonError("Invalid workspace or integration id", 400);
  }
  const projectId = projectQuery(request);
  if (!projectId) return jsonError("Invalid Neon project query", 400);

  const authorization = await authorizeWorkspace(request, workspaceId, "manage");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  const integration = await activeProviderIntegration(workspaceId, integrationId);
  if (!integration || integration.provider !== "neon") {
    return jsonError("Neon integration not found", 404);
  }
  const authority = authorityFor(
    workspaceId,
    integrationId,
    integration.generation,
    authorization,
  );

  try {
    const credential = await verifiedNeonProjectCredential(integration, projectId);
    const inventory = await listNeonBranchInventory(credential, projectId);
    const now = new Date();
    const [connectionRows, activeLeaseRows, branchBoundaries] = await Promise.all([
      db.select({
        id: workspaceConnection.id,
        name: workspaceConnection.name,
        environment: workspaceConnection.environment,
        allowWrites: workspaceConnection.allowWrites,
        contentRevision: workspaceConnection.contentRevision,
        authorityRevision: workspaceConnection.revision,
        resource: workspaceConnection.providerResource,
        deletedAt: workspaceConnection.deletedAt,
        revocationPendingAt: workspaceConnection.revocationPendingAt,
      }).from(workspaceConnection).where(and(
        eq(workspaceConnection.organizationId, workspaceId),
        eq(workspaceConnection.providerIntegrationId, integrationId),
        eq(workspaceConnection.credentialMode, "managed"),
      )).limit(MAX_PROVIDER_RESULTS + 1),
      db.select({
        connectionId: workspaceCredentialLease.connectionId,
        activeLeaseCount: count(),
      }).from(workspaceCredentialLease).where(and(
        eq(workspaceCredentialLease.organizationId, workspaceId),
        eq(workspaceCredentialLease.integrationId, integrationId),
        isNull(workspaceCredentialLease.revokedAt),
        gt(workspaceCredentialLease.expiresAt, now),
      )).groupBy(workspaceCredentialLease.connectionId).limit(MAX_PROVIDER_RESULTS + 1),
      listNeonBranchManagedAccessBoundaries({
        organizationId: workspaceId,
        integrationId,
        integrationGeneration: integration.generation,
        projectId,
      }),
    ]);
    if (
      connectionRows.length > MAX_PROVIDER_RESULTS
      || activeLeaseRows.length > MAX_PROVIDER_RESULTS
    ) {
      throw new ProviderRequestError(
        "neon",
        "Workspace Neon connection scope is too large to inspect safely",
        409,
      );
    }

    const activeLeases = new Map(
      activeLeaseRows.map((row) => [row.connectionId, row.activeLeaseCount]),
    );
    const managedAccessByBranch = new Map(
      branchBoundaries.map((boundary) => [boundary.branchId, {
        operationId: boundary.operationId,
        state: boundary.state,
        status: boundary.managedAccessState,
      }]),
    );
    const branchBoundaryById = new Map(
      branchBoundaries.map((boundary) => [boundary.branchId, boundary]),
    );
    const referencesByBranch = new Map<string, Array<{
      connectionId: string;
      connectionName: string;
      database: string;
      environment: string | null;
      allowWrites: boolean;
      contentRevision: number;
      authorityRevision: number;
      activeLeaseCount: number;
    }>>();
    const deletionReferencesByBranch = new Map<string, {
      connectionCount: number;
      activeLeaseCount: number;
    }>();
    const missingTargets: Array<{
      connectionId: string;
      connectionName: string;
      branchId: string;
      database: string;
      contentRevision: number;
      reason: "branch_missing";
    }> = [];
    const liveBranchIds = new Set(inventory.branches.map((branch) => branch.id));
    for (const row of connectionRows) {
      if (
        !isSafeDisplayText(row.name, 120)
        || (row.environment !== null && !isSafeDisplayText(row.environment, 32))
      ) {
        throw new ProviderRequestError(
          "neon",
          "Workspace Neon connection metadata is invalid",
          409,
        );
      }
      let resource;
      try {
        resource = parseNeonResource(row.resource);
      } catch {
        throw new ProviderRequestError(
          "neon",
          "Workspace Neon connection target is invalid",
          409,
        );
      }
      if (resource.project !== projectId) continue;
      const deletionReferences = deletionReferencesByBranch.get(resource.branch) ?? {
        connectionCount: 0,
        activeLeaseCount: 0,
      };
      if (row.deletedAt === null) deletionReferences.connectionCount += 1;
      deletionReferences.activeLeaseCount += activeLeases.get(row.id) ?? 0;
      deletionReferencesByBranch.set(resource.branch, deletionReferences);
      if (row.deletedAt !== null || row.revocationPendingAt !== null) continue;
      if (!liveBranchIds.has(resource.branch)) {
        missingTargets.push({
          connectionId: row.id,
          connectionName: row.name,
          branchId: resource.branch,
          database: resource.database,
          contentRevision: row.contentRevision,
          reason: "branch_missing",
        });
        continue;
      }
      const references = referencesByBranch.get(resource.branch) ?? [];
      references.push({
        connectionId: row.id,
        connectionName: row.name,
        database: resource.database,
        environment: row.environment,
        allowWrites: row.allowWrites,
        contentRevision: row.contentRevision,
        authorityRevision: row.authorityRevision,
        activeLeaseCount: activeLeases.get(row.id) ?? 0,
      });
      referencesByBranch.set(resource.branch, references);
    }
    for (const references of referencesByBranch.values()) {
      references.sort((left, right) => (
        left.connectionName < right.connectionName
          ? -1
          : left.connectionName === right.connectionName
            ? left.connectionId < right.connectionId ? -1 : 1
            : 1
      ));
    }
    missingTargets.sort((left, right) => (
      left.connectionName < right.connectionName
        ? -1
        : left.connectionName === right.connectionName
          ? left.connectionId < right.connectionId ? -1 : 1
          : 1
    ));

    if (!await revalidateProviderDiscoveryAuthority(authority)) {
      return jsonError("Workspace access denied", 403);
    }
    return privateJson({
      projectId,
      integrationGeneration: integration.generation.toString(),
      observedAt: new Date().toISOString(),
      rootIds: inventory.rootIds,
      branches: inventory.branches.map((branch) => {
        const connections = referencesByBranch.get(branch.id) ?? [];
        const deletionReferences = deletionReferencesByBranch.get(branch.id) ?? {
          connectionCount: 0,
          activeLeaseCount: 0,
        };
        const boundary = branchBoundaryById.get(branch.id);
        const deletionBlockerCodes: string[] = [];
        if (boundary) {
          if (boundary.state !== "succeeded") {
            deletionBlockerCodes.push("CREATE_OPERATION_INCOMPLETE");
          }
          if (!branch.ready || branch.currentState !== "ready" || branch.pendingState) {
            deletionBlockerCodes.push("BRANCH_NOT_READY");
          }
          if (branch.treeParentId === null) deletionBlockerCodes.push("ROOT_BRANCH");
          if (branch.default) deletionBlockerCodes.push("DEFAULT_BRANCH");
          if (branch.protected) deletionBlockerCodes.push("PROTECTED_BRANCH");
          if (inventory.branches.some((candidate) => candidate.treeParentId === branch.id)) {
            deletionBlockerCodes.push("CHILD_BRANCHES");
          }
          if (deletionReferences.connectionCount > 0) {
            deletionBlockerCodes.push("WORKSPACE_CONNECTIONS");
          }
          if (deletionReferences.activeLeaseCount > 0) {
            deletionBlockerCodes.push("ACTIVE_LEASES");
          }
          if (branch.restrictedActions.length > 0) {
            deletionBlockerCodes.push("PROVIDER_RESTRICTED");
          }
        }
        return {
          ...branch,
          ...(managedAccessByBranch.has(branch.id)
            ? { managedAccess: managedAccessByBranch.get(branch.id) }
            : {}),
          ...(boundary
            ? {
              deletion: {
                canPlan: deletionBlockerCodes.length === 0,
                blockerCodes: deletionBlockerCodes,
              },
            }
            : {}),
          connections,
        };
      }),
      missingTargets,
    });
  } catch (error) {
    if (error instanceof ProviderRequestError) {
      return jsonError(error.message, error.status);
    }
    return jsonError("Neon branch inventory failed", 502);
  }
}
