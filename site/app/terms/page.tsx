// Public service terms for the desktop app, workspace service, and optional
// provider integrations. Open-source license rights remain separately governed.
import type { Metadata } from "next";
import { LegalDocument, type LegalSection } from "../components/LegalDocument";

const effectiveDate = "July 31, 2026";

type TermsProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

const content: Record<"en" | "ko", {
  title: string;
  description: string;
  sections: LegalSection[];
}> = {
  en: {
    title: "Terms of Service",
    description:
      "These terms govern the hosted DopeDB workspace service and related distribution channels. The open-source code remains subject to its repository license.",
    sections: [
      {
        title: "Agreement and operator",
        paragraphs: [
          "By accessing the DopeDB workspace service or using a DopeDB-managed integration, you agree to these terms. DopeDB is operated by Jaesong Choi. If you do not agree, do not use the hosted service. Questions can be sent to cjs5241@gmail.com.",
        ],
      },
      {
        title: "The service",
        paragraphs: [
          "DopeDB provides a desktop database client, local agent tooling, and an optional workspace service for sharing redacted connection templates, access policy, provider integrations, revisions, backups, invitations, and audit events. Features can change as the open-source project develops.",
          "The service does not replace database backups, provider audit logs, security review, or professional operational judgment.",
        ],
      },
      {
        title: "Accounts and workspace authority",
        items: [
          "You must provide accurate account information, protect your devices and sessions, and promptly revoke access you no longer control.",
          "Workspace owners and administrators are responsible for membership, roles, connection grants, production approvals, and the consequences of inviting other users.",
          "You may connect or configure only cloud projects, databases, and resources that you are authorized to administer and use.",
        ],
      },
      {
        title: "Database and production safety",
        paragraphs: [
          "Database queries and agent output can be incorrect, destructive, incomplete, or unsuitable for production. You are responsible for reviewing SQL, scope, selected environment, credentials, backups, rollback plans, approvals, and execution results.",
          "DopeDB safety gates reduce risk but do not guarantee that a query is safe or reversible. Production access should use least privilege, database-native controls, tested backups, and independent monitoring.",
        ],
      },
      {
        title: "Agents and third-party services",
        paragraphs: [
          "Codex, Claude, Google Cloud, Vercel, Neon, PlanetScale, Resend, GitHub, and any database provider you connect are independent services governed by their own terms and privacy practices. DopeDB does not control their availability, output, or policy changes.",
          "Local agent authentication is owned by the provider's official CLI. DopeDB does not promise that an agent response is correct and does not authorize you to submit data to an agent that you are not permitted to disclose.",
        ],
      },
      {
        title: "Acceptable use",
        items: [
          "Do not access systems or data without authorization, bypass safety or approval controls, interfere with the service, probe other users' data, distribute malware, or use the service for unlawful activity.",
          "Do not upload secrets into fields intended for shared metadata or attempt to make another workspace member use credentials they did not receive lawfully.",
          "Do not misrepresent DopeDB, its security properties, or your authority over a connected resource.",
        ],
      },
      {
        title: "Open source and content",
        paragraphs: [
          "Rights to the DopeDB source code are granted under the license included in the public repository. These service terms do not take away those license rights. DopeDB names, logos, hosted service, and project materials not covered by an open-source license remain protected by applicable law.",
          "You retain rights in content and metadata you provide. You grant DopeDB only the permission necessary to host, process, secure, and transmit that material to provide the service and follow your instructions.",
        ],
      },
      {
        title: "Availability, changes, and termination",
        paragraphs: [
          "The service is provided without a guaranteed uptime or support level. We may modify, suspend, rate-limit, or discontinue features for security, legal, operational, or product reasons.",
          "You may stop using the service and disconnect integrations at any time. We may suspend or terminate access for material violations, security risk, legal requirements, or conduct that threatens the service or other users.",
        ],
      },
      {
        title: "Disclaimers and liability",
        paragraphs: [
          "To the maximum extent permitted by law, the service is provided “as is” and “as available,” without warranties of merchantability, fitness for a particular purpose, non-infringement, accuracy, availability, or data preservation.",
          "To the maximum extent permitted by law, DopeDB and its operator are not liable for indirect, incidental, special, consequential, exemplary, or punitive damages, or for loss of data, credentials, revenue, profits, goodwill, or business opportunity arising from the service. Rights that cannot lawfully be excluded remain unaffected.",
        ],
      },
      {
        title: "Governing terms and contact",
        paragraphs: [
          "These terms are governed by the laws of the Republic of Korea, without regard to conflict-of-law rules. If a provision is unenforceable, the remaining provisions continue in effect. Failure to enforce a provision is not a waiver.",
          "Questions about these terms can be sent to cjs5241@gmail.com. The current version is published at https://dopedb.dev/terms.",
        ],
      },
    ],
  },
  ko: {
    title: "서비스 이용약관",
    description:
      "이 약관은 DopeDB 워크스페이스 호스팅 서비스와 관련 배포 채널에 적용됩니다. 오픈소스 코드는 저장소에 포함된 라이선스가 별도로 적용됩니다.",
    sections: [
      {
        title: "동의와 운영자",
        paragraphs: [
          "DopeDB 워크스페이스 서비스에 접근하거나 DopeDB 관리형 연동을 사용하면 이 약관에 동의한 것으로 봅니다. DopeDB는 최재성이 운영합니다. 동의하지 않으면 호스팅 서비스를 사용하지 마세요. 문의는 cjs5241@gmail.com으로 보낼 수 있습니다.",
        ],
      },
      {
        title: "서비스 내용",
        paragraphs: [
          "DopeDB는 데스크톱 DB 클라이언트, 로컬 Agent 도구, 비밀값이 제거된 연결 템플릿·접근 정책·공급자 연동·버전·백업·초대·감사 이벤트를 공유하는 선택형 워크스페이스 서비스를 제공합니다. 오픈소스 프로젝트 개발에 따라 기능은 변경될 수 있습니다.",
          "서비스는 DB 백업, 공급자 감사 로그, 보안 검토 또는 전문적인 운영 판단을 대체하지 않습니다.",
        ],
      },
      {
        title: "계정과 워크스페이스 권한",
        items: [
          "정확한 계정 정보를 제공하고 기기와 세션을 보호하며 통제할 수 없게 된 접근은 즉시 철회해야 합니다.",
          "워크스페이스 Owner와 관리자는 멤버십, 역할, 연결 권한, 운영 승인과 다른 사용자 초대의 결과에 책임이 있습니다.",
          "관리·사용 권한이 있는 클라우드 프로젝트, DB와 리소스만 연결하거나 구성해야 합니다.",
        ],
      },
      {
        title: "DB와 운영 환경 안전",
        paragraphs: [
          "DB 쿼리와 Agent 출력은 틀리거나, 파괴적이거나, 불완전하거나, 운영 환경에 부적합할 수 있습니다. SQL, 범위, 선택한 환경, 자격 증명, 백업, 롤백 계획, 승인, 실행 결과를 검토할 책임은 사용자에게 있습니다.",
          "DopeDB 안전 게이트는 위험을 줄이지만 쿼리의 안전성이나 복구 가능성을 보장하지 않습니다. 운영 접근에는 최소 권한, DB 자체 통제, 검증된 백업, 독립 모니터링을 사용해야 합니다.",
        ],
      },
      {
        title: "Agent와 외부 서비스",
        paragraphs: [
          "Codex, Claude, Google Cloud, Vercel, Neon, PlanetScale, Resend, GitHub와 사용자가 연결한 DB 공급자는 각자의 약관과 개인정보처리방침이 적용되는 독립 서비스입니다. DopeDB는 해당 서비스의 가용성, 출력 또는 정책 변경을 통제하지 않습니다.",
          "로컬 Agent 인증은 공급자의 공식 CLI가 소유합니다. DopeDB는 Agent 응답의 정확성을 보장하지 않으며, 사용자가 공개 권한이 없는 데이터를 Agent에 제출할 권한을 부여하지 않습니다.",
        ],
      },
      {
        title: "허용되지 않는 이용",
        items: [
          "권한 없이 시스템이나 데이터에 접근하거나, 안전·승인 통제를 우회하거나, 서비스를 방해하거나, 다른 사용자 데이터를 탐색하거나, 악성 코드를 배포하거나, 불법 활동에 서비스를 사용해서는 안 됩니다.",
          "공유 메타데이터용 필드에 비밀값을 업로드하거나 다른 구성원이 적법하게 받은 적 없는 자격 증명을 사용하게 해서는 안 됩니다.",
          "DopeDB, DopeDB의 보안 특성 또는 연결된 리소스에 대한 자신의 권한을 허위로 표시해서는 안 됩니다.",
        ],
      },
      {
        title: "오픈소스와 사용자 콘텐츠",
        paragraphs: [
          "DopeDB 소스 코드 권리는 공개 저장소에 포함된 라이선스에 따라 부여되며 이 서비스 약관은 해당 권리를 제한하지 않습니다. 오픈소스 라이선스가 적용되지 않는 DopeDB 이름, 로고, 호스팅 서비스와 프로젝트 자료는 관련 법률의 보호를 받습니다.",
          "사용자는 제공한 콘텐츠와 메타데이터에 대한 권리를 유지합니다. 사용자는 서비스 제공, 보호, 전송과 지시 이행에 필요한 범위에서만 DopeDB에 처리 권한을 부여합니다.",
        ],
      },
      {
        title: "가용성, 변경, 이용 종료",
        paragraphs: [
          "서비스에는 보장된 가동 시간이나 지원 수준이 없습니다. 보안, 법률, 운영 또는 제품상의 이유로 기능을 변경, 중단, 속도 제한 또는 종료할 수 있습니다.",
          "사용자는 언제든 서비스 이용을 중단하고 연동을 해제할 수 있습니다. 중대한 약관 위반, 보안 위험, 법적 요구 또는 서비스·다른 사용자에 대한 위협이 있는 경우 접근을 제한하거나 종료할 수 있습니다.",
        ],
      },
      {
        title: "보증 부인과 책임 제한",
        paragraphs: [
          "법률이 허용하는 최대 범위에서 서비스는 상품성, 특정 목적 적합성, 비침해성, 정확성, 가용성 또는 데이터 보존에 대한 명시·묵시적 보증 없이 ‘있는 그대로’, ‘제공 가능한 상태로’ 제공됩니다.",
          "법률이 허용하는 최대 범위에서 DopeDB와 운영자는 서비스로 인한 간접, 부수적, 특별, 결과적, 징벌적 손해 또는 데이터, 자격 증명, 매출, 이익, 신용, 사업 기회의 손실에 책임을 지지 않습니다. 법률상 배제할 수 없는 권리는 영향을 받지 않습니다.",
        ],
      },
      {
        title: "준거법과 문의",
        paragraphs: [
          "이 약관은 법률 충돌 원칙을 제외하고 대한민국 법률을 준거법으로 합니다. 일부 조항이 집행 불가능해도 나머지 조항은 계속 유효하며 조항을 집행하지 않은 것이 권리 포기를 의미하지 않습니다.",
          "약관 문의는 cjs5241@gmail.com으로 보낼 수 있습니다. 최신 약관은 https://dopedb.dev/terms에 게시됩니다.",
        ],
      },
    ],
  },
};

function language(value: string | string[] | undefined) {
  return (Array.isArray(value) ? value[0] : value) === "ko" ? "ko" as const : "en" as const;
}

export async function generateMetadata({ searchParams }: TermsProps): Promise<Metadata> {
  const params = searchParams ? await searchParams : {};
  const lang = language(params.lang);
  const canonical = lang === "ko" ? "/ko/terms" : "/terms";
  return {
    title: content[lang].title,
    description: content[lang].description,
    alternates: {
      canonical,
      languages: { "en-US": "/terms", "ko-KR": "/ko/terms" },
    },
  };
}

export default async function TermsPage({ searchParams }: TermsProps) {
  const params = searchParams ? await searchParams : {};
  const lang = language(params.lang);
  const page = content[lang];
  return (
    <LegalDocument
      {...page}
      effectiveDate={lang === "ko" ? "2026년 7월 31일" : effectiveDate}
      lang={lang}
      alternateHref={lang === "ko" ? "/terms" : "/ko/terms"}
      alternateLabel={lang === "ko" ? "English" : "한국어"}
    />
  );
}
