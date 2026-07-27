import { jsonError, privateJson } from "../../../../lib/http";
import { authoritativeSession } from "../../../../lib/authoritative-session";

export async function GET(request: Request) {
  const session = await authoritativeSession(request);
  if (!session) return jsonError("Unauthorized", 401);
  return privateJson({
    user: { id: session.user.id, email: session.user.email, displayName: session.user.name },
    session: { id: session.session.id, activeWorkspaceId: session.session.activeOrganizationId },
  });
}
