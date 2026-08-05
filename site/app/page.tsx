import type { Metadata } from "next";
import Image from "next/image";
import {
  ArrowRight,
  CheckCircle2,
  Database,
  Download,
  ExternalLink,
  FileClock,
  GitBranch,
  KeyRound,
  LockKeyhole,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  Waypoints,
} from "lucide-react";
import { MarketingButton } from "./MarketingButton";
import { TrackedLink } from "./TrackedLink";

const repoUrl = "https://github.com/json-choi/dopedb";
const releasesUrl = `${repoUrl}/releases/latest`;
const downloadUrls = {
  windows: `${repoUrl}/releases/latest/download/DopeDB-windows-x64-setup.exe`,
  macApple: `${repoUrl}/releases/latest/download/DopeDB-macos-arm64.dmg`,
  macIntel: `${repoUrl}/releases/latest/download/DopeDB-macos-x64.dmg`,
};
const siteUrl = "https://dopedb.dev";

type Lang = "en" | "ko";

type HomeProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

const copy = {
  en: {
    nav: {
      why: "Shared access",
      safety: "Control boundary",
      download: "Download",
      docs: "Docs",
      github: "Open GitHub repository",
      home: "DopeDB home",
    },
    hero: {
      eyebrow: "Shared access for teams and AI agents",
      tag: "Share database access. Keep credentials personal.",
      text:
        "DopeDB is an open-source database workspace where a team shares a secretless connection and policy. Each member keeps credentials local or receives a short-lived managed lease, while Codex or Claude works inside one exact connection grant enforced by Desktop.",
      download: "Download the alpha for macOS or Windows",
      github: "View on GitHub",
      signals: [
        "Secretless shared connections",
        "Member-specific access",
        "Connection-pinned Agents",
      ],
      imageAlt:
        "DopeDB desktop workspace showing a database result, approval boundary, and audit timeline",
      windowsDownload: "Download for Windows",
      macDownload: "Download for macOS",
    },
    positioning: {
      eyebrow: "The product boundary",
      title: "The workspace owns access. Members keep their own credentials.",
      body:
        "DopeDB is not another universal database client or an always-on MCP server. The hosted workspace coordinates connection identity, membership, and policy; the native app keeps database traffic, credentials, execution, and recovery local.",
      items: [
        {
          title: "Share definitions, not passwords",
          body:
            "A revisioned workspace record carries the provider resource, environment, and policy. Long-lived database secrets never travel with it.",
        },
        {
          title: "Issue access per member",
          body:
            "Use a credential in each member's OS store or a least-privilege, short-lived lease for PlanetScale, Neon, or GCP Cloud SQL.",
        },
        {
          title: "Pin every Agent session",
          body:
            "Official Codex and Claude sessions are bound to the selected workspace, account, connection revision, process, and local policy.",
        },
      ],
    },
    principles: {
      eyebrow: "Enforced access",
      title: "Safety is an operation boundary, not an Agent setting.",
      body:
        "A prompt can be ignored and a general tool server can expose too much. DopeDB binds authority outside the Agent, then preserves the controls a human needs when autonomous work reaches a real database.",
      items: [
        {
          icon: ShieldCheck,
          title: "Exact authority",
          body:
            "Workspace role, connection grant, database privilege, connection revision, and local policy must agree before an operation runs.",
        },
        {
          icon: KeyRound,
          title: "Human recovery",
          body:
            "See active work, stop a runaway execution, and roll back a supported manual transaction from the Desktop app.",
        },
        {
          icon: FileClock,
          title: "Verifiable history",
          body:
            "Immutable proposals, exact approvals, run claims, results, and receipts leave a reviewable operation trail.",
        },
      ],
    },
    workflow: {
      eyebrow: "Shared-access flow",
      title: "From one team-owned connection to one bounded Agent session.",
      steps: [
        "Create or import a secretless workspace connection.",
        "Bind your own local credential or receive a member-specific managed lease.",
        "Launch the official Codex or Claude adapter against that exact revision.",
        "Inspect the real schema and run allowed reads through the local boundary.",
        "Approve an exact risky payload, then stop, roll back, or audit the run when needed.",
      ],
      terminal: `workspace: team / production
connection: billing@revision-12
member access: use + write
agent: codex / connection-pinned

operation -> proposed write

UPDATE customers
SET plan = 'pro'
WHERE id = 1842;

DopeDB boundary:
  authority: exact revision
  classification: write
  rows estimated: 1
  approval: exact payload required
  recovery: manual transaction rollback`,
    },
    download: {
      eyebrow: "Open-source alpha",
      title: "Try the current macOS or Windows alpha from GitHub Releases.",
      body:
        "Start in Personal Workspace without an account. Sign in only when you want team sharing or managed provider access. The release is an alpha, so expect rough edges and verify the scope before using production data.",
      warningTitle: "macOS may show a developer warning.",
      warningBody:
        "Until DopeDB is notarized with an Apple Developer ID, approve it from System Settings, Privacy & Security, Open Anyway after confirming the file came from GitHub Releases.",
      terminalPrefix: "Terminal alternative after copying to Applications:",
      latest: "Latest release",
      windows: "Windows x64 installer",
      macApple: "macOS Apple Silicon",
      macIntel: "macOS Intel",
      source: "Build from source",
    },
    docs: {
      eyebrow: "Product evidence",
      title: "Read the boundary before trusting the binary.",
      items: [
        {
          title: "Product direction",
          href: `${repoUrl}/blob/main/docs/PRODUCT_POSITIONING.md`,
          body: "The audience, competitive boundary, public promise, and open gaps.",
        },
        {
          title: "Project guide",
          href: `${repoUrl}/blob/main/docs/PROJECT.md`,
          body: "Architecture, release flow, safety model, and maintainer notes.",
        },
        {
          title: "Workspace architecture",
          href: `${repoUrl}/blob/main/docs/WORKSPACE_ROADMAP.md`,
          body: "Shipped milestones, managed-provider decisions, and remaining exit criteria.",
        },
        {
          title: "Releases",
          href: releasesUrl,
          body: "Latest macOS/Windows downloads and updater metadata.",
        },
      ],
    },
    jsonDescription:
      "DopeDB is an open-source database workspace where teams share access without sharing database credentials, and Codex or Claude works through one connection-pinned, locally enforced session.",
  },
  ko: {
    nav: {
      why: "공유 접근",
      safety: "통제 경계",
      download: "다운로드",
      docs: "문서",
      github: "GitHub 저장소 열기",
      home: "DopeDB 홈",
    },
    hero: {
      eyebrow: "팀과 AI Agent를 위한 공유 DB 접근",
      tag: "DB 접근은 함께, 인증정보는 각자 보관하세요.",
      text:
        "DopeDB(도프디비)는 팀이 비밀값 없는 연결과 정책을 공유하는 오픈소스 데이터베이스 워크스페이스입니다. 구성원은 자격 증명을 로컬에 보관하거나 단기 managed credential을 받고, Codex와 Claude는 Desktop이 집행하는 정확한 connection grant 안에서 일합니다.",
      download: "macOS/Windows alpha 다운로드",
      github: "GitHub에서 보기",
      signals: ["비밀값 없는 공유 연결", "구성원별 접근", "연결에 고정된 Agent"],
      imageAlt:
        "데이터베이스 결과, 승인 경계, 감사 타임라인을 보여주는 DopeDB 데스크톱 워크스페이스",
      windowsDownload: "Windows 다운로드",
      macDownload: "macOS 다운로드",
    },
    positioning: {
      eyebrow: "제품 경계",
      title: "workspace는 접근을 소유하고, 구성원은 자신의 인증정보를 지킵니다.",
      body:
        "DopeDB는 또 하나의 범용 DB 클라이언트나 상시 MCP server가 아닙니다. hosted workspace는 연결 정체성, membership, policy를 조정하고, native app은 DB traffic, 자격 증명, 실행, 복구를 로컬에 둡니다.",
      items: [
        {
          title: "password 대신 정의를 공유",
          body:
            "revision이 있는 workspace record에는 provider resource, environment, policy만 담고 장기 DB 비밀값은 넣지 않습니다.",
        },
        {
          title: "구성원별로 접근 발급",
          body:
            "각자의 OS 저장소를 사용하거나 PlanetScale, Neon, GCP Cloud SQL에서 최소 권한의 단기 credential을 받습니다.",
        },
        {
          title: "모든 Agent session을 고정",
          body:
            "공식 Codex와 Claude session을 선택한 workspace, account, connection revision, process, local policy에 묶습니다.",
        },
      ],
    },
    principles: {
      eyebrow: "집행되는 접근",
      title: "안전은 Agent 설정이 아니라 operation 경계입니다.",
      body:
        "prompt는 무시될 수 있고 범용 tool server는 너무 많은 연결을 노출할 수 있습니다. DopeDB는 Agent 밖에서 권한을 묶고, 자율 작업이 실제 DB에 닿을 때 필요한 사람의 통제 수단을 보존합니다.",
      items: [
        {
          icon: ShieldCheck,
          title: "정확한 권한",
          body:
            "workspace role, connection grant, DB privilege, connection revision, local policy가 모두 맞아야 실행됩니다.",
        },
        {
          icon: KeyRound,
          title: "사람의 복구 수단",
          body:
            "진행 중인 작업을 보고, 폭주한 실행을 멈추고, 지원되는 manual transaction을 Desktop에서 rollback합니다.",
        },
        {
          icon: FileClock,
          title: "검증 가능한 기록",
          body:
            "불변 proposal, exact approval, run claim, result, receipt가 검토 가능한 operation trail을 남깁니다.",
        },
      ],
    },
    workflow: {
      eyebrow: "공유 접근 흐름",
      title: "팀이 소유한 연결 하나에서 경계가 있는 Agent session 하나로.",
      steps: [
        "비밀값 없는 workspace connection을 만들거나 가져옵니다.",
        "자신의 로컬 credential을 연결하거나 구성원별 managed lease를 받습니다.",
        "정확한 revision을 대상으로 공식 Codex 또는 Claude adapter를 시작합니다.",
        "실제 schema를 확인하고 로컬 경계를 통해 허용된 read를 실행합니다.",
        "위험한 exact payload를 승인하고 필요할 때 실행 중단, rollback, 감사를 수행합니다.",
      ],
      terminal: `workspace: team / production
connection: billing@revision-12
member access: use + write
agent: codex / connection-pinned

operation -> proposed write

UPDATE customers
SET plan = 'pro'
WHERE id = 1842;

DopeDB boundary:
  authority: exact revision
  classification: write
  rows estimated: 1
  approval: exact payload required
  recovery: manual transaction rollback`,
    },
    download: {
      eyebrow: "오픈소스 alpha",
      title: "현재 macOS 또는 Windows alpha를 GitHub Releases에서 사용해보세요.",
      body:
        "계정 없이 Personal Workspace로 시작할 수 있습니다. 팀 공유나 managed provider access가 필요할 때만 로그인하세요. 아직 alpha이므로 거친 부분이 있으며 production data에 사용하기 전에 지원 범위를 확인하세요.",
      warningTitle: "macOS 개발자 확인 경고가 표시될 수 있습니다.",
      warningBody:
        "Apple Developer ID로 공증되기 전까지는 GitHub Releases에서 받은 파일인지 확인한 뒤 System Settings, Privacy & Security, Open Anyway에서 실행을 허용하세요.",
      terminalPrefix: "Applications로 복사한 뒤 터미널에서 실행할 수 있는 대안:",
      latest: "최신 릴리스",
      windows: "Windows x64 설치 파일",
      macApple: "macOS Apple Silicon",
      macIntel: "macOS Intel",
      source: "소스에서 빌드",
    },
    docs: {
      eyebrow: "제품 근거",
      title: "바이너리를 신뢰하기 전에 경계를 확인하세요.",
      items: [
        {
          title: "제품 방향",
          href: `${repoUrl}/blob/main/docs/PRODUCT_POSITIONING.md`,
          body: "대상 사용자, 경쟁 경계, 공개 약속, 아직 열린 범위.",
        },
        {
          title: "프로젝트 가이드",
          href: `${repoUrl}/blob/main/docs/PROJECT.md`,
          body: "아키텍처, 릴리스 흐름, 안전 모델, 메인테이너 노트.",
        },
        {
          title: "Workspace 아키텍처",
          href: `${repoUrl}/blob/main/docs/WORKSPACE_ROADMAP.md`,
          body: "구현된 milestone, managed provider 결정, 남은 exit criteria.",
        },
        {
          title: "릴리스",
          href: releasesUrl,
          body: "최신 macOS/Windows 다운로드와 updater metadata.",
        },
      ],
    },
    jsonDescription:
      "DopeDB는 팀이 DB 인증정보 대신 연결과 정책을 공유하고, Codex와 Claude가 정확한 연결에 고정된 로컬 권한 경계 안에서 일하게 하는 오픈소스 데이터베이스 워크스페이스입니다.",
  },
};

function normalizeLang(value: string | string[] | undefined): Lang {
  const lang = Array.isArray(value) ? value[0] : value;
  return lang === "ko" ? "ko" : "en";
}

async function resolveLang(searchParams: HomeProps["searchParams"]): Promise<Lang> {
  const params = searchParams ? await searchParams : {};
  return normalizeLang(params.lang);
}

export async function generateMetadata({ searchParams }: HomeProps): Promise<Metadata> {
  const lang = await resolveLang(searchParams);
  const languageAlternates = {
    "en-US": "/",
    "ko-KR": "/ko",
    "x-default": "/",
  };

  if (lang === "ko") {
    const title = "DopeDB(도프디비) - 팀과 AI Agent를 위한 DB 접근 워크스페이스";
    const description =
      "팀은 DB 인증정보 대신 연결과 정책을 공유하고, Codex와 Claude는 정확한 연결에 고정된 로컬 권한 경계 안에서 일합니다.";

    return {
      title: { absolute: title },
      description,
      keywords: [
        "도프디비",
        "DopeDB",
        "팀 데이터베이스 워크스페이스",
        "공유 데이터베이스 접근",
        "AI Agent 데이터베이스 접근",
        "Neon 데이터베이스 접근",
        "비밀값 없는 연결",
      ],
      alternates: {
        canonical: "/ko",
        languages: languageAlternates,
      },
      openGraph: {
        title,
        description,
        url: `${siteUrl}/ko`,
        siteName: "DopeDB(도프디비)",
        locale: "ko_KR",
        type: "website",
        images: [
          {
            url: "/dopedb-dashboard.png",
            width: 1600,
            height: 1120,
            alt: "DopeDB(도프디비) 데스크톱 앱 화면",
          },
        ],
      },
      twitter: {
        card: "summary_large_image",
        title,
        description,
        images: ["/dopedb-dashboard.png"],
      },
    };
  }

  return {
    alternates: {
      canonical: "/",
      languages: languageAlternates,
    },
  };
}

export default async function Home({ searchParams }: HomeProps) {
  const lang = await resolveLang(searchParams);
  const c = copy[lang];
  const otherLang = lang === "ko" ? "en" : "ko";

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "DopeDB",
    alternateName: "도프디비",
    applicationCategory: "DeveloperApplication",
    operatingSystem: "macOS, Windows",
    description: c.jsonDescription,
    url: siteUrl,
    downloadUrl: [downloadUrls.windows, downloadUrls.macApple, downloadUrls.macIntel],
    codeRepository: repoUrl,
    image: `${siteUrl}/dopedb-dashboard.png`,
    license: `${repoUrl}/blob/main/LICENSE`,
    inLanguage: lang,
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
    },
  };

  return (
    <main lang={lang}>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <header className="tw:sticky tw:top-0 tw:z-20 tw:grid tw:grid-cols-[1fr_auto_1fr] tw:items-center tw:gap-6 tw:border-b tw:border-ink/10 tw:bg-paper/90 tw:px-[clamp(18px,4vw,56px)] tw:py-4 tw:backdrop-blur-[18px] tw:max-[980px]:grid-cols-[1fr_auto] tw:max-[620px]:px-3.5 tw:max-[620px]:py-3">
        <a
          className="tw:inline-flex tw:items-center tw:justify-self-start tw:gap-2.5 tw:text-[15px] tw:font-[750]"
          href="#top"
          aria-label={c.nav.home}
        >
          <span
            className="tw:inline-flex tw:size-[34px] tw:items-center tw:justify-center tw:rounded-md tw:border tw:border-ink/15 tw:bg-site-black tw:text-brand tw:max-[620px]:size-8"
            aria-hidden="true"
          >
            <Database size={18} />
          </span>
          <span>{lang === "ko" ? "DopeDB · 도프디비" : "DopeDB"}</span>
        </a>
        <nav
          className="tw:inline-flex tw:items-center tw:justify-self-center tw:gap-2 tw:rounded-md tw:border tw:border-ink/10 tw:bg-site-white/70 tw:p-[5px] tw:max-[980px]:hidden tw:[&_a]:min-h-[34px] tw:[&_a]:rounded-sm tw:[&_a]:px-3 tw:[&_a]:py-2 tw:[&_a]:text-sm tw:[&_a]:font-[650] tw:[&_a]:text-ink-soft tw:[&_a]:hover:bg-ink/5 tw:[&_a]:hover:text-ink"
          aria-label="Primary navigation"
        >
          <a href="#why">{c.nav.why}</a>
          <a href="#safety">{c.nav.safety}</a>
          <a href="#download">{c.nav.download}</a>
          <a href="#docs">{c.nav.docs}</a>
        </nav>
        <div className="tw:inline-flex tw:items-center tw:justify-self-end tw:gap-2">
          <a
            className="tw:inline-flex tw:min-h-[38px] tw:items-center tw:rounded-md tw:border tw:border-ink/15 tw:bg-site-white/75 tw:px-3 tw:py-2 tw:text-[13px] tw:font-[760] tw:text-ink-soft tw:hover:bg-site-white tw:hover:text-ink"
            href={otherLang === "ko" ? "/ko" : "/"}
            hrefLang={otherLang}
            aria-label={otherLang === "ko" ? "한국어로 보기" : "View in English"}
          >
            {otherLang === "ko" ? "한국어" : "English"}
          </a>
          <a
            className="tw:inline-flex tw:size-[38px] tw:items-center tw:justify-center tw:rounded-md tw:border tw:border-ink/15 tw:bg-site-white/75 tw:hover:bg-site-white tw:hover:text-ink"
            href={repoUrl}
            aria-label={c.nav.github}
          >
            <GitBranch size={20} />
          </a>
        </div>
      </header>

      <section
        className="tw:relative tw:grid tw:min-h-[min(780px,calc(100vh-72px))] tw:grid-cols-[minmax(0,0.88fr)_minmax(430px,1.12fr)] tw:items-center tw:gap-[clamp(30px,5vw,76px)] tw:overflow-hidden tw:border-b tw:border-line tw:bg-hero tw:bg-[length:46px_46px,46px_46px,auto,auto] tw:px-[clamp(18px,4vw,56px)] tw:pt-[clamp(50px,8vw,94px)] tw:pb-16 tw:max-[980px]:min-h-0 tw:max-[980px]:grid-cols-1 tw:max-[980px]:pt-12 tw:max-[620px]:px-3.5 tw:max-[620px]:pt-9 tw:max-[620px]:pb-12"
        id="top"
      >
        <div className="tw:max-w-[690px] tw:max-[980px]:max-w-none">
          <p className="tw:mb-4 tw:inline-flex tw:items-center tw:gap-2 tw:text-[13px] tw:font-extrabold tw:text-brand-emphasis tw:uppercase">
            <Sparkles size={15} />
            {c.hero.eyebrow}
          </p>
          <h1 className="tw:text-[clamp(72px,10vw,154px)] tw:leading-[0.86] tw:font-[860] tw:max-[620px]:text-[clamp(58px,20vw,86px)]">
            DopeDB
            {lang === "ko" && (
              <span className="tw:ml-[0.35em] tw:inline-block tw:align-[0.42em] tw:text-[0.22em] tw:font-[780] tw:text-brand-emphasis">
                도프디비
              </span>
            )}
            <span className="tw:mt-5 tw:block tw:text-[clamp(20px,2.6vw,34px)] tw:leading-[1.15] tw:font-[720] tw:text-ink-soft">
              {c.hero.tag}
            </span>
          </h1>
          <p className="tw:mt-7 tw:max-w-[650px] tw:text-[clamp(16px,1.7vw,20px)] tw:leading-relaxed tw:text-ink-soft">
            {c.hero.text}
          </p>
          <div
            className="tw:mt-8 tw:flex tw:flex-wrap tw:gap-3 tw:max-[620px]:grid tw:max-[620px]:grid-cols-1"
            aria-label="Primary actions"
          >
            <MarketingButton
              variant="primary"
              href={downloadUrls.windows}
              event="Download Clicked"
              properties={{ source: "hero", target: "windows_x64_installer" }}
            >
              <Download size={18} />
              {c.hero.windowsDownload}
            </MarketingButton>
            <MarketingButton
              variant="secondary"
              href={downloadUrls.macApple}
              event="Download Clicked"
              properties={{ source: "hero", target: "macos_arm64_dmg" }}
            >
              <Download size={18} />
              {c.hero.macDownload}
            </MarketingButton>
          </div>
          <div
            className="tw:mt-[26px] tw:inline-flex tw:flex-wrap tw:items-center tw:gap-2.5 tw:[&_span]:inline-flex tw:[&_span]:min-h-[34px] tw:[&_span]:items-center tw:[&_span]:gap-[7px] tw:[&_span]:rounded-md tw:[&_span]:border tw:[&_span]:border-ink/10 tw:[&_span]:bg-site-white/70 tw:[&_span]:px-2.5 tw:[&_span]:py-[7px] tw:[&_span]:text-[13px] tw:[&_span]:font-[720] tw:[&_span]:text-ink-soft tw:[&_svg]:text-brand-emphasis tw:max-[620px]:[&_span]:w-full"
            aria-label="Project highlights"
          >
            {c.hero.signals.map((signal) => (
              <span key={signal}>
                <CheckCircle2 size={16} />
                {signal}
              </span>
            ))}
          </div>
        </div>

        <div
          className="tw:relative tw:min-w-0 tw:max-[980px]:max-w-[820px]"
          aria-label="DopeDB product preview"
        >
          <div className="tw:relative tw:rotate-[-1.2deg] tw:overflow-hidden tw:rounded-md tw:border tw:border-ink/15 tw:bg-site-black tw:shadow-floating tw:after:pointer-events-none tw:after:absolute tw:after:inset-0 tw:after:rounded-md tw:after:shadow-inset-highlight tw:max-[980px]:rotate-0 tw:[&_img]:block tw:[&_img]:h-auto tw:[&_img]:w-full">
            <Image
              src="/dopedb-dashboard.png"
              alt={c.hero.imageAlt}
              width={1600}
              height={1120}
              priority
            />
          </div>
        </div>
      </section>

      <section
        className="tw:border-b tw:border-line tw:bg-site-white tw:px-[clamp(18px,4vw,56px)] tw:py-[clamp(64px,9vw,118px)]"
        id="why"
      >
        <div className="tw:max-w-[940px]">
          <p className="tw:mb-4 tw:inline-flex tw:items-center tw:gap-2 tw:text-[13px] tw:font-extrabold tw:text-brand-emphasis tw:uppercase">
            <Sparkles size={15} />
            {c.positioning.eyebrow}
          </p>
          <h2 className="tw:max-w-[820px] tw:text-[clamp(34px,5vw,70px)] tw:leading-[0.98] tw:font-[820] tw:max-[620px]:text-[clamp(32px,11vw,46px)]">
            {c.positioning.title}
          </h2>
          <p className="tw:mt-[22px] tw:max-w-[760px] tw:text-[clamp(16px,1.7vw,20px)] tw:leading-relaxed tw:text-ink-soft">
            {c.positioning.body}
          </p>
        </div>
        <div className="tw:mt-[38px] tw:grid tw:grid-cols-3 tw:gap-px tw:overflow-hidden tw:rounded-md tw:border tw:border-line tw:bg-line tw:max-[980px]:grid-cols-1">
          {c.positioning.items.map((item) => (
            <article
              className="tw:min-h-[220px] tw:bg-paper tw:p-6 tw:max-[980px]:min-h-0"
              key={item.title}
            >
              <h3 className="tw:max-w-[280px] tw:text-[19px] tw:font-[780]">
                {item.title}
              </h3>
              <p className="tw:mt-3.5 tw:text-base tw:leading-relaxed tw:text-ink-soft">
                {item.body}
              </p>
            </article>
          ))}
        </div>
      </section>

      <section
        className="tw:bg-paper tw:px-[clamp(18px,4vw,56px)] tw:py-[clamp(64px,9vw,118px)] tw:max-[620px]:px-3.5 tw:max-[620px]:py-[58px]"
        id="safety"
      >
        <div className="tw:max-w-[940px]">
          <p className="tw:mb-4 tw:inline-flex tw:items-center tw:gap-2 tw:text-[13px] tw:font-extrabold tw:text-brand-emphasis tw:uppercase">
            <LockKeyhole size={15} />
            {c.principles.eyebrow}
          </p>
          <h2 className="tw:max-w-[820px] tw:text-[clamp(34px,5vw,70px)] tw:leading-[0.98] tw:font-[820] tw:max-[620px]:text-[clamp(32px,11vw,46px)]">
            {c.principles.title}
          </h2>
          <p className="tw:mt-[22px] tw:max-w-[760px] tw:text-[clamp(16px,1.7vw,20px)] tw:leading-relaxed tw:text-ink-soft">
            {c.principles.body}
          </p>
        </div>
        <div className="tw:mt-[38px] tw:grid tw:grid-cols-3 tw:gap-3.5 tw:max-[980px]:grid-cols-1">
          {c.principles.items.map((item) => (
            <article
              className="tw:grid tw:min-h-[260px] tw:content-start tw:gap-4 tw:rounded-md tw:border tw:border-line tw:bg-paper tw:p-6 tw:max-[980px]:min-h-0 tw:[&_svg]:size-[42px] tw:[&_svg]:rounded-md tw:[&_svg]:bg-site-black tw:[&_svg]:p-[9px] tw:[&_svg]:text-brand"
              key={item.title}
            >
              <item.icon size={22} />
              <h3 className="tw:text-[19px] tw:font-[780]">{item.title}</h3>
              <p className="tw:text-base tw:leading-relaxed tw:text-ink-soft">
                {item.body}
              </p>
            </article>
          ))}
        </div>
      </section>

      <section className="tw:grid tw:grid-cols-[minmax(0,0.92fr)_minmax(360px,0.8fr)] tw:items-center tw:gap-[clamp(28px,6vw,80px)] tw:bg-site-black tw:px-[clamp(18px,4vw,56px)] tw:py-[clamp(64px,9vw,118px)] tw:text-site-white tw:max-[980px]:grid-cols-1 tw:max-[620px]:px-3.5 tw:max-[620px]:py-[58px]">
        <div>
          <p className="tw:mb-4 tw:inline-flex tw:items-center tw:gap-2 tw:text-[13px] tw:font-extrabold tw:text-brand tw:uppercase">
            <Waypoints size={15} />
            {c.workflow.eyebrow}
          </p>
          <h2 className="tw:max-w-[820px] tw:text-[clamp(34px,5vw,70px)] tw:leading-[0.98] tw:font-[820] tw:max-[620px]:text-[clamp(32px,11vw,46px)]">
            {c.workflow.title}
          </h2>
          <ol className="tw:mt-[30px] tw:grid tw:max-w-[720px] tw:list-none tw:gap-3.5 tw:p-0">
            {c.workflow.steps.map((step, index) => (
              <li
                className="tw:grid tw:min-h-[52px] tw:grid-cols-[28px_1fr] tw:items-start tw:gap-4 tw:rounded-md tw:border tw:border-site-white/15 tw:bg-site-white/5 tw:px-3.5 tw:py-3 tw:text-base tw:leading-[1.45] tw:text-site-white/80"
                key={step}
              >
                <span className="tw:grid tw:size-7 tw:place-items-center tw:rounded-md tw:bg-brand tw:text-[13px] tw:font-[850] tw:text-site-black">
                  {index + 1}
                </span>
                <span className="tw:pt-[3px]">{step}</span>
              </li>
            ))}
          </ol>
        </div>
        <div
          className="tw:overflow-hidden tw:rounded-md tw:border tw:border-site-white/15 tw:bg-terminal tw:shadow-terminal"
          aria-label="Example agent output"
        >
          <div className="tw:flex tw:gap-[7px] tw:border-b tw:border-site-white/10 tw:px-4 tw:py-3.5">
            <span className="tw:size-[11px] tw:rounded-full tw:bg-danger" />
            <span className="tw:size-[11px] tw:rounded-full tw:bg-warning" />
            <span className="tw:size-[11px] tw:rounded-full tw:bg-brand" />
          </div>
          <pre className="tw:m-0 tw:overflow-x-auto tw:p-[clamp(18px,3vw,30px)] tw:font-mono tw:text-[clamp(13px,1.6vw,16px)] tw:leading-[1.58] tw:text-site-white/90">
            <code className="tw:font-mono">{c.workflow.terminal}</code>
          </pre>
        </div>
      </section>

      <section
        className="tw:grid tw:grid-cols-[minmax(0,1fr)_auto] tw:items-center tw:gap-8 tw:border-b tw:border-line tw:bg-download tw:px-[clamp(18px,4vw,56px)] tw:py-[clamp(64px,9vw,118px)] tw:max-[980px]:grid-cols-1 tw:max-[620px]:px-3.5 tw:max-[620px]:py-[58px]"
        id="download"
      >
        <div>
          <p className="tw:mb-4 tw:inline-flex tw:items-center tw:gap-2 tw:text-[13px] tw:font-extrabold tw:text-brand-emphasis tw:uppercase">
            <Download size={15} />
            {c.download.eyebrow}
          </p>
          <h2 className="tw:max-w-[820px] tw:text-[clamp(34px,5vw,70px)] tw:leading-[0.98] tw:font-[820] tw:max-[620px]:text-[clamp(32px,11vw,46px)]">
            {c.download.title}
          </h2>
          <p className="tw:mt-[18px] tw:max-w-[720px] tw:text-[clamp(16px,1.7vw,20px)] tw:leading-relaxed tw:text-ink-soft">
            {c.download.body}
          </p>
          <div className="tw:mt-[22px] tw:flex tw:max-w-[760px] tw:gap-3 tw:rounded-md tw:border tw:border-ink/15 tw:bg-site-white/65 tw:p-4">
            <LockKeyhole
              className="tw:mt-0.5 tw:shrink-0 tw:text-brand-emphasis"
              size={18}
            />
            <div>
              <h3 className="tw:text-base tw:font-[780]">{c.download.warningTitle}</h3>
              <p className="tw:mt-1.5 tw:max-w-[720px] tw:text-[15px] tw:leading-relaxed tw:text-ink-soft">
                {c.download.warningBody}
              </p>
              <p className="tw:mt-1.5 tw:max-w-[720px] tw:text-[15px] tw:leading-relaxed tw:text-ink-soft">
                {c.download.terminalPrefix}{" "}
                <code className="tw:font-mono">
                  sudo xattr -dr com.apple.quarantine /Applications/DopeDB.app
                </code>
              </p>
            </div>
          </div>
        </div>
        <div className="tw:flex tw:flex-wrap tw:justify-end tw:gap-3 tw:max-[980px]:justify-start tw:max-[620px]:grid tw:max-[620px]:grid-cols-1">
          <MarketingButton
            variant="primary"
            href={downloadUrls.windows}
            event="Download Clicked"
            properties={{ source: "download_section", target: "windows_x64_installer" }}
          >
            <Download size={18} />
            {c.download.windows}
          </MarketingButton>
          <MarketingButton
            variant="secondary"
            href={downloadUrls.macApple}
            event="Download Clicked"
            properties={{ source: "download_section", target: "macos_arm64_dmg" }}
          >
            <Download size={18} />
            {c.download.macApple}
          </MarketingButton>
          <MarketingButton
            variant="secondary"
            href={downloadUrls.macIntel}
            event="Download Clicked"
            properties={{ source: "download_section", target: "macos_x64_dmg" }}
          >
            <Download size={18} />
            {c.download.macIntel}
          </MarketingButton>
          <MarketingButton
            variant="secondary"
            href={`${repoUrl}/blob/main/docs/PROJECT.md#development`}
          >
            <TerminalSquare size={18} />
            {c.download.source}
          </MarketingButton>
        </div>
      </section>

      <section
        className="tw:bg-paper tw:px-[clamp(18px,4vw,56px)] tw:py-[clamp(64px,9vw,118px)] tw:max-[620px]:px-3.5 tw:max-[620px]:py-[58px]"
        id="docs"
      >
        <div className="tw:max-w-[940px]">
          <p className="tw:mb-4 tw:inline-flex tw:items-center tw:gap-2 tw:text-[13px] tw:font-extrabold tw:text-brand-emphasis tw:uppercase">
            <ExternalLink size={15} />
            {c.docs.eyebrow}
          </p>
          <h2 className="tw:max-w-[760px] tw:text-[clamp(34px,5vw,70px)] tw:leading-[0.98] tw:font-[820] tw:max-[620px]:text-[clamp(32px,11vw,46px)]">
            {c.docs.title}
          </h2>
        </div>
        <div className="tw:mt-[34px] tw:grid tw:grid-cols-3 tw:gap-3.5 tw:max-[980px]:grid-cols-1">
          {c.docs.items.map((doc) => {
            const content = (
              <>
                <span className="tw:text-[19px] tw:font-[790]">{doc.title}</span>
                <p className="tw:max-w-[330px] tw:text-base tw:leading-relaxed tw:text-ink-soft">
                  {doc.body}
                </p>
                <ArrowRight
                  className="tw:absolute tw:right-[22px] tw:bottom-[22px] tw:text-brand-emphasis"
                  size={18}
                />
              </>
            );

            return (
              <TrackedLink
                className="tw:relative tw:grid tw:min-h-[210px] tw:gap-3.5 tw:rounded-md tw:border tw:border-line tw:bg-paper tw:p-6 tw:transition-[transform,border-color,background] tw:duration-150 tw:hover:-translate-y-0.5 tw:hover:border-brand-emphasis/40 tw:hover:bg-site-white tw:max-[980px]:min-h-0"
                href={doc.href}
                key={doc.title}
                event={doc.href === releasesUrl ? "Download Clicked" : undefined}
                properties={
                  doc.href === releasesUrl
                    ? { source: "docs_card", target: "github_releases_latest" }
                    : undefined
                }
              >
                {content}
              </TrackedLink>
            );
          })}
        </div>
      </section>
      <footer className="tw:flex tw:flex-wrap tw:items-center tw:justify-between tw:gap-4 tw:border-t tw:border-line tw:bg-paper-raised tw:px-[clamp(18px,4vw,56px)] tw:py-6 tw:text-sm tw:text-muted">
        <span>© 2026 DopeDB</span>
        <nav
          aria-label={lang === "ko" ? "법적 고지" : "Legal"}
          className="tw:flex tw:flex-wrap tw:items-center tw:gap-5"
        >
          <a className="tw:font-semibold tw:text-ink-soft" href={lang === "ko" ? "/ko/privacy" : "/privacy"}>
            {lang === "ko" ? "개인정보처리방침" : "Privacy"}
          </a>
          <a className="tw:font-semibold tw:text-ink-soft" href={lang === "ko" ? "/ko/terms" : "/terms"}>
            {lang === "ko" ? "서비스 이용약관" : "Terms"}
          </a>
        </nav>
      </footer>
    </main>
  );
}
