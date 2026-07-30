// Shared public legal-document layout. Policy pages keep their content in route
// files while this component owns the accessible navigation and reading width.
import Image from "next/image";
import Link from "next/link";
import { ArrowLeft, ExternalLink } from "lucide-react";

export type LegalSection = {
  title: string;
  paragraphs?: string[];
  items?: string[];
};

type LegalDocumentProps = {
  title: string;
  description: string;
  effectiveDate: string;
  sections: LegalSection[];
  lang: "en" | "ko";
  alternateHref: string;
  alternateLabel: string;
};

export function LegalDocument({
  title,
  description,
  effectiveDate,
  sections,
  lang,
  alternateHref,
  alternateLabel,
}: LegalDocumentProps) {
  const homeHref = lang === "ko" ? "/ko" : "/";

  return (
    <main
      lang={lang}
      className="tw:min-h-[100dvh] tw:bg-paper tw:px-4 tw:py-6 tw:text-ink tw:sm:px-6 tw:sm:py-10"
    >
      <div className="tw:mx-auto tw:max-w-[920px]">
        <nav
          aria-label={lang === "ko" ? "정책 문서 탐색" : "Policy navigation"}
          className="tw:flex tw:flex-wrap tw:items-center tw:justify-between tw:gap-3 tw:border-b tw:border-line tw:pb-5"
        >
          <Link
            href={homeHref}
            prefetch={false}
            className="tw:inline-flex tw:items-center tw:gap-3 tw:font-bold tw:text-ink"
          >
            <Image
              src="/oauth-logo-120.png"
              alt=""
              width={36}
              height={36}
              className="tw:size-9 tw:rounded-md"
            />
            <span>DopeDB</span>
          </Link>
          <div className="tw:flex tw:items-center tw:gap-2">
            <Link
              href={alternateHref}
              hrefLang={lang === "ko" ? "en" : "ko"}
              prefetch={false}
              className="tw:rounded-sm tw:border tw:border-line tw:bg-paper-raised tw:px-3 tw:py-2 tw:text-sm tw:font-semibold tw:text-ink-soft"
            >
              {alternateLabel}
            </Link>
            <Link
              href={homeHref}
              prefetch={false}
              className="tw:inline-flex tw:items-center tw:gap-2 tw:rounded-sm tw:border tw:border-line tw:px-3 tw:py-2 tw:text-sm tw:font-semibold tw:text-ink-soft"
            >
              <ArrowLeft size={16} aria-hidden="true" />
              {lang === "ko" ? "홈" : "Home"}
            </Link>
          </div>
        </nav>

        <header className="tw:border-b tw:border-line tw:py-12 tw:sm:py-16">
          <p className="tw:text-xs tw:font-bold tw:tracking-[0.08em] tw:text-brand-emphasis tw:uppercase">
            DopeDB · {lang === "ko" ? "공개 정책" : "Public policy"}
          </p>
          <h1 className="tw:mt-4 tw:max-w-[760px] tw:text-4xl tw:leading-tight tw:font-extrabold tw:tracking-[-0.03em] tw:sm:text-6xl">
            {title}
          </h1>
          <p className="tw:mt-5 tw:max-w-[720px] tw:text-base tw:leading-7 tw:text-ink-soft tw:sm:text-lg">
            {description}
          </p>
          <p className="tw:mt-6 tw:text-sm tw:font-semibold tw:text-muted">
            {lang === "ko" ? "시행일" : "Effective"}: {effectiveDate}
          </p>
        </header>

        <article className="tw:divide-y tw:divide-line">
          {sections.map((section, index) => (
            <section
              key={section.title}
              className="tw:grid tw:gap-5 tw:py-9 tw:md:grid-cols-[44px_minmax(0,1fr)] tw:md:py-11"
            >
              <span className="tw:font-mono tw:text-xs tw:font-bold tw:text-brand-emphasis">
                {String(index + 1).padStart(2, "0")}
              </span>
              <div>
                <h2 className="tw:text-2xl tw:font-extrabold tw:tracking-[-0.02em]">
                  {section.title}
                </h2>
                <div className="tw:mt-4 tw:grid tw:gap-4 tw:text-[15px] tw:leading-7 tw:text-ink-soft tw:sm:text-base">
                  {section.paragraphs?.map((paragraph) => (
                    <p key={paragraph}>{paragraph}</p>
                  ))}
                  {section.items ? (
                    <ul className="tw:grid tw:gap-3 tw:pl-5">
                      {section.items.map((item) => (
                        <li key={item} className="tw:list-disc tw:pl-1">
                          {item}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              </div>
            </section>
          ))}
        </article>

        <footer className="tw:flex tw:flex-wrap tw:items-center tw:justify-between tw:gap-4 tw:border-t tw:border-line tw:py-8 tw:text-sm tw:text-muted">
          <span>© 2026 DopeDB</span>
          <a
            href="https://github.com/json-choi/dopedb"
            className="tw:inline-flex tw:items-center tw:gap-2 tw:font-semibold tw:text-ink-soft"
          >
            GitHub
            <ExternalLink size={14} aria-hidden="true" />
          </a>
        </footer>
      </div>
    </main>
  );
}
