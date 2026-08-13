import { and, eq, inArray, isNull } from "drizzle-orm";
import { auth } from "../../../../lib/auth";
import { authoritativeSession } from "../../../../lib/authoritative-session";
import { db } from "../../../../lib/db";
import { env } from "../../../../lib/env";
import {
  boundedJsonBody,
  isSafeDisplayText,
  jsonError,
  mutationAllowed,
  privateJson,
} from "../../../../lib/http";
import { acceptPendingWorkspaceInvitations } from "../../../../lib/pending-invitations";
import {
  isPersonalKnowledgeMetadata,
  isPersonalKnowledgeOrganization,
} from "../../../../lib/knowledge/personal-scope";
import { member, workspaceProfile } from "../../../../lib/schema";

export async function GET(request: Request) {
  const session = await authoritativeSession(request);
  if (!session) return jsonError("Unauthorized", 401);
  await acceptPendingWorkspaceInvitations({
    api: auth.api,
    headers: request.headers,
    user: session.user,
    activeOrganizationId: session.session.activeOrganizationId,
  });
  const workspaces = await auth.api.listOrganizations({ headers: request.headers });
  const roles = workspaces.length > 0
    ? await db.select({ organizationId: member.organizationId, role: member.role })
        .from(member)
        .innerJoin(
          workspaceProfile,
          eq(workspaceProfile.organizationId, member.organizationId),
        )
        .where(and(
          eq(member.userId, session.user.id),
          inArray(member.organizationId, workspaces.map((workspace) => workspace.id)),
          isNull(member.revocationPendingAt),
          eq(workspaceProfile.lifecycleState, "active"),
        ))
    : [];
  const roleByWorkspace = new Map(roles.map((membership) => [
    membership.organizationId,
    membership.role,
  ]));
  return privateJson({
    workspaces: workspaces.filter((workspace) => (
      roleByWorkspace.has(workspace.id)
      && !isPersonalKnowledgeOrganization(session.user.id, workspace.id)
      && !isPersonalKnowledgeMetadata(workspace.metadata)
    )).map((workspace) => ({
      ...workspace,
      role: roleByWorkspace.get(workspace.id) ?? "viewer",
    })),
  });
}

export async function POST(request: Request) {
  if (!mutationAllowed(request, env.appOrigin())) return jsonError("Invalid request origin", 403);
  const session = await authoritativeSession(request);
  if (!session) return jsonError("Unauthorized", 401);
  const parsed = await boundedJsonBody(request, 1_024);
  if (!parsed.ok) {
    return jsonError(
      parsed.reason === "too_large" ? "Workspace request is too large" : "Invalid workspace request",
      parsed.reason === "too_large" ? 413 : 400,
    );
  }
  const body = parsed.value as { name?: string } | null;
  const name = body?.name?.trim();
  if (!name || !isSafeDisplayText(name, 120)) {
    return jsonError("Workspace name must be 1–120 single-line characters", 400);
  }
  const base = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || "workspace";
  const slug = `${base}-${crypto.randomUUID().slice(0, 8)}`;
  const workspace = await auth.api.createOrganization({
    headers: request.headers,
    body: { name, slug },
  });
  return privateJson({ workspace }, { status: 201 });
}
