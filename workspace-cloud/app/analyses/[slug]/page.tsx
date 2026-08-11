import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { and, eq, isNull } from "drizzle-orm";

import { Brand } from "../../components/Brand";
import { db } from "../../../lib/db";
import { workspaceAnalysisPublication } from "../../../lib/schema";
import { parseAnalysisPublicSnapshot } from "../../../lib/workspace-analysis-publications";
import { canonicalHash } from "../../../lib/workspace-versioning";
import { PublicAnalysisArticle } from "./PublicAnalysisArticle";

const SLUG = /^[a-z0-9][a-z0-9-]{7,127}$/;

const publication = cache(async (slug: string) => {
  if (!SLUG.test(slug)) return null;
  const row = await db.query.workspaceAnalysisPublication.findFirst({
    where: and(
      eq(workspaceAnalysisPublication.slug, slug),
      isNull(workspaceAnalysisPublication.revokedAt),
    ),
    columns: {
      snapshot: true,
      snapshotHash: true,
      publishedAt: true,
      visibility: true,
    },
  });
  if (!row || canonicalHash(row.snapshot) !== row.snapshotHash) return null;
  try {
    return { ...row, article: parseAnalysisPublicSnapshot(row.snapshot) };
  } catch {
    return null;
  }
});

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const result = await publication(slug);
  if (!result) return { title: "Analysis Article not found" };
  const index = result.visibility === "public" && result.article.searchIndexable;
  return {
    title: `${result.article.title} · DopeDB`,
    description: result.article.description || result.article.summary,
    robots: { index, follow: index },
    openGraph: {
      type: "article",
      title: result.article.title,
      description: result.article.description || result.article.summary,
      publishedTime: result.publishedAt.toISOString(),
    },
  };
}

export default async function AnalysisPublicationPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const result = await publication(slug);
  if (!result) notFound();
  return (
    <>
      <header className="tw:relative tw:z-[1] tw:border-b tw:border-border tw:bg-surface/90 tw:backdrop-blur-xl">
        <div className="tw:mx-auto tw:flex tw:min-h-control-lg tw:w-full tw:max-w-[1440px] tw:items-center tw:justify-between tw:px-6 tw:py-3 tw:max-[640px]:px-4">
          <Brand destination="marketing" />
          <span className="tw:font-mono tw:text-2xs tw:text-muted-foreground">Fixed public snapshot</span>
        </div>
      </header>
      <main id="main-content" className="tw:relative tw:z-[1] tw:mx-auto tw:w-full tw:max-w-[1440px] tw:px-6 tw:py-12 tw:max-[640px]:px-4 tw:max-[640px]:py-8">
        <PublicAnalysisArticle article={result.article} />
      </main>
      <footer className="tw:relative tw:z-[1] tw:mx-auto tw:flex tw:w-full tw:max-w-[1440px] tw:flex-wrap tw:items-center tw:justify-between tw:gap-2 tw:border-t tw:border-border tw:px-6 tw:py-6 tw:text-2xs tw:text-muted-foreground tw:max-[640px]:px-4">
        <span>Published {result.publishedAt.toLocaleString()}</span>
        <code>{result.snapshotHash}</code>
      </footer>
    </>
  );
}
