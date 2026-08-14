// Public-site URLs and bilingual copy are the landing page's stable content contract.
import { FileClock, Fingerprint, ShieldCheck } from "lucide-react";

export const repoUrl = "https://github.com/json-choi/dopedb";
export const releasesUrl = `${repoUrl}/releases/latest`;
export const workspaceSiteUrl = "https://app.dopedb.dev";
export const downloadUrls = {
  windows: `${repoUrl}/releases/latest/download/DopeDB-windows-x64-setup.exe`,
  macApple: `${repoUrl}/releases/latest/download/DopeDB-macos-arm64.dmg`,
  macIntel: `${repoUrl}/releases/latest/download/DopeDB-macos-x64.dmg`,
};
export const siteUrl = "https://dopedb.dev";
// Keep in sync with the required local tools in docs/PROJECT.md#development.
export const buildToolchain = "Rust 1.94+ · Node.js 24 · pnpm 11.17.0";

export type Lang = "en" | "ko";

export const workspaceUrls: Record<Lang, string> = {
  en: `${workspaceSiteUrl}/settings`,
  ko: `${workspaceSiteUrl}/ko/settings`,
};

export const homeCopy = {
  en: {
    nav: {
      access: "Shared access",
      boundary: "Control boundary",
      flow: "How it works",
      workspace: "Open workspace",
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
      secondary: "Open team workspace",
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
      sourceNote: `Building from source needs ${buildToolchain}.`,
      windows: "Windows x64",
      macApple: "macOS Apple Silicon",
      macIntel: "macOS Intel",
      macWarningTitle: "Legacy macOS alpha releases may show a developer warning.",
      macWarningBody:
        "For releases published before Developer ID notarization, confirm the file came from GitHub Releases, then use System Settings → Privacy & Security → Open Anyway.",
      windowsWarningTitle: "Windows alpha installers may show a SmartScreen warning.",
      windowsWarningBody:
        "The installer is not code-signed yet. Confirm the file came from GitHub Releases, then choose More info → Run anyway.",
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
      workspace: "Team workspace",
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
      workspace: "워크스페이스 열기",
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
      secondary: "팀 워크스페이스 열기",
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
      sourceNote: `소스에서 빌드하려면 ${buildToolchain}이 필요합니다.`,
      windows: "Windows x64",
      macApple: "macOS Apple Silicon",
      macIntel: "macOS Intel",
      macWarningTitle: "이전 macOS Alpha 릴리스에는 개발자 확인 경고가 표시될 수 있습니다.",
      macWarningBody:
        "Developer ID 공증 전에 발행된 릴리스라면 GitHub Releases에서 받은 파일인지 확인한 뒤 System Settings → Privacy & Security → Open Anyway를 사용하세요.",
      windowsWarningTitle: "Windows Alpha 설치본에는 SmartScreen 경고가 표시될 수 있습니다.",
      windowsWarningBody:
        "설치 파일에 아직 코드 서명이 없습니다. GitHub Releases에서 받은 파일인지 확인한 뒤 추가 정보 → 실행을 선택하세요.",
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
      workspace: "팀 워크스페이스",
      privacy: "개인정보처리방침",
      terms: "이용약관",
    },
    jsonDescription:
      "DopeDB는 팀이 DB 인증정보 대신 연결과 정책을 공유하고, Codex와 Claude가 정확한 연결에 고정된 로컬 권한 경계 안에서 일하게 하는 오픈소스 데이터베이스 워크스페이스입니다.",
  },
};


export type HomeCopy = (typeof homeCopy)[Lang];
