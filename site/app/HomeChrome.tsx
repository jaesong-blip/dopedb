// Landing chrome owns navigation, language switching, and footer links.
import { ArrowUpRight, GitBranch } from "lucide-react";
import { DopeDBMark } from "./DopeDBMark";
import { TrackedLink } from "./TrackedLink";
import { releasesUrl, repoUrl, workspaceUrls, type HomeCopy, type Lang } from "./homeContent";

export function HomeHeader({ c, lang }: { c: HomeCopy; lang: Lang }) {
  const otherLang = lang === "ko" ? "en" : "ko";
  return (
    <header className="tw:sticky tw:top-0 tw:z-40 tw:border-b tw:border-hairline tw:bg-night/82 tw:backdrop-blur-xl">
        <div className="tw:mx-auto tw:flex tw:min-h-16 tw:max-w-[1520px] tw:items-center tw:justify-between tw:gap-5 tw:px-[clamp(16px,4vw,64px)]">
          <a className="tw:flex tw:items-center tw:gap-3" href="#top" aria-label={c.nav.home}>
            <span className="tw:text-signal">
              <DopeDBMark />
            </span>
            <span className="tw:font-display tw:text-[17px] tw:font-semibold tw:tracking-[-0.03em]">
              DopeDB
            </span>
            <span className="tw:hidden tw:border-l tw:border-hairline tw:pl-3 tw:font-mono tw:text-[9px] tw:font-medium tw:tracking-[0.13em] tw:text-cream-muted tw:uppercase tw:min-[560px]:inline">
              Access plane / Alpha
            </span>
          </a>

          <nav
            className="tw:absolute tw:left-1/2 tw:hidden tw:-translate-x-1/2 tw:items-center tw:gap-7 tw:font-mono tw:text-[10px] tw:font-medium tw:tracking-[0.1em] tw:text-cream-muted tw:uppercase tw:min-[980px]:flex"
            aria-label="Primary navigation"
          >
            <a className="tw:transition-colors tw:hover:text-signal" href="#why">
              {c.nav.access}
            </a>
            <a className="tw:transition-colors tw:hover:text-signal" href="#safety">
              {c.nav.boundary}
            </a>
            <a className="tw:transition-colors tw:hover:text-signal" href="#flow">
              {c.nav.flow}
            </a>
          </nav>

          <div className="tw:flex tw:items-center tw:gap-2">
            <a
              className="tw:inline-flex tw:min-h-9 tw:items-center tw:border tw:border-hairline tw:px-3 tw:font-mono tw:text-[10px] tw:font-semibold tw:tracking-[0.08em] tw:text-cream-muted tw:uppercase tw:transition-colors tw:hover:border-cream/40 tw:hover:text-cream"
              href={otherLang === "ko" ? "/ko" : "/"}
              hrefLang={otherLang}
              aria-label={otherLang === "ko" ? "한국어로 보기" : "View in English"}
            >
              {otherLang === "ko" ? "KO" : "EN"}
            </a>
            <a
              className="tw:grid tw:size-9 tw:place-items-center tw:border tw:border-hairline tw:text-cream-muted tw:transition-colors tw:hover:border-cream/40 tw:hover:text-cream"
              href={repoUrl}
              aria-label={c.nav.github}
            >
              <GitBranch size={16} />
            </a>
            <TrackedLink
              className="tw:hidden tw:min-h-9 tw:items-center tw:border tw:border-hairline tw:px-3.5 tw:font-mono tw:text-[10px] tw:font-semibold tw:tracking-[0.08em] tw:text-cream-muted tw:uppercase tw:transition-colors tw:hover:border-cream/40 tw:hover:text-cream tw:min-[1180px]:inline-flex"
              href={workspaceUrls[lang]}
              event="Workspace Opened"
              properties={{ source: "header" }}
            >
              {c.nav.workspace}
            </TrackedLink>
            <TrackedLink
              className="tw:hidden tw:min-h-9 tw:items-center tw:gap-2 tw:bg-signal tw:px-3.5 tw:font-mono tw:text-[10px] tw:font-semibold tw:tracking-[0.08em] tw:text-night tw:uppercase tw:transition-colors tw:hover:bg-signal-strong tw:min-[720px]:inline-flex"
              href={releasesUrl}
              event="Download Clicked"
              properties={{ source: "header", target: "latest_release" }}
            >
              {c.nav.download}
              <ArrowUpRight size={13} />
            </TrackedLink>
          </div>
        </div>
    </header>
  );
}
export function HomeFooter({ c, lang }: { c: HomeCopy; lang: Lang }) {
  const currentYear = new Date().getFullYear();
  return (
    <footer className="tw:border-t tw:border-hairline tw:bg-night">
      <div className="tw:mx-auto tw:flex tw:max-w-[1520px] tw:items-center tw:justify-between tw:gap-6 tw:px-[clamp(16px,4vw,64px)] tw:py-7 tw:max-[680px]:flex-col tw:max-[680px]:items-start">
        <div className="tw:flex tw:items-center tw:gap-3">
          <span className="tw:text-signal"><DopeDBMark /></span>
          <div>
            <p className="tw:text-sm tw:font-medium">© {currentYear} DopeDB</p>
            <p className="tw:mt-1 tw:font-mono tw:text-[9px] tw:tracking-[0.07em] tw:text-cream-muted tw:uppercase">{c.footer.statement}</p>
          </div>
        </div>
        <nav className="tw:flex tw:items-center tw:gap-5 tw:font-mono tw:text-[9px] tw:font-medium tw:tracking-[0.08em] tw:text-cream-muted tw:uppercase" aria-label="Footer navigation">
          <TrackedLink className="tw:transition-colors tw:hover:text-signal" href={workspaceUrls[lang]} event="Workspace Opened" properties={{ source: "footer" }}>
            {c.footer.workspace}
          </TrackedLink>
          <a className="tw:transition-colors tw:hover:text-signal" href={lang === "ko" ? "/ko/privacy" : "/privacy"}>{c.footer.privacy}</a>
          <a className="tw:transition-colors tw:hover:text-signal" href={lang === "ko" ? "/ko/terms" : "/terms"}>{c.footer.terms}</a>
        </nav>
      </div>
    </footer>
  );
}
