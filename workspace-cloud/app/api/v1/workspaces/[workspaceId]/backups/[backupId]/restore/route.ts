// Restore is additive and conflict-preserving: it never overwrites a current
// connection projection. Existing ids receive immutable restore candidates instead.
import { and, eq } from "drizzle-orm";
import { timingSafeEqual } from "node:crypto";

import { db } from "../../../../../../../../lib/db";
import { env } from "../../../../../../../../lib/env";
import { isUuid, jsonError, mutationAllowed, privateJson } from "../../../../../../../../lib/http";
import { workspaceMetadataBackup } from "../../../../../../../../lib/schema";
import {
  openWorkspaceMetadataBackup,
  snapshotHash,
  WORKSPACE_BACKUP_KEY_REFERENCE,
  WORKSPACE_BACKUP_KEY_VERSION,
} from "../../../../../../../../lib/workspace-backup";
import { parseExpectedRevision } from "../../../../../../../../lib/workspace-versioning";
import { restoreWorkspaceSnapshot } from "../../../../../../../../lib/workspace-versioning-store";
import { authorizeWorkspace } from "../../../../../../../../lib/workspace-authorization";

type RouteContext = { params: Promise<{ workspaceId: string; backupId: string }> };

function sameHash(left: string, right: string) {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export async function POST(request: Request, context: RouteContext) {
  if (!mutationAllowed(request, env.appOrigin())) return jsonError("Invalid request origin", 403);
  const { workspaceId, backupId } = await context.params;
  if (!isUuid(workspaceId) || !isUuid(backupId)) return jsonError("Invalid workspace or backup id", 400);
  const authorization = await authorizeWorkspace(request, workspaceId, "manage");
  if (!authorization.ok) return jsonError(authorization.error, authorization.status);
  if (authorization.role !== "admin" && authorization.role !== "owner") {
    return jsonError("Workspace access denied", 403);
  }
  let expectedRevision: number | null;
  try {
    expectedRevision = parseExpectedRevision(request);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Invalid If-Match", 400);
  }
  if (expectedRevision === null) return jsonError("If-Match is required", 428);
  const backup = await db.query.workspaceMetadataBackup.findFirst({
    where: and(
      eq(workspaceMetadataBackup.id, backupId),
      eq(workspaceMetadataBackup.organizationId, workspaceId),
    ),
  });
  if (!backup || backup.deletedAt) return jsonError("Backup not found", 404);
  if (
    backup.keyReference !== WORKSPACE_BACKUP_KEY_REFERENCE
    || backup.keyVersion !== WORKSPACE_BACKUP_KEY_VERSION
  ) return jsonError("Backup integrity validation failed", 409);
  let snapshot;
  try {
    snapshot = openWorkspaceMetadataBackup(workspaceId, backupId, backup.ciphertext);
    if (
      snapshot.workspace.revision !== backup.sourceRevision
      || !sameHash(snapshotHash(snapshot), backup.snapshotHash)
    ) throw new Error("Backup integrity validation failed");
  } catch {
    return jsonError("Backup integrity validation failed", 409);
  }
  const restored = await restoreWorkspaceSnapshot({
    organizationId: workspaceId,
    backupId,
    expectedRevision,
    sourceRevision: backup.sourceRevision,
    authority: {
      sessionId: authorization.session.session.id,
      userId: authorization.session.user.id,
      membershipId: authorization.membership.id,
      role: authorization.role,
    },
    snapshot,
  });
  if (!restored) return jsonError("Workspace metadata changed concurrently. Retry restore.", 409);
  return privateJson({ restored: restored.restored, conflictIds: restored.conflictIds }, { status: 201 });
}
