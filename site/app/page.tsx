// Public bilingual landing page for DopeDB's shared-access product boundary.
import type { Metadata } from "next";
import Image from "next/image";
import type { ReactNode } from "react";
import {
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  Bot,
  ChevronRight,
  CircleDot,
  Database,
  Download,
  ExternalLink,
  FileClock,
  Fingerprint,
  GitBranch,
  KeyRound,
  LockKeyhole,
  Network,
  ShieldCheck,
  SquareTerminal,
  Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
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
      access: "Shared access",
      boundary: "Control boundary",
      flow: "How it works",
      download: "Get the alpha",
      github: "Open GitHub repository",
      home: "DopeDB home",
      skip: "Skip to main content",
    },
    hero: {
      eyebrow: "Open source · Alpha · Local execution",
      headline: "Share database access.",
      accent: "Keep credentials personal.",
      text:
        "DopeDB gives a team one connection and policy without creating one shared password. Each member or Agent receives only the authority it needs, while database traffic and recovery stay on the desktop.",
      primary: "Download the alpha",
      secondary: "Inspect the source",
      proof:
        "Personal Workspace needs no account · macOS and Windows · MIT licensed",
    },
    topology: {
      eyebrow: "Access boundary / reference flow",
      status: "Exact scope",
      workspaceLabel: "Team workspace",
      workspaceValue: "billing-prod · revision 12",
      workspaceMeta: "Connection identity + policy · no password",
      memberLabel: "Member access",
      memberValue: "Individual credential",
      memberMeta: "OS store or short-lived managed lease",
      agentLabel: "Agent session",
      agentValue: "Codex · pinned",
      agentMeta: "Workspace + account + revision + process",
      databaseLabel: "Local execution",
      databaseValue: "PostgreSQL · production",
      databaseMeta: "Database traffic never crosses the workspace service",
      seal: "No shared secret",
      receipt: "Operation receipt",
    },
    proofs: [
      { label: "Shared record", value: "Carries no password" },
      { label: "Managed access", value: "Neon · GCP · PlanetScale" },
      { label: "Agent authority", value: "Exact connection revision" },
      { label: "Query path", value: "Runs from your desktop" },
    ],
    boundary: {
      eyebrow: "01 / Shared access",
      title: "One connection. Individual authority.",
      body:
        "The collaboration layer owns identity and policy. Credentials and query execution remain deliberately outside the shared record.",
      items: [
        {
          index: "01",
          overline: "Secretless record",
          title: "Share what the database is, not the key that opens it.",
          body:
            "Provider resource, environment, policy, and revision travel with the workspace connection. A long-lived database secret does not.",
        },
        {
          index: "02",
          overline: "Member-specific access",
          title: "Every teammate arrives through their own credential path.",
          body:
            "Bind a credential in the member's OS store or issue a least-privilege, expiring managed credential for a supported provider.",
        },
        {
          index: "03",
          overline: "Connection-pinned Agent",
          title: "Every Agent inherits an exact grant, never the connection list.",
          body:
            "Official Codex and Claude sessions are launched against one workspace, account, connection revision, process, and local policy.",
        },
      ],
    },
    product: {
      eyebrow: "02 / Desktop boundary",
      title: "The workspace coordinates. Your desktop executes.",
      body:
        "DopeDB is not a database proxy. The native app keeps credentials, database traffic, write approval, cancellation, rollback, results, and local audit at the machine where the work runs.",
      imageAlt:
        "DopeDB desktop workspace showing an Agent answer, database result, safety gate, and audit timeline",
      labels: [
        { title: "Control plane", body: "Identity · policy · revisions" },
        { title: "Local boundary", body: "Credentials · queries · recovery" },
      ],
    },
    principles: {
      eyebrow: "Enforced, not prompted",
      title: "Safety lives outside the Agent.",
      body:
        "A system prompt can be ignored. DopeDB binds authority to the operation itself and keeps the human recovery controls visible.",
      items: [
        {
          icon: Fingerprint,
          title: "Exact authority",
          body:
            "Workspace role, connection grant, database privilege, revision, and local policy must agree.",
        },
        {
          icon: ShieldCheck,
          title: "Exact approval",
          body:
            "Writes and DDL become immutable proposals. The Agent cannot approve its own payload.",
        },
        {
          icon: FileClock,
          title: "Human recovery",
          body:
            "Observe active work, cancel execution, roll back a supported transaction, and inspect the receipt.",
        },
      ],
    },
    workflow: {
      eyebrow: "03 / Exact operation",
      title: "A bounded path from intent to receipt.",
      body:
        "The Agent can move quickly because the authority, write decision, and recovery path are already explicit.",
      steps: [
        {
          index: "01",
          title: "Share the connection",
          body: "Create a secretless workspace definition with one verified target.",
        },
        {
          index: "02",
          title: "Resolve member access",
          body: "Bind a local credential or receive a member-specific managed lease.",
        },
        {
          index: "03",
          title: "Launch the Agent",
          body: "Start the official adapter against that exact connection revision.",
        },
        {
          index: "04",
          title: "Approve and recover",
          body: "Review exact writes, stop work, roll back, and retain the result trail.",
        },
      ],
      terminal: `BOUNDARY / OPERATION 0194

workspace     team / production
connection    billing@revision-12
member grant  use + write
agent          codex / process verified

PROPOSED WRITE
UPDATE customers
SET plan = 'pro'
WHERE id = 1842;

classification  write
approval        exact payload required
recovery        manual transaction rollback
receipt         pending human decision`,
    },
    faq: {
      eyebrow: "Before you trust it",
      title: "The important questions, answered directly.",
      items: [
        {
          question: "Does the workspace service proxy database queries?",
          answer:
            "No. It coordinates membership, connection metadata, policy, provider resources, revisions, and collaboration audit. Database traffic continues to run from Desktop.",
        },
        {
          question: "Are database credentials uploaded with a shared connection?",
          answer:
            "No. Member-local credentials remain in that member's OS store. Supported managed access returns an expiring member-specific credential and does not persist the issued secret.",
        },
        {
          question: "Can an Agent approve its own write?",
          answer:
            "No. Risky SQL becomes an immutable proposal. A human approves the exact payload in Desktop before the operation can proceed.",
        },
        {
          question: "Is DopeDB production-ready?",
          answer:
            "The public build is an alpha. Verify the supported provider and recovery scope, use least-privilege database roles, and test your workflow before touching production data.",
        },
      ],
    },
    download: {
      eyebrow: "Open-source alpha",
      title: "Put one real connection inside a visible boundary.",
      body:
        "Start with Personal Workspace without an account. Sign in only when you want team sharing or managed provider access.",
      primary: "Open the latest release",
      source: "Build from source",
      windows: "Windows x64",
      macApple: "macOS Apple Silicon",
      macIntel: "macOS Intel",
      warningTitle: "macOS may show a developer warning.",
      warningBody:
        "Until the app is notarized with an Apple Developer ID, confirm the file came from GitHub Releases, then use System Settings → Privacy & Security → Open Anyway.",
    },
    docs: {
      eyebrow: "Product evidence",
      title: "Read the boundary, architecture, and open gaps.",
      items: [
        {
          title: "Product direction",
          href: `${repoUrl}/blob/main/docs/PRODUCT_POSITIONING.md`,
          body: "Audience, competitive boundary, claim limits, and priorities.",
        },
        {
          title: "Project guide",
          href: `${repoUrl}/blob/main/docs/PROJECT.md`,
          body: "Architecture, safety model, development, and releases.",
        },
        {
          title: "Workspace roadmap",
          href: `${repoUrl}/blob/main/docs/WORKSPACE_ROADMAP.md`,
          body: "Shipped milestones and remaining exit criteria.",
        },
      ],
    },
    footer: {
      statement: "Shared access. Personal credentials. Exact Agent authority.",
      privacy: "Privacy",
      terms: "Terms",
    },
    jsonDescription:
      "DopeDB is an open-source database workspace where teams share access without sharing database credentials, and Codex or Claude works through one connection-pinned, locally enforced session.",
  },
  ko: {
    nav: {
      access: "공유 접근",
      boundary: "통제 경계",
      flow: "작동 방식",
      download: "Alpha 받기",
      github: "GitHub 저장소 열기",
      home: "DopeDB 홈",
      skip: "본문으로 건너뛰기",
    },
    hero: {
      eyebrow: "오픈소스 · Alpha · 로컬 실행",
      headline: "DB 접근은 함께.",
      accent: "인증정보는 각자.",
      text:
        "DopeDB는 공용 password를 만들지 않고도 팀이 하나의 연결과 정책을 쓰게 합니다. 구성원과 Agent는 필요한 권한만 받고, DB traffic과 복구 경계는 Desktop에 남습니다.",
      primary: "Alpha 다운로드",
      secondary: "소스 확인하기",
      proof: "Personal Workspace는 무계정 · macOS와 Windows · MIT 라이선스",
    },
    topology: {
      eyebrow: "접근 경계 / 예시 흐름",
      status: "정확한 범위",
      workspaceLabel: "팀 Workspace",
      workspaceValue: "billing-prod · revision 12",
      workspaceMeta: "연결 정체성 + 정책 · password 없음",
      memberLabel: "구성원 접근",
      memberValue: "개인별 credential",
      memberMeta: "OS 저장소 또는 단기 managed lease",
      agentLabel: "Agent session",
      agentValue: "Codex · 연결 고정",
      agentMeta: "Workspace + account + revision + process",
      databaseLabel: "로컬 실행",
      databaseValue: "PostgreSQL · production",
      databaseMeta: "DB traffic은 workspace service를 지나지 않음",
      seal: "공유 secret 없음",
      receipt: "Operation receipt",
    },
    proofs: [
      { label: "공유 record", value: "Password를 포함하지 않음" },
      { label: "Managed access", value: "Neon · GCP · PlanetScale" },
      { label: "Agent 권한", value: "정확한 connection revision" },
      { label: "Query 경로", value: "사용자 Desktop에서 실행" },
    ],
    boundary: {
      eyebrow: "01 / 공유 접근",
      title: "연결은 하나. 권한은 각자.",
      body:
        "협업 계층은 정체성과 정책을 소유합니다. 자격 증명과 query 실행은 의도적으로 공유 record 밖에 둡니다.",
      items: [
        {
          index: "01",
          overline: "비밀값 없는 record",
          title: "DB가 무엇인지는 공유하고, DB를 여는 key는 공유하지 않습니다.",
          body:
            "Provider resource, environment, policy, revision은 workspace connection을 따라가지만 장기 DB 비밀값은 따라가지 않습니다.",
        },
        {
          index: "02",
          overline: "구성원별 접근",
          title: "모든 구성원은 자신의 credential 경로로 접속합니다.",
          body:
            "구성원의 OS 저장소에 credential을 연결하거나 지원 provider에서 최소 권한의 만료되는 managed credential을 발급합니다.",
        },
        {
          index: "03",
          overline: "연결에 고정된 Agent",
          title: "Agent는 연결 목록이 아니라 정확한 grant 하나를 받습니다.",
          body:
            "공식 Codex와 Claude session은 workspace, account, connection revision, process, local policy 하나에 고정됩니다.",
        },
      ],
    },
    product: {
      eyebrow: "02 / Desktop 경계",
      title: "Workspace는 조정하고, Desktop은 실행합니다.",
      body:
        "DopeDB는 database proxy가 아닙니다. Native app이 credential, DB traffic, write approval, cancellation, rollback, result, local audit를 실제 작업이 실행되는 기기에 둡니다.",
      imageAlt:
        "Agent 답변, 데이터베이스 결과, 안전 게이트, 감사 타임라인을 보여주는 DopeDB 데스크톱 워크스페이스",
      labels: [
        { title: "Control plane", body: "Identity · policy · revisions" },
        { title: "Local boundary", body: "Credentials · queries · recovery" },
      ],
    },
    principles: {
      eyebrow: "Prompt가 아니라 집행",
      title: "안전 경계는 Agent 밖에 있습니다.",
      body:
        "System prompt는 무시될 수 있습니다. DopeDB는 operation 자체에 권한을 묶고, 사람이 필요한 복구 수단을 화면에 남깁니다.",
      items: [
        {
          icon: Fingerprint,
          title: "정확한 권한",
          body:
            "Workspace role, connection grant, DB privilege, revision, local policy가 모두 맞아야 합니다.",
        },
        {
          icon: ShieldCheck,
          title: "정확한 승인",
          body:
            "Write와 DDL은 불변 proposal이 되며 Agent는 자신의 payload를 승인할 수 없습니다.",
        },
        {
          icon: FileClock,
          title: "사람의 복구 수단",
          body:
            "진행 중인 작업을 보고, 실행을 멈추고, 지원 transaction을 rollback하고 receipt를 확인합니다.",
        },
      ],
    },
    workflow: {
      eyebrow: "03 / 정확한 Operation",
      title: "의도에서 receipt까지 경계가 있는 한 경로.",
      body:
        "권한, write 결정, 복구 경로가 이미 명확하기 때문에 Agent는 그 안에서 빠르게 움직일 수 있습니다.",
      steps: [
        {
          index: "01",
          title: "연결 공유",
          body: "검증된 target 하나로 비밀값 없는 workspace 정의를 만듭니다.",
        },
        {
          index: "02",
          title: "구성원 접근 결정",
          body: "로컬 credential을 연결하거나 구성원별 managed lease를 받습니다.",
        },
        {
          index: "03",
          title: "Agent 시작",
          body: "정확한 connection revision을 대상으로 공식 adapter를 시작합니다.",
        },
        {
          index: "04",
          title: "승인과 복구",
          body: "정확한 write를 검토하고, 중단·rollback·결과 기록을 수행합니다.",
        },
      ],
      terminal: `BOUNDARY / OPERATION 0194

workspace     team / production
connection    billing@revision-12
member grant  use + write
agent          codex / process verified

PROPOSED WRITE
UPDATE customers
SET plan = 'pro'
WHERE id = 1842;

classification  write
approval        exact payload required
recovery        manual transaction rollback
receipt         pending human decision`,
    },
    faq: {
      eyebrow: "신뢰하기 전에",
      title: "중요한 질문에는 바로 답합니다.",
      items: [
        {
          question: "Workspace service가 DB query를 proxy하나요?",
          answer:
            "아니요. Membership, connection metadata, policy, provider resource, revision, collaboration audit만 조정합니다. DB traffic은 계속 Desktop에서 실행됩니다.",
        },
        {
          question: "공유 connection과 함께 DB credential도 업로드되나요?",
          answer:
            "아니요. Member-local credential은 각자의 OS 저장소에 남습니다. 지원되는 managed access는 만료되는 구성원별 credential을 반환하며 발급된 secret을 저장하지 않습니다.",
        },
        {
          question: "Agent가 자신의 write를 승인할 수 있나요?",
          answer:
            "아니요. 위험한 SQL은 불변 proposal이 됩니다. 사람이 Desktop에서 exact payload를 승인해야 operation이 진행됩니다.",
        },
        {
          question: "지금 production에 사용할 수 있나요?",
          answer:
            "공개 빌드는 alpha입니다. 지원 provider와 복구 범위를 확인하고 최소 권한 DB role을 사용하며 production data 전에 workflow를 검증하세요.",
        },
      ],
    },
    download: {
      eyebrow: "오픈소스 Alpha",
      title: "실제 연결 하나를 보이는 경계 안에 넣어보세요.",
      body:
        "계정 없이 Personal Workspace로 시작하세요. 팀 공유나 managed provider access가 필요할 때만 로그인합니다.",
      primary: "최신 Release 열기",
      source: "소스에서 빌드",
      windows: "Windows x64",
      macApple: "macOS Apple Silicon",
      macIntel: "macOS Intel",
      warningTitle: "macOS 개발자 확인 경고가 표시될 수 있습니다.",
      warningBody:
        "Apple Developer ID로 공증되기 전에는 GitHub Releases에서 받은 파일인지 확인한 뒤 System Settings → Privacy & Security → Open Anyway를 사용하세요.",
    },
    docs: {
      eyebrow: "제품 근거",
      title: "경계, 아키텍처, 아직 열린 범위를 확인하세요.",
      items: [
        {
          title: "제품 방향",
          href: `${repoUrl}/blob/main/docs/PRODUCT_POSITIONING.md`,
          body: "대상 사용자, 경쟁 경계, 공개 claim, 우선순위.",
        },
        {
          title: "프로젝트 가이드",
          href: `${repoUrl}/blob/main/docs/PROJECT.md`,
          body: "아키텍처, 안전 모델, 개발, 릴리스.",
        },
        {
          title: "Workspace 로드맵",
          href: `${repoUrl}/blob/main/docs/WORKSPACE_ROADMAP.md`,
          body: "구현된 milestone과 남은 exit criteria.",
        },
      ],
    },
    footer: {
      statement: "공유 접근. 개인별 인증정보. 정확한 Agent 권한.",
      privacy: "개인정보처리방침",
      terms: "이용약관",
    },
    jsonDescription:
      "DopeDB는 팀이 DB 인증정보 대신 연결과 정책을 공유하고, Codex와 Claude가 정확한 연결에 고정된 로컬 권한 경계 안에서 일하게 하는 오픈소스 데이터베이스 워크스페이스입니다.",
  },
};

type SectionLabelProps = {
  children: ReactNode;
  tone?: "dark" | "light" | "signal";
};

function SectionLabel({ children, tone = "dark" }: SectionLabelProps) {
  return (
    <p
      className="tw:inline-flex tw:items-center tw:gap-2.5 tw:font-mono tw:text-[11px] tw:leading-none tw:font-semibold tw:tracking-[0.12em] tw:uppercase tw:data-[tone=dark]:text-signal tw:data-[tone=light]:text-night/60 tw:data-[tone=signal]:text-night/65"
      data-tone={tone}
    >
      <span
        className="tw:size-1.5 tw:rounded-full tw:bg-current tw:shadow-[0_0_0_4px_color-mix(in_srgb,currentColor_14%,transparent)]"
        aria-hidden="true"
      />
      {children}
    </p>
  );
}

type TopologyNodeProps = {
  icon: LucideIcon;
  label: string;
  meta: string;
  value: string;
};

function TopologyNode({ icon: Icon, label, meta, value }: TopologyNodeProps) {
  return (
    <div className="tw:group tw:relative tw:min-w-0 tw:border tw:border-hairline tw:bg-night-raised/90 tw:p-4 tw:transition-[border-color,background-color,transform] tw:duration-300 tw:hover:-translate-y-0.5 tw:hover:border-signal/45 tw:hover:bg-night-soft">
      <div className="tw:flex tw:items-start tw:justify-between tw:gap-4">
        <div className="tw:min-w-0">
          <p className="tw:font-mono tw:text-[10px] tw:font-semibold tw:tracking-[0.12em] tw:text-cream-muted tw:uppercase">
            {label}
          </p>
          <p className="tw:mt-2 tw:truncate tw:text-[15px] tw:font-bold tw:text-cream">
            {value}
          </p>
        </div>
        <span className="tw:grid tw:size-9 tw:shrink-0 tw:place-items-center tw:border tw:border-signal/30 tw:bg-signal/10 tw:text-signal">
          <Icon size={17} strokeWidth={1.8} />
        </span>
      </div>
      <p className="tw:mt-4 tw:max-w-[34ch] tw:font-mono tw:text-[10px] tw:leading-relaxed tw:text-cream-muted">
        {meta}
      </p>
    </div>
  );
}

type TopologyCopy = (typeof copy.en)["topology"];

function AccessTopology({ c }: { c: TopologyCopy }) {
  return (
    <div className="tw:relative tw:border tw:border-hairline-strong tw:bg-night/75 tw:p-2 tw:shadow-stage tw:backdrop-blur-xl">
      <div className="tw:absolute tw:-inset-10 tw:-z-10 tw:bg-signal/10 tw:blur-[80px] tw:animate-[landing-breathe_6s_ease-in-out_infinite] tw:motion-reduce:animate-none" />
      <div className="tw:flex tw:items-center tw:justify-between tw:gap-4 tw:border-b tw:border-hairline tw:px-3 tw:py-2.5">
        <div className="tw:flex tw:items-center tw:gap-2 tw:font-mono tw:text-[10px] tw:font-semibold tw:tracking-[0.1em] tw:text-cream-muted tw:uppercase">
          <Network className="tw:text-signal" size={14} />
          {c.eyebrow}
        </div>
        <div className="tw:flex tw:items-center tw:gap-2 tw:font-mono tw:text-[10px] tw:font-semibold tw:tracking-[0.1em] tw:text-signal tw:uppercase">
          <span className="tw:size-1.5 tw:animate-pulse tw:rounded-full tw:bg-signal tw:motion-reduce:animate-none" />
          {c.status}
        </div>
      </div>

      <div className="tw:relative tw:overflow-hidden tw:bg-control-grid tw:[background-size:36px_36px] tw:p-[clamp(18px,4vw,34px)]">
        <svg
          className="tw:pointer-events-none tw:absolute tw:inset-0 tw:h-full tw:w-full tw:text-signal/35"
          aria-hidden="true"
          viewBox="0 0 640 500"
          preserveAspectRatio="none"
        >
          <path
            className="tw:animate-[landing-dash_4s_linear_infinite] tw:[stroke-dasharray:8_8] tw:motion-reduce:animate-none"
            d="M320 84 V226 M144 252 H496 M320 278 V418"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          />
        </svg>

        <div className="tw:relative tw:grid tw:grid-cols-[minmax(0,1fr)_44px_minmax(0,1fr)] tw:items-center tw:gap-y-8 tw:max-[620px]:grid-cols-1 tw:max-[620px]:gap-3">
          <div className="tw:col-span-3 tw:mx-auto tw:w-full tw:max-w-[430px] tw:max-[620px]:col-span-1">
            <TopologyNode
              icon={Users}
              label={c.workspaceLabel}
              value={c.workspaceValue}
              meta={c.workspaceMeta}
            />
          </div>

          <TopologyNode
            icon={KeyRound}
            label={c.memberLabel}
            value={c.memberValue}
            meta={c.memberMeta}
          />
          <div className="tw:flex tw:items-center tw:justify-center tw:text-signal tw:max-[620px]:rotate-90" aria-hidden="true">
            <ArrowRight size={18} />
          </div>
          <TopologyNode
            icon={Bot}
            label={c.agentLabel}
            value={c.agentValue}
            meta={c.agentMeta}
          />

          <div className="tw:col-span-3 tw:mx-auto tw:w-full tw:max-w-[430px] tw:max-[620px]:col-span-1">
            <TopologyNode
              icon={Database}
              label={c.databaseLabel}
              value={c.databaseValue}
              meta={c.databaseMeta}
            />
          </div>
        </div>
      </div>

      <div className="tw:grid tw:grid-cols-2 tw:gap-px tw:bg-hairline tw:max-[480px]:grid-cols-1">
        {[c.seal, c.receipt].map((label) => (
          <div
            className="tw:flex tw:items-center tw:gap-2 tw:bg-night-raised tw:px-3 tw:py-2.5 tw:font-mono tw:text-[10px] tw:font-medium tw:tracking-[0.08em] tw:text-cream-muted tw:uppercase"
            key={label}
          >
            <CircleDot className="tw:text-signal" size={13} />
            {label}
          </div>
        ))}
      </div>
    </div>
  );
}

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
  const currentYear = new Date().getFullYear();

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
    <main className="tw:overflow-clip tw:bg-night tw:text-cream" lang={lang}>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <a
        className="tw:fixed tw:top-3 tw:left-3 tw:z-50 tw:-translate-y-24 tw:bg-signal tw:px-4 tw:py-3 tw:font-mono tw:text-xs tw:font-semibold tw:text-night tw:uppercase tw:focus:translate-y-0"
        href="#content"
      >
        {c.nav.skip}
      </a>

      <header className="tw:sticky tw:top-0 tw:z-40 tw:border-b tw:border-hairline tw:bg-night/82 tw:backdrop-blur-xl">
        <div className="tw:mx-auto tw:flex tw:min-h-16 tw:max-w-[1520px] tw:items-center tw:justify-between tw:gap-5 tw:px-[clamp(16px,4vw,64px)]">
          <a className="tw:flex tw:items-center tw:gap-3" href="#top" aria-label={c.nav.home}>
            <span className="tw:relative tw:grid tw:size-8 tw:place-items-center tw:border tw:border-signal/50 tw:bg-signal tw:text-night">
              <Database size={16} strokeWidth={2.2} />
              <span className="tw:absolute tw:-right-1 tw:-bottom-1 tw:size-2 tw:border tw:border-night tw:bg-electric" />
            </span>
            <span className="tw:font-display tw:text-[17px] tw:tracking-[-0.03em]">
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

      <div id="content">
        <section
          className="tw:relative tw:isolate tw:border-b tw:border-hairline tw:bg-ambient"
          id="top"
        >
          <div className="tw:pointer-events-none tw:absolute tw:inset-0 tw:-z-10 tw:bg-control-grid tw:[background-size:48px_48px] tw:[mask-image:linear-gradient(to_bottom,black,transparent_92%)]" />
          <div className="tw:pointer-events-none tw:absolute tw:top-[16%] tw:left-[44%] tw:-z-10 tw:h-[460px] tw:w-[460px] tw:rounded-full tw:bg-signal/8 tw:blur-[110px]" />

          <div className="tw:mx-auto tw:grid tw:min-h-[calc(100dvh-64px)] tw:max-w-[1520px] tw:grid-cols-[minmax(0,0.95fr)_minmax(480px,0.85fr)] tw:items-center tw:gap-[clamp(44px,7vw,112px)] tw:px-[clamp(16px,4vw,64px)] tw:py-[clamp(72px,10vw,150px)] tw:max-[1080px]:grid-cols-1 tw:max-[1080px]:pt-20">
            <div className="tw:max-w-[830px]">
              <div className="tw:animate-[landing-rise_.7s_ease-out_both] tw:motion-reduce:animate-none">
                <SectionLabel>{c.hero.eyebrow}</SectionLabel>
              </div>
              <h1 className="tw:mt-7 tw:font-display tw:text-[clamp(54px,7.6vw,124px)] tw:leading-[0.86] tw:tracking-[-0.065em] tw:text-balance tw:animate-[landing-rise_.8s_.08s_ease-out_both] tw:[animation-fill-mode:both] tw:motion-reduce:animate-none">
                <span className="tw:block">{c.hero.headline}</span>
                <span className="tw:mt-[0.08em] tw:block tw:text-signal">{c.hero.accent}</span>
              </h1>
              <p className="tw:mt-8 tw:max-w-[680px] tw:text-[clamp(16px,1.45vw,21px)] tw:leading-[1.7] tw:text-cream-muted tw:animate-[landing-rise_.8s_.16s_ease-out_both] tw:[animation-fill-mode:both] tw:motion-reduce:animate-none">
                {c.hero.text}
              </p>
              <div
                className="tw:mt-9 tw:flex tw:flex-wrap tw:gap-3 tw:animate-[landing-rise_.8s_.24s_ease-out_both] tw:[animation-fill-mode:both] tw:motion-reduce:animate-none tw:max-[620px]:grid tw:max-[620px]:grid-cols-1"
                data-primary-flow
              >
                <MarketingButton
                  variant="primary"
                  href={releasesUrl}
                  event="Download Clicked"
                  properties={{ source: "hero", target: "latest_release" }}
                >
                  <Download size={16} />
                  {c.hero.primary}
                </MarketingButton>
                <MarketingButton variant="secondary" href={repoUrl}>
                  {c.hero.secondary}
                  <ArrowUpRight size={16} />
                </MarketingButton>
              </div>
              <p className="tw:mt-6 tw:flex tw:items-center tw:gap-2 tw:font-mono tw:text-[10px] tw:leading-relaxed tw:font-medium tw:tracking-[0.08em] tw:text-cream-muted tw:uppercase">
                <LockKeyhole className="tw:shrink-0 tw:text-signal" size={13} />
                {c.hero.proof}
              </p>
              <a
                className="tw:mt-12 tw:inline-flex tw:items-center tw:gap-2 tw:font-mono tw:text-[10px] tw:font-semibold tw:tracking-[0.1em] tw:text-cream-muted tw:uppercase tw:transition-colors tw:hover:text-signal"
                href="#why"
              >
                {c.nav.access}
                <ArrowDown size={14} />
              </a>
            </div>

            <div className="tw:animate-[landing-rise_.9s_.18s_ease-out_both] tw:[animation-fill-mode:both] tw:motion-reduce:animate-none tw:max-[1080px]:mx-auto tw:max-[1080px]:w-full tw:max-[1080px]:max-w-[760px]">
              <AccessTopology c={c.topology} />
            </div>
          </div>
        </section>

        <dl className="tw:mx-auto tw:grid tw:max-w-[1520px] tw:grid-cols-4 tw:border-x tw:border-hairline tw:bg-night tw:max-[900px]:grid-cols-2 tw:max-[520px]:grid-cols-1">
          {c.proofs.map((proof) => (
            <div
              className="tw:min-w-0 tw:border-b tw:border-r tw:border-hairline tw:px-[clamp(18px,3vw,38px)] tw:py-6 tw:last:border-r-0 tw:max-[900px]:even:border-r-0 tw:max-[520px]:border-r-0"
              key={proof.label}
            >
              <dt className="tw:font-mono tw:text-[9px] tw:font-semibold tw:tracking-[0.12em] tw:text-cream-muted tw:uppercase">
                {proof.label}
              </dt>
              <dd className="tw:mt-2 tw:text-[14px] tw:font-bold tw:text-cream">
                {proof.value}
              </dd>
            </div>
          ))}
        </dl>

        <section
          className="tw:relative tw:bg-cream tw:text-night"
          id="why"
        >
          <div className="tw:pointer-events-none tw:absolute tw:inset-0 tw:bg-diagonal tw:opacity-55" />
          <div className="tw:relative tw:mx-auto tw:grid tw:max-w-[1520px] tw:grid-cols-[minmax(300px,0.75fr)_minmax(0,1.25fr)] tw:gap-[clamp(50px,8vw,140px)] tw:px-[clamp(16px,4vw,64px)] tw:py-[clamp(90px,12vw,180px)] tw:max-[960px]:grid-cols-1">
            <div className="tw:self-start tw:min-[961px]:sticky tw:min-[961px]:top-32">
              <SectionLabel tone="light">{c.boundary.eyebrow}</SectionLabel>
              <h2 className="tw:mt-6 tw:max-w-[650px] tw:font-display tw:text-[clamp(48px,6.8vw,108px)] tw:leading-[0.88] tw:tracking-[-0.06em] tw:text-balance">
                {c.boundary.title}
              </h2>
              <p className="tw:mt-7 tw:max-w-[520px] tw:text-[clamp(16px,1.35vw,20px)] tw:leading-[1.7] tw:text-night/65">
                {c.boundary.body}
              </p>
            </div>

            <div className="tw:border-t tw:border-night/20">
              {c.boundary.items.map((item) => (
                <article
                  className="tw:group tw:grid tw:grid-cols-[90px_minmax(0,1fr)] tw:gap-5 tw:border-b tw:border-night/20 tw:py-[clamp(28px,5vw,58px)] tw:max-[540px]:grid-cols-[56px_minmax(0,1fr)]"
                  key={item.index}
                >
                  <span className="tw:font-display tw:text-[clamp(34px,4vw,68px)] tw:leading-none tw:text-night/14 tw:transition-colors tw:duration-300 tw:group-hover:text-night/30">
                    {item.index}
                  </span>
                  <div>
                    <p className="tw:font-mono tw:text-[10px] tw:font-semibold tw:tracking-[0.12em] tw:text-night/50 tw:uppercase">
                      {item.overline}
                    </p>
                    <h3 className="tw:mt-3 tw:max-w-[700px] tw:text-[clamp(23px,2.65vw,42px)] tw:leading-[1.04] tw:font-bold tw:tracking-[-0.035em] tw:text-balance">
                      {item.title}
                    </h3>
                    <p className="tw:mt-5 tw:max-w-[650px] tw:text-[15px] tw:leading-[1.75] tw:text-night/62">
                      {item.body}
                    </p>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="tw:relative tw:border-y tw:border-hairline tw:bg-night tw:py-[clamp(90px,11vw,170px)]">
          <div className="tw:pointer-events-none tw:absolute tw:inset-0 tw:bg-control-grid tw:opacity-50 tw:[background-size:56px_56px] tw:[mask-image:linear-gradient(to_bottom,transparent,black_20%,black_80%,transparent)]" />
          <div className="tw:relative tw:mx-auto tw:max-w-[1520px] tw:px-[clamp(16px,4vw,64px)]">
            <div className="tw:grid tw:grid-cols-[minmax(0,1fr)_minmax(300px,0.55fr)] tw:items-end tw:gap-12 tw:max-[900px]:grid-cols-1">
              <div>
                <SectionLabel>{c.product.eyebrow}</SectionLabel>
                <h2 className="tw:mt-6 tw:max-w-[980px] tw:font-display tw:text-[clamp(48px,6.8vw,108px)] tw:leading-[0.88] tw:tracking-[-0.06em] tw:text-balance">
                  {c.product.title}
                </h2>
              </div>
              <p className="tw:max-w-[540px] tw:text-[clamp(15px,1.25vw,19px)] tw:leading-[1.75] tw:text-cream-muted">
                {c.product.body}
              </p>
            </div>

            <div className="tw:relative tw:mt-[clamp(52px,7vw,94px)] tw:mx-auto tw:max-w-[1320px] tw:[perspective:1800px]">
              <div className="tw:relative tw:border tw:border-hairline-strong tw:bg-night-raised tw:p-2 tw:shadow-stage tw:[transform:rotateX(2deg)_rotateY(-3deg)] tw:transition-transform tw:duration-500 tw:hover:[transform:rotateX(0deg)_rotateY(0deg)] tw:max-[760px]:[transform:none]">
                <div className="tw:flex tw:h-9 tw:items-center tw:justify-between tw:border-b tw:border-hairline tw:px-3">
                  <div className="tw:flex tw:gap-1.5" aria-hidden="true">
                    <span className="tw:size-2 tw:rounded-full tw:bg-danger" />
                    <span className="tw:size-2 tw:rounded-full tw:bg-warning" />
                    <span className="tw:size-2 tw:rounded-full tw:bg-signal" />
                  </div>
                  <span className="tw:font-mono tw:text-[9px] tw:font-medium tw:tracking-[0.12em] tw:text-cream-muted tw:uppercase">
                    DopeDB Desktop / Local boundary
                  </span>
                </div>
                <div className="tw:overflow-hidden tw:bg-paper">
                  <Image
                    className="tw:block tw:h-auto tw:w-full"
                    src="/dopedb-dashboard.png"
                    alt={c.product.imageAlt}
                    width={1600}
                    height={1120}
                    priority={false}
                  />
                </div>
              </div>

              <div className="tw:absolute tw:-top-8 tw:-left-5 tw:grid tw:max-w-[260px] tw:grid-cols-[34px_1fr] tw:gap-3 tw:border tw:border-hairline-strong tw:bg-night/92 tw:p-3 tw:shadow-stage tw:backdrop-blur-lg tw:max-[760px]:static tw:max-[760px]:mt-3 tw:max-[760px]:max-w-none">
                <span className="tw:grid tw:size-[34px] tw:place-items-center tw:bg-electric tw:text-night">
                  <Network size={16} />
                </span>
                <div>
                  <p className="tw:font-mono tw:text-[9px] tw:font-semibold tw:tracking-[0.1em] tw:text-electric tw:uppercase">
                    {c.product.labels[0].title}
                  </p>
                  <p className="tw:mt-1 tw:text-xs tw:text-cream-muted">
                    {c.product.labels[0].body}
                  </p>
                </div>
              </div>

              <div className="tw:absolute tw:-right-5 tw:-bottom-8 tw:grid tw:max-w-[280px] tw:grid-cols-[34px_1fr] tw:gap-3 tw:border tw:border-signal/40 tw:bg-night/92 tw:p-3 tw:shadow-stage tw:backdrop-blur-lg tw:max-[760px]:static tw:max-[760px]:mt-3 tw:max-[760px]:max-w-none">
                <span className="tw:grid tw:size-[34px] tw:place-items-center tw:bg-signal tw:text-night">
                  <SquareTerminal size={16} />
                </span>
                <div>
                  <p className="tw:font-mono tw:text-[9px] tw:font-semibold tw:tracking-[0.1em] tw:text-signal tw:uppercase">
                    {c.product.labels[1].title}
                  </p>
                  <p className="tw:mt-1 tw:text-xs tw:text-cream-muted">
                    {c.product.labels[1].body}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section
          className="tw:relative tw:bg-signal tw:bg-signal-grid tw:text-night tw:[background-size:40px_40px]"
          id="safety"
        >
          <div className="tw:mx-auto tw:max-w-[1520px] tw:px-[clamp(16px,4vw,64px)] tw:py-[clamp(90px,11vw,160px)]">
            <div className="tw:grid tw:grid-cols-[minmax(0,1fr)_minmax(280px,0.5fr)] tw:items-end tw:gap-12 tw:max-[900px]:grid-cols-1">
              <div>
                <SectionLabel tone="signal">{c.principles.eyebrow}</SectionLabel>
                <h2 className="tw:mt-6 tw:max-w-[940px] tw:font-display tw:text-[clamp(52px,7.4vw,118px)] tw:leading-[0.85] tw:tracking-[-0.065em] tw:text-balance">
                  {c.principles.title}
                </h2>
              </div>
              <p className="tw:max-w-[520px] tw:text-[clamp(16px,1.35vw,20px)] tw:leading-[1.7] tw:text-night/68">
                {c.principles.body}
              </p>
            </div>

            <div className="tw:mt-[clamp(50px,7vw,90px)] tw:grid tw:grid-cols-3 tw:border-y tw:border-night/25 tw:max-[840px]:grid-cols-1">
              {c.principles.items.map((item) => (
                <article
                  className="tw:border-r tw:border-night/25 tw:px-[clamp(0px,3vw,42px)] tw:py-9 tw:first:pl-0 tw:last:border-r-0 tw:last:pr-0 tw:max-[840px]:border-r-0 tw:max-[840px]:border-b tw:max-[840px]:px-0 tw:max-[840px]:last:border-b-0"
                  key={item.title}
                >
                  <span className="tw:grid tw:size-11 tw:place-items-center tw:bg-night tw:text-signal">
                    <item.icon size={20} strokeWidth={1.8} />
                  </span>
                  <h3 className="tw:mt-7 tw:text-[clamp(23px,2vw,32px)] tw:font-extrabold tw:tracking-[-0.035em]">
                    {item.title}
                  </h3>
                  <p className="tw:mt-4 tw:max-w-[420px] tw:text-[15px] tw:leading-[1.7] tw:text-night/65">
                    {item.body}
                  </p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section
          className="tw:relative tw:border-b tw:border-hairline tw:bg-night"
          id="flow"
        >
          <div className="tw:mx-auto tw:grid tw:max-w-[1520px] tw:grid-cols-[minmax(380px,0.82fr)_minmax(0,1fr)] tw:gap-[clamp(50px,8vw,130px)] tw:px-[clamp(16px,4vw,64px)] tw:py-[clamp(90px,12vw,180px)] tw:max-[980px]:grid-cols-1">
            <div className="tw:self-start tw:min-[981px]:sticky tw:min-[981px]:top-28">
              <SectionLabel>{c.workflow.eyebrow}</SectionLabel>
              <h2 className="tw:mt-6 tw:max-w-[740px] tw:font-display tw:text-[clamp(48px,6.4vw,100px)] tw:leading-[0.88] tw:tracking-[-0.06em] tw:text-balance">
                {c.workflow.title}
              </h2>
              <p className="tw:mt-7 tw:max-w-[560px] tw:text-[clamp(15px,1.25vw,19px)] tw:leading-[1.75] tw:text-cream-muted">
                {c.workflow.body}
              </p>

              <div className="tw:mt-10 tw:overflow-hidden tw:border tw:border-hairline-strong tw:bg-night-raised tw:shadow-stage">
                <div className="tw:flex tw:h-10 tw:items-center tw:justify-between tw:border-b tw:border-hairline tw:px-3.5">
                  <div className="tw:flex tw:items-center tw:gap-2 tw:font-mono tw:text-[9px] tw:font-semibold tw:tracking-[0.12em] tw:text-cream-muted tw:uppercase">
                    <SquareTerminal className="tw:text-signal" size={14} />
                    Operation console
                  </div>
                  <span className="tw:flex tw:items-center tw:gap-2 tw:font-mono tw:text-[9px] tw:text-warning tw:uppercase">
                    <span className="tw:size-1.5 tw:rounded-full tw:bg-warning" />
                    Awaiting approval
                  </span>
                </div>
                <pre className="tw:m-0 tw:overflow-x-auto tw:p-[clamp(18px,3vw,30px)] tw:font-mono tw:text-[clamp(11px,1.05vw,14px)] tw:leading-[1.72] tw:text-cream-muted">
                  <code className="tw:font-mono">{c.workflow.terminal}</code>
                </pre>
              </div>
            </div>

            <ol className="tw:border-t tw:border-hairline-strong">
              {c.workflow.steps.map((step) => (
                <li
                  className="tw:group tw:grid tw:grid-cols-[66px_minmax(0,1fr)_28px] tw:items-start tw:gap-5 tw:border-b tw:border-hairline-strong tw:py-[clamp(26px,4vw,46px)]"
                  key={step.index}
                >
                  <span className="tw:font-mono tw:text-[11px] tw:font-semibold tw:tracking-[0.12em] tw:text-signal">
                    / {step.index}
                  </span>
                  <div>
                    <h3 className="tw:text-[clamp(24px,2.4vw,38px)] tw:leading-none tw:font-bold tw:tracking-[-0.04em]">
                      {step.title}
                    </h3>
                    <p className="tw:mt-4 tw:max-w-[560px] tw:text-[15px] tw:leading-[1.7] tw:text-cream-muted">
                      {step.body}
                    </p>
                  </div>
                  <ArrowRight className="tw:mt-1 tw:text-cream/25 tw:transition-[color,transform] tw:duration-300 tw:group-hover:translate-x-1 tw:group-hover:text-signal" size={20} />
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="tw:bg-cream tw:text-night">
          <div className="tw:mx-auto tw:grid tw:max-w-[1520px] tw:grid-cols-[minmax(300px,0.72fr)_minmax(0,1.28fr)] tw:gap-[clamp(50px,8vw,140px)] tw:px-[clamp(16px,4vw,64px)] tw:py-[clamp(90px,11vw,160px)] tw:max-[940px]:grid-cols-1">
            <div>
              <SectionLabel tone="light">{c.faq.eyebrow}</SectionLabel>
              <h2 className="tw:mt-6 tw:max-w-[650px] tw:font-display tw:text-[clamp(46px,5.8vw,92px)] tw:leading-[0.9] tw:tracking-[-0.055em] tw:text-balance">
                {c.faq.title}
              </h2>
            </div>

            <div className="tw:border-t tw:border-night/20">
              {c.faq.items.map((item) => (
                <details className="tw:group tw:border-b tw:border-night/20" key={item.question}>
                  <summary className="tw:flex tw:cursor-pointer tw:list-none tw:items-start tw:justify-between tw:gap-6 tw:py-6 tw:text-[clamp(18px,1.7vw,25px)] tw:leading-tight tw:font-bold tw:tracking-[-0.025em] tw:[&::-webkit-details-marker]:hidden">
                    {item.question}
                    <ChevronRight className="tw:mt-1 tw:shrink-0 tw:text-night/40 tw:transition-transform tw:duration-200 tw:group-open:rotate-90" size={20} />
                  </summary>
                  <p className="tw:max-w-[720px] tw:pb-7 tw:pr-12 tw:text-[15px] tw:leading-[1.75] tw:text-night/62">
                    {item.answer}
                  </p>
                </details>
              ))}
            </div>
          </div>
        </section>

        <section
          className="tw:relative tw:isolate tw:overflow-hidden tw:border-y tw:border-hairline tw:bg-night"
          id="download"
        >
          <div className="tw:pointer-events-none tw:absolute tw:inset-0 tw:-z-10 tw:bg-control-grid tw:opacity-60 tw:[background-size:44px_44px]" />
          <div className="tw:pointer-events-none tw:absolute tw:-right-[0.06em] tw:-bottom-[0.18em] tw:-z-10 tw:font-display tw:text-[clamp(180px,35vw,560px)] tw:leading-none tw:tracking-[-0.08em] tw:text-cream/[0.025] tw:select-none">
            ALPHA
          </div>

          <div className="tw:mx-auto tw:grid tw:max-w-[1520px] tw:grid-cols-[minmax(0,1fr)_minmax(340px,0.72fr)] tw:items-center tw:gap-[clamp(50px,8vw,130px)] tw:px-[clamp(16px,4vw,64px)] tw:py-[clamp(100px,14vw,210px)] tw:max-[940px]:grid-cols-1">
            <div>
              <SectionLabel>{c.download.eyebrow}</SectionLabel>
              <h2 className="tw:mt-6 tw:max-w-[900px] tw:font-display tw:text-[clamp(50px,7vw,116px)] tw:leading-[0.86] tw:tracking-[-0.065em] tw:text-balance">
                {c.download.title}
              </h2>
              <p className="tw:mt-7 tw:max-w-[650px] tw:text-[clamp(16px,1.35vw,20px)] tw:leading-[1.7] tw:text-cream-muted">
                {c.download.body}
              </p>
            </div>

            <div data-primary-flow>
              <div className="tw:flex tw:flex-wrap tw:gap-3 tw:max-[620px]:grid tw:max-[620px]:grid-cols-1">
                <MarketingButton
                  variant="primary"
                  href={releasesUrl}
                  event="Download Clicked"
                  properties={{ source: "download_section", target: "latest_release" }}
                >
                  <Download size={16} />
                  {c.download.primary}
                </MarketingButton>
                <MarketingButton
                  variant="secondary"
                  href={`${repoUrl}/blob/main/docs/PROJECT.md#development`}
                >
                  {c.download.source}
                  <ArrowUpRight size={16} />
                </MarketingButton>
              </div>

              <div className="tw:mt-5 tw:grid tw:grid-cols-3 tw:gap-px tw:bg-hairline tw:max-[620px]:grid-cols-1">
                {[
                  {
                    href: downloadUrls.windows,
                    label: c.download.windows,
                    target: "windows_x64_installer",
                  },
                  {
                    href: downloadUrls.macApple,
                    label: c.download.macApple,
                    target: "macos_arm64_dmg",
                  },
                  {
                    href: downloadUrls.macIntel,
                    label: c.download.macIntel,
                    target: "macos_x64_dmg",
                  },
                ].map((platform) => (
                  <TrackedLink
                    className="tw:flex tw:min-h-[72px] tw:items-center tw:justify-between tw:gap-3 tw:bg-night-raised tw:px-4 tw:font-mono tw:text-[10px] tw:font-medium tw:leading-relaxed tw:tracking-[0.06em] tw:text-cream-muted tw:uppercase tw:transition-colors tw:hover:bg-night-soft tw:hover:text-cream"
                    href={platform.href}
                    event="Download Clicked"
                    properties={{ source: "platform_grid", target: platform.target }}
                    key={platform.target}
                  >
                    {platform.label}
                    <ArrowDown className="tw:shrink-0 tw:text-signal" size={14} />
                  </TrackedLink>
                ))}
              </div>

              <div className="tw:mt-5 tw:flex tw:gap-3 tw:border tw:border-warning/30 tw:bg-warning/5 tw:p-4">
                <LockKeyhole className="tw:mt-0.5 tw:shrink-0 tw:text-warning" size={17} />
                <div>
                  <h3 className="tw:text-[13px] tw:font-bold tw:text-cream">
                    {c.download.warningTitle}
                  </h3>
                  <p className="tw:mt-1.5 tw:text-xs tw:leading-relaxed tw:text-cream-muted">
                    {c.download.warningBody}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="tw:bg-night" id="docs">
          <div className="tw:mx-auto tw:max-w-[1520px] tw:px-[clamp(16px,4vw,64px)] tw:py-[clamp(78px,9vw,130px)]">
            <div className="tw:grid tw:grid-cols-[minmax(280px,0.62fr)_minmax(0,1.38fr)] tw:gap-[clamp(40px,7vw,110px)] tw:max-[860px]:grid-cols-1">
              <div>
                <SectionLabel>{c.docs.eyebrow}</SectionLabel>
                <h2 className="tw:mt-6 tw:max-w-[580px] tw:text-[clamp(34px,4.5vw,68px)] tw:leading-[0.96] tw:font-extrabold tw:tracking-[-0.05em] tw:text-balance">
                  {c.docs.title}
                </h2>
              </div>
              <div className="tw:grid tw:grid-cols-3 tw:gap-px tw:bg-hairline tw:max-[760px]:grid-cols-1">
                {c.docs.items.map((doc, index) => (
                  <TrackedLink
                    className="tw:group tw:relative tw:flex tw:min-h-[230px] tw:flex-col tw:bg-night-raised tw:p-6 tw:transition-colors tw:hover:bg-night-soft"
                    href={doc.href}
                    key={doc.title}
                  >
                    <span className="tw:font-mono tw:text-[9px] tw:font-semibold tw:tracking-[0.1em] tw:text-signal tw:uppercase">
                      DOC / 0{index + 1}
                    </span>
                    <span className="tw:mt-7 tw:text-[21px] tw:font-bold tw:tracking-[-0.03em] tw:text-cream">
                      {doc.title}
                    </span>
                    <p className="tw:mt-3 tw:max-w-[300px] tw:text-[13px] tw:leading-relaxed tw:text-cream-muted">
                      {doc.body}
                    </p>
                    <ExternalLink className="tw:mt-auto tw:translate-y-1 tw:self-end tw:text-cream/25 tw:transition-[color,transform] tw:duration-200 tw:group-hover:translate-y-0 tw:group-hover:text-signal" size={17} />
                  </TrackedLink>
                ))}
              </div>
            </div>
          </div>
        </section>
      </div>

      <footer className="tw:border-t tw:border-hairline tw:bg-night">
        <div className="tw:mx-auto tw:flex tw:max-w-[1520px] tw:items-center tw:justify-between tw:gap-6 tw:px-[clamp(16px,4vw,64px)] tw:py-7 tw:max-[680px]:flex-col tw:max-[680px]:items-start">
          <div className="tw:flex tw:items-center tw:gap-3">
            <span className="tw:grid tw:size-7 tw:place-items-center tw:bg-signal tw:text-night">
              <Database size={14} />
            </span>
            <div>
              <p className="tw:text-sm tw:font-bold">© {currentYear} DopeDB</p>
              <p className="tw:mt-1 tw:font-mono tw:text-[9px] tw:tracking-[0.07em] tw:text-cream-muted tw:uppercase">
                {c.footer.statement}
              </p>
            </div>
          </div>
          <nav className="tw:flex tw:items-center tw:gap-5 tw:font-mono tw:text-[9px] tw:font-medium tw:tracking-[0.08em] tw:text-cream-muted tw:uppercase" aria-label="Legal">
            <a className="tw:transition-colors tw:hover:text-signal" href={lang === "ko" ? "/ko/privacy" : "/privacy"}>
              {c.footer.privacy}
            </a>
            <a className="tw:transition-colors tw:hover:text-signal" href={lang === "ko" ? "/ko/terms" : "/terms"}>
              {c.footer.terms}
            </a>
          </nav>
        </div>
      </footer>
    </main>
  );
}
