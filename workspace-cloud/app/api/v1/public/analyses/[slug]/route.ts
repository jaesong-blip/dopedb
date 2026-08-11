// Public fixed Analysis Article snapshot. This route has no workspace/session
// projection and returns only the prevalidated safe snapshot.
import { and, eq, isNull, sql } from "drizzle-orm";

import { db } from "../../../../../../lib/db";
import { jsonError } from "../../../../../../lib/http";
import { rateLimit, workspaceAnalysisPublication } from "../../../../../../lib/schema";
import { parseAnalysisPublicSnapshot } from "../../../../../../lib/workspace-analysis-publications";
import { canonicalHash } from "../../../../../../lib/workspace-versioning";

type RouteContext = { params: Promise<{ slug: string }> };

const SLUG = /^[a-z0-9][a-z0-9-]{7,127}$/;

async function consumePublicBudget(request: Request) {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || request.headers.get("x-real-ip")?.trim() || "unknown";
  const key = `public-analysis:${canonicalHash({ forwarded })}`;
  const now = Date.now();
  const result = await db.execute<{ value: number }>(sql`
    INSERT INTO ${rateLimit} ("id", "key", "count", "last_request")
    VALUES (${crypto.randomUUID()}, ${key}, 1, ${now})
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE WHEN ${rateLimit.lastRequest} < ${now - 60_000}
        THEN 1 ELSE ${rateLimit.count} + 1 END,
      "last_request" = ${now}
    RETURNING "count" AS "value"
  `);
  return Number(result.rows[0]?.value ?? Number.POSITIVE_INFINITY) <= 120;
}

export async function GET(request: Request, context: RouteContext) {
  const { slug } = await context.params;
  if (!SLUG.test(slug)) return jsonError("Analysis Article not found", 404);
  if (!await consumePublicBudget(request)) {
    return jsonError("Too many requests", 429);
  }
  const publication = await db.query.workspaceAnalysisPublication.findFirst({
    where: and(
      eq(workspaceAnalysisPublication.slug, slug),
      isNull(workspaceAnalysisPublication.revokedAt),
    ),
  });
  if (!publication || canonicalHash(publication.snapshot) !== publication.snapshotHash) {
    return jsonError("Analysis Article not found", 404);
  }
  try {
    const article = parseAnalysisPublicSnapshot(publication.snapshot);
    return Response.json({
      publication: {
        slug: publication.slug,
        version: publication.version,
        visibility: publication.visibility,
        publishedAt: publication.publishedAt.toISOString(),
        snapshotHash: publication.snapshotHash,
      },
      article,
    }, {
      headers: {
        "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
        "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
        "X-Content-Type-Options": "nosniff",
        "X-Robots-Tag": article.searchIndexable ? "index, follow" : "noindex, nofollow, noarchive",
      },
    });
  } catch {
    return jsonError("Analysis Article not found", 404);
  }
}
