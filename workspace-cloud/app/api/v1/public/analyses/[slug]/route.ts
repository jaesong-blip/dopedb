// Public fixed Analysis Article snapshot. This route has no workspace/session
// projection and returns only the prevalidated safe snapshot.
import { jsonError, privateJsonStream } from "../../../../../../lib/http";
import {
  consumePublicAnalysisBudget,
  loadPublicAnalysisPublication,
} from "../../../../../../lib/public-analysis-publication";
import { forwardedClientKey } from "../../../../../../lib/rate-limit";

type RouteContext = { params: Promise<{ slug: string }> };

export async function GET(request: Request, context: RouteContext) {
  const { slug } = await context.params;
  if (!await consumePublicAnalysisBudget(forwardedClientKey(request.headers))) {
    return jsonError("Too many requests", 429);
  }
  const publication = await loadPublicAnalysisPublication(slug);
  if (!publication) return jsonError("Analysis Article not found", 404);
  const { article } = publication;
  return privateJsonStream({
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
        // Revocation is an immediate access boundary. A browser or shared cache
        // must not retain a previously authorized snapshot after its slug is
        // revoked, even if the server-side route cache is revalidated.
        "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
        "X-Content-Type-Options": "nosniff",
        "X-Robots-Tag": article.searchIndexable ? "index, follow" : "noindex, nofollow, noarchive",
      },
    });
}
