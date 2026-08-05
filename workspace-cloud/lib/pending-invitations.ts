// Reconcile email-bound Better Auth invitations at the first authenticated
// workspace read. Google is the only identity provider and supplies a verified
// email, so an invite can be accepted without requiring its link as a second step.
import "server-only";

import { and, eq, inArray } from "drizzle-orm";

import { db } from "./db";
import { invitation, workspaceProfile } from "./schema";

type PendingInvitation = {
  id: string;
  status: string;
  expiresAt: Date | string;
};

type InvitationAuthApi = {
  listUserInvitations: (input: {
    query: { email: string };
  }) => Promise<PendingInvitation[]>;
  acceptInvitation: (input: {
    body: { invitationId: string };
    headers: Headers;
  }) => Promise<unknown>;
  setActiveOrganization: (input: {
    body: { organizationId: string };
    headers: Headers;
  }) => Promise<unknown>;
};

type ReconcilePendingInvitationsInput = {
  api: InvitationAuthApi;
  headers: Headers;
  user: {
    email: string;
    emailVerified: boolean;
  };
  activeOrganizationId?: string | null;
  now?: Date;
};

export type InvitationReconciliation = {
  accepted: number;
  failed: number;
};

export async function acceptPendingWorkspaceInvitations({
  api,
  headers,
  user,
  activeOrganizationId,
  now = new Date(),
}: ReconcilePendingInvitationsInput): Promise<InvitationReconciliation> {
  const email = user.email.trim().toLowerCase();
  if (!user.emailVerified || email.length === 0) {
    return { accepted: 0, failed: 0 };
  }

  const invitations = await api.listUserInvitations({ query: { email } });
  const pendingInvitationIds = [
    ...new Set(
      invitations
        .filter((item) => (
          item.status === "pending" &&
          new Date(item.expiresAt).getTime() > now.getTime()
        ))
        .map((item) => item.id),
    ),
  ];
  const eligible = pendingInvitationIds.length > 0
    ? await db.select({ id: invitation.id }).from(invitation).innerJoin(
        workspaceProfile,
        eq(workspaceProfile.organizationId, invitation.organizationId),
      ).where(and(
        inArray(invitation.id, pendingInvitationIds),
        eq(invitation.status, "pending"),
        eq(workspaceProfile.lifecycleState, "active"),
      ))
    : [];
  const invitationIds = eligible.map((item) => item.id);

  let accepted = 0;
  let failed = 0;
  for (const invitationId of invitationIds) {
    try {
      await api.acceptInvitation({
        body: { invitationId },
        headers,
      });
      accepted += 1;
    } catch {
      // Another concurrent request may have accepted the same invitation. A
      // later workspace read will retry genuine transient failures.
      failed += 1;
    }
  }

  // Better Auth makes each accepted organization active. Preserve an existing
  // user choice after reconciliation instead of switching workspaces implicitly.
  if (accepted > 0 && activeOrganizationId) {
    try {
      await api.setActiveOrganization({
        body: { organizationId: activeOrganizationId },
        headers,
      });
    } catch {
      // Membership acceptance has already succeeded and must not be rolled back
      // merely because the prior active-workspace preference could not be reset.
    }
  }

  return { accepted, failed };
}
