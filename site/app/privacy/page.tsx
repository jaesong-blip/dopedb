// Public privacy policy used by the website, workspace service, and Google OAuth
// verification. It describes only data paths implemented by the current product.
import type { Metadata } from "next";
import { LegalDocument, type LegalSection } from "../components/LegalDocument";

const siteUrl = "https://dopedb.dev";
const effectiveDate = "July 31, 2026";

type PrivacyProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

const content: Record<"en" | "ko", {
  title: string;
  description: string;
  sections: LegalSection[];
}> = {
  en: {
    title: "Privacy Policy",
    description:
      "This policy explains what DopeDB processes across its public website, desktop app, workspace service, and optional managed database connections.",
    sections: [
      {
        title: "Who operates DopeDB",
        paragraphs: [
          "DopeDB is an open-source database client and workspace service operated by Jaesong Choi. Questions or privacy requests can be sent to cjs5241@gmail.com.",
        ],
      },
      {
        title: "Information we process",
        items: [
          "Account data: your Google account identifier, verified email address, name, profile image, sign-in session, and the workspaces, memberships, roles, and invitations associated with your account.",
          "Workspace data: shared connection templates, environment and safety settings, access grants, redacted provider selectors, revisions, backup metadata, and workspace audit events. Shared templates do not contain database passwords, tokens, certificates, embedded-credential URLs, or local secret references.",
          "Google Cloud setup data: the Google account email, selected project and Cloud SQL instance metadata, requested OAuth scopes, and a short-lived access token used to configure the selected resource. DopeDB does not request or retain a Google refresh token or service-account key. The setup token is encrypted and expires within ten minutes.",
          "Managed-access data: provider identity and resource metadata, encrypted provider authorization when a provider requires it, and short-lived member-specific database credentials. One-time database credentials are returned to the authenticated desktop app and are not stored in the workspace database.",
          "Local desktop data: database credentials, certificates, advanced connection parameters, query history, and full execution audit data remain on the device or in its operating-system credential store unless you deliberately publish supported workspace metadata.",
          "Website data: Vercel may process request, device, referral, and aggregate usage information needed to host, secure, and measure dopedb.dev. DopeDB does not use this website data to build advertising profiles.",
        ],
      },
      {
        title: "How we use information",
        items: [
          "Authenticate users and devices, maintain sessions, and enforce workspace membership and role boundaries.",
          "Create and synchronize shared connection templates, access policy, revisions, backups, invitations, and audit records.",
          "Discover a cloud resource selected by an administrator and configure narrowly scoped, keyless managed database access.",
          "Protect the service, investigate failures, prevent abuse, and comply with legal obligations.",
          "Measure public website reliability and usage so the documentation and download flow can be improved.",
        ],
      },
      {
        title: "Google user data",
        paragraphs: [
          "DopeDB requests Google identity scopes for sign-in and, only when a workspace administrator starts Google Cloud SQL setup, the Google Cloud platform scope needed to discover and configure resources that the administrator selects. Authorization is requested at that moment rather than during ordinary sign-in.",
          "Google Cloud access is used only to list accessible projects and Cloud SQL instances, validate the selected instance, and perform the administrator-approved keyless setup. It is not used for advertising, credit decisions, or training general-purpose AI models.",
          "DopeDB's use and transfer of information received from Google APIs adheres to the Google API Services User Data Policy, including the Limited Use requirements.",
        ],
      },
      {
        title: "When information is shared",
        paragraphs: [
          "We disclose information only to operate the service, follow your instructions, or meet legal requirements. Service providers can include Google for identity and Cloud APIs, Vercel for hosting, analytics, and workload identity, Neon for the workspace database, Resend for configured invitation email, and a database provider you deliberately connect. Each provider processes data under its own terms.",
          "Workspace information is visible according to workspace roles and connection grants. We do not sell personal information or share it for cross-context behavioral advertising.",
        ],
      },
      {
        title: "Retention and deletion",
        items: [
          "Google Cloud setup sessions and their encrypted access tokens expire within ten minutes. Managed database credentials normally expire within fifteen minutes.",
          "Browser and desktop account sessions expire according to the product's session policy; current browser sessions are configured for up to thirty days unless revoked sooner.",
          "Workspace records, connection metadata, revisions, backups, and audit events are retained while needed to provide and secure the workspace or until an authorized user deletes them, subject to legal and security retention requirements.",
          "Local desktop data remains until you remove the connection, clear the related history, uninstall the app, or delete the operating-system credential item.",
        ],
      },
      {
        title: "Security",
        paragraphs: [
          "DopeDB uses encrypted transport, server-side authorization checks, short-lived credentials, encrypted provider authorization, keyless Google Cloud federation, redacted logs and backups, and operating-system credential storage. No system is perfectly secure, so users should still grant the minimum cloud and database privileges required.",
        ],
      },
      {
        title: "Your choices and rights",
        items: [
          "You can disconnect a provider integration, revoke DopeDB in your Google Account permissions, sign out devices, leave a workspace, or ask a workspace administrator to change or remove your membership.",
          "You may request access, correction, deletion, restriction, or a copy of personal information where applicable by emailing cjs5241@gmail.com. We may verify your identity and authority before acting.",
          "You can use the local desktop features without enabling an optional managed provider integration.",
        ],
      },
      {
        title: "International processing, children, and changes",
        paragraphs: [
          "DopeDB and its service providers may process information in countries other than your own. We use the safeguards offered by the relevant provider and applicable law. DopeDB is a developer tool and is not directed to children under 16.",
          "We may update this policy as the product or law changes. Material updates will be posted here with a revised effective date.",
        ],
      },
    ],
  },
  ko: {
    title: "개인정보처리방침",
    description:
      "이 방침은 DopeDB 공개 웹사이트, 데스크톱 앱, 워크스페이스 서비스와 선택형 관리형 데이터베이스 연결에서 처리하는 정보를 설명합니다.",
    sections: [
      {
        title: "운영자와 문의처",
        paragraphs: [
          "DopeDB는 최재성이 운영하는 오픈소스 데이터베이스 클라이언트 및 워크스페이스 서비스입니다. 개인정보 관련 문의와 권리 요청은 cjs5241@gmail.com으로 보낼 수 있습니다.",
        ],
      },
      {
        title: "처리하는 정보",
        items: [
          "계정 정보: Google 계정 식별자, 인증된 이메일 주소, 이름, 프로필 이미지, 로그인 세션, 계정과 연결된 워크스페이스·멤버십·역할·초대 정보.",
          "워크스페이스 정보: 공유 연결 템플릿, 환경·안전 설정, 접근 권한, 비밀값이 제거된 공급자 선택 정보, 버전, 백업 메타데이터, 워크스페이스 감사 이벤트. 공유 템플릿에는 DB 비밀번호, 토큰, 인증서, 인증 정보가 포함된 URL, 로컬 비밀값 참조를 저장하지 않습니다.",
          "Google Cloud 설정 정보: Google 계정 이메일, 선택한 프로젝트와 Cloud SQL 인스턴스 메타데이터, 요청한 OAuth 범위, 선택한 리소스 설정에 사용하는 단기 액세스 토큰. Google 갱신 토큰이나 서비스 계정 키는 요청하거나 보관하지 않습니다. 설정 토큰은 암호화되며 10분 안에 만료됩니다.",
          "관리형 접근 정보: 공급자 계정·리소스 메타데이터, 공급자가 요구하는 경우 암호화된 공급자 승인 정보, 구성원별 단기 DB 자격 증명. 일회성 DB 자격 증명은 인증된 데스크톱 앱에 한 번 반환되며 워크스페이스 DB에 저장하지 않습니다.",
          "로컬 데스크톱 정보: DB 자격 증명, 인증서, 고급 연결 파라미터, 쿼리 기록, 전체 실행 감사 정보는 사용자가 지원되는 워크스페이스 메타데이터를 명시적으로 게시하지 않는 한 기기 또는 운영체제 자격 증명 저장소에 남습니다.",
          "웹사이트 정보: Vercel은 dopedb.dev를 호스팅·보호하고 이용 현황을 집계하기 위해 요청, 기기, 유입 경로와 집계 사용 정보를 처리할 수 있습니다. DopeDB는 이를 광고 프로필 생성에 사용하지 않습니다.",
        ],
      },
      {
        title: "이용 목적",
        items: [
          "사용자와 기기를 인증하고 세션을 유지하며 워크스페이스 멤버십과 역할 경계를 집행합니다.",
          "공유 연결 템플릿, 접근 정책, 버전, 백업, 초대, 감사 기록을 생성하고 동기화합니다.",
          "관리자가 선택한 클라우드 리소스를 탐색하고 최소 범위의 키 없는 관리형 DB 접근을 구성합니다.",
          "서비스 보호, 장애 조사, 남용 방지, 법적 의무 준수를 위해 사용합니다.",
          "공개 웹사이트의 안정성과 이용 현황을 파악해 문서와 다운로드 흐름을 개선합니다.",
        ],
      },
      {
        title: "Google 사용자 데이터",
        paragraphs: [
          "일반 로그인에는 Google 신원 범위만 요청합니다. 워크스페이스 관리자가 Google Cloud SQL 설정을 시작한 경우에만 관리자가 선택한 리소스를 탐색·설정하는 데 필요한 Google Cloud platform 범위를 추가로 요청합니다.",
          "Google Cloud 접근은 접근 가능한 프로젝트와 Cloud SQL 인스턴스 조회, 선택한 인스턴스 검증, 관리자가 승인한 키 없는 설정에만 사용합니다. 광고, 신용 결정 또는 범용 AI 모델 학습에는 사용하지 않습니다.",
          "DopeDB의 Google API 정보 사용과 이전은 제한적 사용 요건을 포함한 Google API 서비스 사용자 데이터 정책을 준수합니다.",
        ],
      },
      {
        title: "정보 제공과 처리 위탁",
        paragraphs: [
          "서비스 운영, 사용자의 지시 이행 또는 법적 요구에 필요한 경우에만 정보를 제공합니다. 처리 서비스에는 신원 및 Cloud API를 위한 Google, 호스팅·분석·워크로드 신원을 위한 Vercel, 워크스페이스 DB를 위한 Neon, 설정된 초대 이메일을 위한 Resend, 사용자가 연결한 DB 공급자가 포함될 수 있습니다. 각 공급자는 자체 약관에 따라 정보를 처리합니다.",
          "워크스페이스 정보는 역할과 연결 권한에 따라 구성원에게 표시됩니다. 개인정보를 판매하거나 행태 광고 목적으로 공유하지 않습니다.",
        ],
      },
      {
        title: "보유와 삭제",
        items: [
          "Google Cloud 설정 세션과 암호화된 액세스 토큰은 10분 안에 만료되며, 관리형 DB 자격 증명은 일반적으로 15분 안에 만료됩니다.",
          "브라우저와 데스크톱 계정 세션은 제품 세션 정책에 따라 만료됩니다. 현재 브라우저 세션은 더 일찍 철회하지 않는 한 최대 30일로 구성되어 있습니다.",
          "워크스페이스 레코드, 연결 메타데이터, 버전, 백업, 감사 이벤트는 서비스 제공과 보호에 필요한 기간 또는 권한 있는 사용자가 삭제할 때까지 보유하되 법적·보안상 필요한 보유 기간을 적용할 수 있습니다.",
          "로컬 데스크톱 정보는 연결 제거, 관련 기록 삭제, 앱 제거 또는 운영체제 자격 증명 항목 삭제 시까지 남습니다.",
        ],
      },
      {
        title: "보안",
        paragraphs: [
          "DopeDB는 암호화 통신, 서버 권한 재검증, 단기 자격 증명, 암호화된 공급자 승인, 키 없는 Google Cloud 연합, 비밀값이 제거된 로그와 백업, 운영체제 자격 증명 저장소를 사용합니다. 완전한 보안은 보장할 수 없으므로 사용자도 필요한 최소 클라우드·DB 권한만 부여해야 합니다.",
        ],
      },
      {
        title: "이용자의 선택과 권리",
        items: [
          "공급자 연동 해제, Google 계정에서 DopeDB 권한 철회, 기기 로그아웃, 워크스페이스 탈퇴 또는 관리자에게 멤버십 변경·삭제 요청을 할 수 있습니다.",
          "관련 법률이 허용하는 범위에서 개인정보 열람, 정정, 삭제, 처리 제한 또는 사본을 cjs5241@gmail.com으로 요청할 수 있습니다. 처리 전에 신원과 권한을 확인할 수 있습니다.",
          "선택형 관리형 공급자 연동을 활성화하지 않고 로컬 데스크톱 기능을 사용할 수 있습니다.",
        ],
      },
      {
        title: "국외 처리, 아동, 방침 변경",
        paragraphs: [
          "DopeDB와 서비스 제공자는 이용자의 국가 밖에서 정보를 처리할 수 있으며 해당 공급자와 관련 법률이 제공하는 보호조치를 적용합니다. DopeDB는 개발자 도구이며 16세 미만 아동을 대상으로 하지 않습니다.",
          "제품이나 법률 변경에 따라 이 방침을 수정할 수 있습니다. 중요한 변경은 변경된 시행일과 함께 이 페이지에 게시합니다.",
        ],
      },
    ],
  },
};

function language(value: string | string[] | undefined) {
  return (Array.isArray(value) ? value[0] : value) === "ko" ? "ko" as const : "en" as const;
}

export async function generateMetadata({ searchParams }: PrivacyProps): Promise<Metadata> {
  const params = searchParams ? await searchParams : {};
  const lang = language(params.lang);
  const canonical = lang === "ko" ? "/ko/privacy" : "/privacy";
  return {
    title: content[lang].title,
    description: content[lang].description,
    alternates: {
      canonical,
      languages: { "en-US": "/privacy", "ko-KR": "/ko/privacy" },
    },
  };
}

export default async function PrivacyPage({ searchParams }: PrivacyProps) {
  const params = searchParams ? await searchParams : {};
  const lang = language(params.lang);
  const page = content[lang];
  return (
    <LegalDocument
      {...page}
      effectiveDate={lang === "ko" ? "2026년 7월 31일" : effectiveDate}
      lang={lang}
      alternateHref={lang === "ko" ? "/privacy" : "/ko/privacy"}
      alternateLabel={lang === "ko" ? "English" : "한국어"}
    />
  );
}
