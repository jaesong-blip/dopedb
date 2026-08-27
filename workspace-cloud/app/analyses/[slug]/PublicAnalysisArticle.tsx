import type { AnalysisPublicSnapshot } from "../../../lib/workspace-analysis-publications";

export function AnalysisArticleDocument({
  article,
  eyebrow = "Analysis Article",
  resultLabel = "Published HTML",
}: {
  article: AnalysisPublicSnapshot;
  eyebrow?: string;
  resultLabel?: string;
}) {
  return (
    <article
      className="tw:mx-auto tw:grid tw:w-full tw:max-w-[900px] tw:gap-8"
      data-analysis-publication-snapshot
    >
      <header className="tw:grid tw:gap-4 tw:border-b tw:border-border tw:pb-8">
        <span className="tw:font-mono tw:text-2xs tw:font-semibold tw:tracking-[0.09em] tw:text-primary tw:uppercase">
          {eyebrow}
        </span>
        <h1 className="tw:font-serif tw:text-[clamp(2.6rem,7vw,5.8rem)] tw:font-medium tw:leading-[0.94] tw:tracking-[-0.045em]">
          {article.title}
        </h1>
        <div className="tw:flex tw:flex-wrap tw:gap-2 tw:text-xs tw:text-muted-foreground">
          <span className="tw:rounded-full tw:border tw:border-border tw:px-2.5 tw:py-1">{resultLabel}</span>
          <time className="tw:rounded-full tw:border tw:border-border tw:px-2.5 tw:py-1" dateTime={article.publishedAt}>
            {new Date(article.publishedAt).toLocaleString()}
          </time>
        </div>
      </header>
      <div
        className="tw:grid tw:gap-4 tw:text-base tw:leading-relaxed tw:[&_a]:text-primary tw:[&_a]:underline tw:[&_blockquote]:border-l-2 tw:[&_blockquote]:border-border tw:[&_blockquote]:pl-4 tw:[&_code]:font-mono tw:[&_h2]:font-serif tw:[&_h2]:text-3xl tw:[&_h2]:font-medium tw:[&_h3]:text-xl tw:[&_h3]:font-semibold tw:[&_h4]:text-base tw:[&_h4]:font-semibold tw:[&_ol]:pl-6 tw:[&_p]:m-0 tw:[&_pre]:overflow-auto tw:[&_pre]:rounded-surface tw:[&_pre]:bg-surface-inset tw:[&_pre]:p-4 tw:[&_table]:w-full tw:[&_table]:border-collapse tw:[&_td]:border tw:[&_td]:border-border tw:[&_td]:p-2 tw:[&_th]:border tw:[&_th]:border-border tw:[&_th]:p-2 tw:[&_ul]:pl-6"
        // Workspace Cloud sanitized this immutable string with a closed tag and
        // attribute allowlist before it entered the publication snapshot.
        dangerouslySetInnerHTML={{ __html: article.html }}
      />
    </article>
  );
}

export function PublicAnalysisArticle({ article }: { article: AnalysisPublicSnapshot }) {
  return <AnalysisArticleDocument article={article} />;
}
