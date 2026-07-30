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
    || typeof body.approveProduction !== "boolean"
    || typeof body.approveInstanceRestart !== "boolean"
  ) {
    return jsonError("Invalid Google Cloud setup request", 400);
  }
  const oidcToken = vercelOidcToken(request);
  if (!oidcToken) {
    return jsonError("Vercel OIDC is not enabled for this deployment", 503);
  }
  try {
    const result = await bootstrapGcpCloudSql({
      credential: setup.credential,
      oidcToken,
      configuration: {
        workspaceId,
        projectId: body.projectId,
        projectNumber: body.projectNumber,
        instanceId: body.instanceId,
        // Shared managed connections deliberately issue read-only leases.
        writeAccess: false,
        approveProduction: body.approveProduction,
        approveInstanceRestart: body.approveInstanceRestart,
      },
    });
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
    if (error instanceof ProviderRequestError) {
      return jsonError(error.message, error.status);
    }
    return jsonError("Google Cloud setup failed", 502);
  }
}
