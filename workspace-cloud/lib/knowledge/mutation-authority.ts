// Knowledge writes revalidate their route authority in the same PostgreSQL
// statement that changes durable state. This closes the interval between an
// HTTP authorization check and a later write after provider or GitHub I/O.
import "server-only";

import { sql } from "drizzle-orm";

import { revocationGateLockKey } from "../revocation-gates";
import { member, session, workspaceProfile } from "../schema";
import type {
  WorkspaceCapability,
  WorkspaceRoleName,
} from "../workspace-permissions";

export type KnowledgeMutationAuthority = {
  organizationId: string;
  membershipId: string;
  userId: string;
  sessionId: string;
  role: WorkspaceRoleName;
  capability: WorkspaceCapability;
  subject?: { membershipId: string; userId: string };
};

type RouteAuthorization = {
  session: {
    session: { id: string };
    user: { id: string };
  };
  membership: { id: string };
  role: WorkspaceRoleName;
};

export function knowledgeMutationAuthority(
  authorization: RouteAuthorization,
  organizationId: string,
  capability: WorkspaceCapability,
): KnowledgeMutationAuthority {
  return {
    organizationId,
    membershipId: authorization.membership.id,
    userId: authorization.session.user.id,
    sessionId: authorization.session.session.id,
    role: authorization.role,
    capability,
  };
}

function permittedRoles(capability: WorkspaceCapability) {
  switch (capability) {
    case "view":
      return sql`'viewer', 'analyst', 'editor', 'admin', 'owner'`;
    case "read":
      return sql`'analyst', 'editor', 'admin', 'owner'`;
    case "write":
      return sql`'editor', 'admin', 'owner'`;
    case "manage":
      return sql`'admin', 'owner'`;
    case "delete":
      return sql`'owner'`;
  }
}

// The member advisory lock is deliberately identical to the revocation-gate
// lock. A revocation that wins first makes this predicate false; a Knowledge
// write that wins first commits before revocation can become durable.
export function knowledgeMutationAuthoritySql(
  input: KnowledgeMutationAuthority,
  organizationId: string,
) {
  const actorLockKey = revocationGateLockKey({
    kind: "member",
    organizationId: input.organizationId,
    memberId: input.membershipId,
    userId: input.userId,
  });
  const subjectLockKey = input.subject && input.subject.userId !== input.userId
    ? revocationGateLockKey({
        kind: "member",
        organizationId: input.organizationId,
        memberId: input.subject.membershipId,
        userId: input.subject.userId,
      })
    : null;
  const lockKeys = subjectLockKey
    ? [actorLockKey, subjectLockKey].sort()
    : [actorLockKey];
  const subjectGuard = input.subject ? sql`
      AND EXISTS (
        SELECT 1 FROM ${member} AS guarded_member
        WHERE guarded_member."id" = ${input.subject.membershipId}
          AND guarded_member."organization_id" = ${input.organizationId}
          AND guarded_member."user_id" = ${input.subject.userId}
          AND guarded_member."revocation_pending_at" IS NULL
          AND guarded_member."revocation_claim_id" IS NULL
        FOR UPDATE OF guarded_member
      )` : sql``;
  return sql`EXISTS (
    SELECT 1
    FROM (
      SELECT count(*) AS lock_count
      FROM (
        SELECT pg_advisory_xact_lock(hashtextextended(lock_key, 0))
        FROM (
          SELECT lock_key
          FROM (VALUES ${sql.join(lockKeys.map((lockKey) => sql`
            (${lockKey}::text)
          `), sql`, `)}) AS requested_lock(lock_key)
          ORDER BY lock_key
        ) AS ordered_lock
      ) AS acquired_lock
    ) AS member_gate
    JOIN ${session} AS live_session ON TRUE
    JOIN ${member} AS live_member
      ON live_member."id" = ${input.membershipId}
     AND live_member."organization_id" = ${input.organizationId}
     AND live_member."user_id" = ${input.userId}
    JOIN ${workspaceProfile} AS live_workspace
      ON live_workspace."organization_id" = live_member."organization_id"
    WHERE live_session."id" = ${input.sessionId}
      AND ${input.organizationId} = ${organizationId}
      AND live_session."user_id" = ${input.userId}
      AND live_session."expires_at" > now()
      AND live_member."role" = ${input.role}
      AND live_member."role" IN (${permittedRoles(input.capability)})
      AND live_member."revocation_pending_at" IS NULL
      AND live_member."revocation_claim_id" IS NULL
      AND live_workspace."lifecycle_state" = 'active'
      ${subjectGuard}
    FOR UPDATE OF live_session, live_member, live_workspace
  )`;
}
