import "server-only";

import { sql } from "drizzle-orm";
import { db } from "./db";
import { workspaceProviderDiscoveryReceipt } from "./schema";

const DISCOVERY_RECEIPT_CLEANUP_LIMIT = 50;
const CONSUMED_RECEIPT_REPLAY_GRACE_MINUTES = 10;

/**
 * Scheduled bounded reclamation. Recently consumed rows are retained for a
 * short retry window so a lost import response can still replay by the exact
 * idempotency key; expired and older consumed receipts are safe to remove.
 */
export async function cleanupProviderDiscoveryReceipts(
  organizationId?: string,
): Promise<number> {
  const result = await db.execute<{ deleted: number }>(sql`
    WITH candidates AS MATERIALIZED (
      SELECT receipt."id"
      FROM ${workspaceProviderDiscoveryReceipt} AS receipt
      WHERE (
          (
            receipt."consumed_at" IS NULL
            AND receipt."expires_at" <= clock_timestamp()
          )
          OR receipt."consumed_at" <= clock_timestamp()
            - (${CONSUMED_RECEIPT_REPLAY_GRACE_MINUTES} * interval '1 minute')
        )
        ${organizationId
          ? sql`AND receipt."organization_id" = ${organizationId}`
          : sql``}
      ORDER BY COALESCE(receipt."consumed_at", receipt."expires_at"),
               receipt."id"
      FOR UPDATE SKIP LOCKED
      LIMIT ${DISCOVERY_RECEIPT_CLEANUP_LIMIT}
    ), deleted AS (
      DELETE FROM ${workspaceProviderDiscoveryReceipt} AS receipt
      USING candidates
      WHERE receipt."id" = candidates."id"
      RETURNING receipt."id"
    )
    SELECT count(*)::int AS "deleted" FROM deleted
  `);
  return Number(result.rows[0]?.deleted ?? 0);
}
