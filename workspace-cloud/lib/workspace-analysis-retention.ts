// Retire expired shared result bytes without erasing immutable run receipts.
// Articles whose last-good payload expired stop advertising that run until a
// Desktop runner produces another compatible result.
import "server-only";

import { sql } from "drizzle-orm";

import { db } from "./db";
import {
  workspaceAnalysisArticle,
  workspaceAnalysisResultFragment,
} from "./schema";

export async function cleanupExpiredAnalysisResults(limit = 500) {
  const bounded = Math.max(1, Math.min(limit, 2_000));
  const result = await db.execute<Record<string, unknown>>(sql`
    WITH expired AS MATERIALIZED (
      SELECT fragment."id", fragment."organization_id", fragment."run_id"
      FROM ${workspaceAnalysisResultFragment} fragment
      WHERE fragment."expires_at" <= now()
      ORDER BY fragment."expires_at" ASC
      LIMIT ${bounded}
      FOR UPDATE SKIP LOCKED
    ), deleted AS MATERIALIZED (
      DELETE FROM ${workspaceAnalysisResultFragment} fragment
      USING expired
      WHERE fragment."id" = expired."id"
      RETURNING expired."organization_id", expired."run_id"
    ), unavailable AS MATERIALIZED (
      UPDATE ${workspaceAnalysisArticle} article SET
        "live_run_id" = NULL,
        "updated_at" = now()
      WHERE (article."organization_id", article."live_run_id") IN (
        SELECT DISTINCT deleted."organization_id", deleted."run_id" FROM deleted
      )
        AND NOT EXISTS (
          SELECT 1 FROM ${workspaceAnalysisResultFragment} remaining
          WHERE remaining."organization_id" = article."organization_id"
            AND remaining."run_id" = article."live_run_id"
            AND remaining."expires_at" > now()
        )
      RETURNING article."id"
    )
    SELECT (SELECT count(*) FROM deleted) AS "deleted",
      (SELECT count(*) FROM unavailable) AS "articlesUnavailable"
  `);
  return {
    deleted: Number(result.rows[0]?.deleted ?? 0),
    articlesUnavailable: Number(result.rows[0]?.articlesUnavailable ?? 0),
  };
}
