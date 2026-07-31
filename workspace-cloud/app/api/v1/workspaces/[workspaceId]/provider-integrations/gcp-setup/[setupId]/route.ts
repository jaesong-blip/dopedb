// Session-bound Google Cloud setup inventory and bootstrap boundary. The opaque
// setup id never authorizes access by itself; membership and user are rechecked.
import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "../../../../../../../../lib/db";
import { env } from "../../../../../../../../lib/env";
import {
  isUuid,
  jsonError,
  mutationAllowed,
  privateJson,
} from "../../../../../../../../lib/http";
import {
  bootstrapGcpCloudSql,
  checkGcpSetupPermissions,
  grantTemporaryGcpSetupPermissions,
  revokeTemporaryGcpSetupPermissions,
  type GcpTemporaryPermissionGrant,
} from "../../../../../../../../lib/providers/gcp-cloud-bootstrap";
import {
  listGcpOAuthInstances,
  listGcpOAuthProjects,
  type GcpSetupCredential,
} from "../../../../../../../../lib/providers/gcp-cloud-oauth";
import { vercelOidcToken } from "../../../../../../../../lib/providers/gcp-cloud-sql";
import { ProviderRequestError } from "../../../../../../../../lib/providers/provider-types";
import {
  openProviderSetupCredential,
  sealProviderBootstrapTicket,
} from "../../../../../../../../lib/secret-envelope";
import { providerSetupSession } from "../../../../../../../../lib/schema";
import { authorizeWorkspace } from "../../../../../../../../lib/workspace-authorization";

type RouteContext = {
  params: Promise<{ workspaceId: string; setupId: string }>;
};

export const maxDuration = 300;

async function setupCredential(
  workspaceId: string,
  setupId: string,
  userId: string,
) {
  const row = await db.query.providerSetupSession.findFirst({
    where: and(
      eq(providerSetupSession.id, setupId),
      eq(providerSetupSession.organizationId, workspaceId),
      eq(providerSetupSession.userId, userId),
      eq(providerSetupSession.provider, "gcpCloudSql"),
      gt(providerSetupSession.expiresAt, new Date()),
      isNull(providerSetupSession.consumedAt),
    ),
    columns: {
      encryptedCredential: true,
      accountLabel: true,
      expiresAt: true,
    },
  });
  if (!row) return null;
  return {
    ...row,
    credential: openProviderSetupCredential<GcpSetupCredential>(
      setupId,
      row.encryptedCredential,
    ),
  };
}

export async function GET(request: Request, context: RouteContext) {
  const { workspaceId, setupId } = await context.params;
  if (!isUuid(workspaceId) || !isUuid(setupId)) {
    return jsonError("Invalid workspace or setup id", 400);
  }
  const authorization = await authorizeWorkspace(request, workspaceId, "manage");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  const setup = await setupCredential(
    workspaceId,
    setupId,
    authorization.session.user.id,
  );
  if (!setup) return jsonError("Google Cloud setup session expired", 410);
  const query = new URL(request.url).searchParams;
  const kind = query.get("kind") ?? "projects";
  try {
    if (kind === "projects") {
      const projects = await listGcpOAuthProjects(setup.credential);
      return privateJson({
        account: setup.accountLabel,
        expiresAt: setup.expiresAt.toISOString(),
        projects,
      });
    }
    if (kind === "instances") {
      const project = query.get("project") ?? "";
      const instances = await listGcpOAuthInstances(setup.credential, project);
      return privateJson({
        account: setup.accountLabel,
        expiresAt: setup.expiresAt.toISOString(),
        instances,
      });
    }
    if (kind === "permissions") {
      const projectId = query.get("project") ?? "";
      const projects = await listGcpOAuthProjects(setup.credential);
      if (!projects.some((project) => project.id === projectId)) {
        return jsonError("Google Cloud project is no longer available", 409);
      }
      return privateJson({
        permissions: await checkGcpSetupPermissions(
          setup.credential,
          projectId,
        ),
      });
    }
    return jsonError("Invalid Google Cloud setup query", 400);
  } catch (error) {
    if (error instanceof ProviderRequestError) {
      return jsonError(error.message, error.status);
    }
    return jsonError("Google Cloud resource discovery failed", 502);
  }
}

export async function POST(request: Request, context: RouteContext) {
  if (!mutationAllowed(request, env.appOrigin())) {
    return jsonError("Invalid request origin", 403);
  }
  const { workspaceId, setupId } = await context.params;
  if (!isUuid(workspaceId) || !isUuid(setupId)) {
    return jsonError("Invalid workspace or setup id", 400);
  }
  const authorization = await authorizeWorkspace(request, workspaceId, "manage");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  const setup = await setupCredential(
    workspaceId,
    setupId,
    authorization.session.user.id,
  );
  if (!setup) return jsonError("Google Cloud setup session expired", 410);
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (
    !body
    || typeof body.projectId !== "string"
    || typeof body.projectNumber !== "string"
    || typeof body.instanceId !== "string"
    || !(
      body.environmentClassification === null
      || body.environmentClassification === "production"
      || body.environmentClassification === "development"
    )
    || typeof body.approveProduction !== "boolean"
    || typeof body.approveInstanceRestart !== "boolean"
    || typeof body.approveIamRoleGrant !== "boolean"
  ) {
    return jsonError("Invalid Google Cloud setup request", 400);
  }
  const oidcToken = vercelOidcToken(request);
  if (!oidcToken) {
    return jsonError("Vercel OIDC is not enabled for this deployment", 503);
  }
  let temporaryGrant: GcpTemporaryPermissionGrant | null = null;
  try {
    const projects = await listGcpOAuthProjects(setup.credential);
    const project = projects.find((item) => item.id === body.projectId);
    if (!project || project.number !== body.projectNumber) {
      return jsonError("Google Cloud project identity changed during setup", 409);
    }
    const permissionCheck = await checkGcpSetupPermissions(
      setup.credential,
      body.projectId,
    );
    if (permissionCheck.missing.length > 0 && !body.approveIamRoleGrant) {
      return privateJson({
        error: "Google Cloud 자동 설정에 필요한 권한을 확인하세요.",
        code: "gcp_setup_permissions_required",
        permissions: permissionCheck,
      }, { status: 409 });
    }
    if (permissionCheck.missing.length > 0) {
      temporaryGrant = await grantTemporaryGcpSetupPermissions({
        credential: setup.credential,
        projectId: body.projectId,
        setupId,
        check: permissionCheck,
      });
    }
    const result = await bootstrapGcpCloudSql({
      credential: setup.credential,
      oidcToken,
      configuration: {
        workspaceId,
        projectId: body.projectId,
        projectNumber: body.projectNumber,
        instanceId: body.instanceId,
        environmentClassification: body.environmentClassification,
        // Shared managed connections deliberately issue read-only leases.
        writeAccess: false,
        approveProduction: body.approveProduction,
        approveInstanceRestart: body.approveInstanceRestart,
      },
    });
    if (temporaryGrant) {
      await revokeTemporaryGcpSetupPermissions(
        setup.credential,
        temporaryGrant,
      );
      temporaryGrant = null;
    }
    return privateJson({
      bootstrapTicket: sealProviderBootstrapTicket(
        setupId,
        {
          configuration: result.configuration,
          production: result.production,
        },
      ),
      engine: result.engine,
      production: result.production,
      iamAuthenticationChanged: result.iamAuthenticationChanged,
      databaseUsers: result.databaseUsers,
    });
  } catch (error) {
    if (temporaryGrant) {
      try {
        await revokeTemporaryGcpSetupPermissions(
          setup.credential,
          temporaryGrant,
        );
      } catch {
        return jsonError(
          "임시 Google Cloud 설정 권한을 바로 제거하지 못했습니다. 해당 권한은 15분 뒤 자동 만료됩니다.",
          409,
        );
      }
    }
    if (error instanceof ProviderRequestError) {
      return jsonError(error.message, error.status);
    }
    return jsonError("Google Cloud setup failed", 502);
  }
}
