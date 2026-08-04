// Public service terms for the desktop app, workspace service, and optional
// provider integrations. Open-source license rights remain separately governed.
import type { Metadata } from "next";
import { LegalDocument, type LegalSection } from "../components/LegalDocument";

const operatorName = { en: "Jaesong Choi", ko: "최재송" } as const;
const contactEmail = "cjs5241@gmail.com";
const effectiveDate = { en: "August 4, 2026", ko: "2026년 8월 4일" } as const;

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
      "These terms govern DopeDB's hosted workspace service and optional managed integrations. Open-source code remains subject to the license included in its repository.",
    sections: [
      {
        title: "Agreement, operator, and language",
        paragraphs: [
          `DopeDB is operated by ${operatorName.en}, an individual operator in the Republic of Korea. Questions about these terms can be sent to ${contactEmail}.`,
          "By selecting a sign-in or consent action, or by using the authenticated hosted workspace service or a DopeDB-managed integration, you agree to these terms. If you do not agree, do not use those hosted features. Merely reading the public website or using open-source code under its repository license does not by itself create this agreement.",
          "The Korean and English versions are intended to have the same meaning. If they conflict, the Korean version controls to the extent permitted by applicable law.",
        ],
      },
      {
        title: "Eligibility, accounts, and workspace authority",
        items: [
          "You must be at least 16 years old and legally able to agree to these terms, or use the service through an organization that has authorized you. If local law requires a higher age, that higher age applies.",
          "You must provide accurate account information, protect your devices and sessions, and promptly revoke access you no longer control.",
          "Workspace owners and administrators are responsible for membership, roles, connection grants, production approvals, and invitations. You may configure only cloud projects, databases, and other resources that you are authorized to administer or use.",
        ],
      },
      {
        title: "Service scope",
        paragraphs: [
          "DopeDB provides a desktop database client, local Agent tooling, and an optional team workspace for sharing secretless connection templates, access policy, provider integrations, revisions, metadata backups, invitations, and audit events.",
          "The hosted service does not replace database backups, provider audit logs, security review, incident response, or professional operational judgment. Features may change as the product and open-source project develop.",
        ],
      },
      {
        title: "Database and production safety",
        paragraphs: [
          "Database queries and Agent output can be incorrect, destructive, incomplete, or unsuitable for production. You are responsible for reviewing SQL, scope, selected environment, credentials, backups, rollback plans, approvals, and execution results.",
          "DopeDB safety gates reduce risk but do not guarantee that a query is safe or reversible. Production access should use least privilege, database-native controls, tested backups, and independent monitoring.",
        ],
      },
      {
        title: "Agents and user-directed third parties",
        paragraphs: [
          "DopeDB connects to official Agent CLI software such as Codex and Claude. The applicable provider controls the Agent account and authentication. Depending on what you ask the Agent to do, your prompts and selected schema, query, result, or error context may be sent to that provider under its terms and privacy policy.",
          "Google Cloud, Neon, PlanetScale, GitHub, and any other cloud or database provider you choose are also governed by their own terms. You must not submit data that you lack authority to disclose. DopeDB does not control third-party availability, output, retention, or policy changes and does not guarantee that Agent output is correct.",
        ],
      },
      {
        title: "Acceptable use",
        items: [
          "Do not access systems or data without authorization, bypass safety or approval controls, interfere with the service, probe another user's data, distribute malware, or use the service for unlawful activity.",
          "Do not upload secrets into fields intended for shared metadata or cause another workspace member to use credentials they did not receive lawfully.",
          "Do not misrepresent DopeDB, its security properties, or your authority over a connected resource.",
        ],
      },
      {
        title: "Open source and user content",
        paragraphs: [
          "Rights to DopeDB source code are granted under the license included in the public repository. These service terms do not restrict those license rights. DopeDB names, logos, hosted services, and project materials outside that license remain protected by applicable law.",
          "You retain rights in content and metadata you provide. You grant DopeDB only the permission necessary to host, process, secure, back up, and transmit that material to provide the service, comply with law, and follow your instructions. You represent that you have the rights needed to provide it.",
        ],
      },
      {
        title: "Privacy and security",
        paragraphs: [
          "The Privacy Policy at https://dopedb.dev/privacy explains the personal information and service data processed by the public website, hosted workspace, desktop app, and optional integrations.",
          "You are responsible for choosing appropriate workspace roles, database privileges, sharing settings, and provider permissions. Notify us promptly at the contact address if you believe an account or workspace has been compromised.",
        ],
      },
      {
        title: "Availability and changes",
        paragraphs: [
          "The service is provided without a guaranteed uptime or support level. We may modify, suspend, rate-limit, or discontinue a feature for security, legal, operational, or product reasons.",
          "When these terms materially change, the revised terms and effective date will be posted on this page, and additional notice will be provided when required by law. Continued use after the effective date constitutes acceptance only where applicable law permits.",
        ],
      },
      {
        title: "Suspension, termination, and deletion",
        paragraphs: [
          "You may stop using the service and disconnect optional integrations at any time. We may suspend or terminate access for a material breach, security risk, legal requirement, or conduct that threatens the service or other users. Where practicable, we will give notice and an opportunity to address the issue.",
          "Stopping use or losing workspace access does not automatically delete every account or workspace record. Deletion and retention are handled as described in the Privacy Policy, and an authorized person may submit a verified deletion request.",
        ],
      },
      {
        title: "Disclaimers and liability",
        paragraphs: [
          "To the extent permitted by law, the service is provided “as is” and “as available,” without implied warranties of merchantability, fitness for a particular purpose, non-infringement, accuracy, availability, or data preservation.",
          "To the extent permitted by law, DopeDB and its operator are not liable for indirect, incidental, special, consequential, exemplary, or punitive damages, or for loss of data, credentials, revenue, profits, goodwill, or business opportunity arising from the service.",
          "Nothing in these terms excludes or limits liability for intentional misconduct or gross negligence, death or personal injury caused by negligence, mandatory consumer rights, or any other responsibility that applicable law does not allow to be excluded or limited.",
        ],
      },
      {
        title: "Governing law and contact",
        paragraphs: [
          "These terms are governed by the laws of the Republic of Korea, without regard to conflict-of-law rules. Mandatory protections available under the law of your residence remain unaffected. If a provision is unenforceable, the remaining provisions continue in effect, and failure to enforce a provision is not a waiver.",
          `Questions about these terms can be sent to ${contactEmail}. The current English version is published at https://dopedb.dev/terms and the Korean version at https://dopedb.dev/ko/terms.`,
        ],
      },
    ],
  },
  ko: {
    title: "서비스 이용약관",
    description:
      "이 약관은 DopeDB 워크스페이스 호스팅 서비스와 선택형 관리형 연동에 적용됩니다. 오픈소스 코드는 저장소에 포함된 라이선스가 별도로 적용됩니다.",
    sections: [
      {
        title: "동의, 운영자와 언어",
        paragraphs: [
          `DopeDB는 대한민국의 개인 운영자 ${operatorName.ko}이 운영합니다. 약관 문의는 ${contactEmail}으로 보낼 수 있습니다.`,
          "로그인·동의 버튼을 선택하거나 인증이 필요한 워크스페이스 호스팅 서비스 또는 DopeDB 관리형 연동을 사용하면 이 약관에 동의한 것으로 봅니다. 동의하지 않으면 해당 호스팅 기능을 사용하지 마세요. 공개 웹사이트를 열람하거나 저장소 라이선스에 따라 오픈소스 코드를 사용하는 것만으로 이 약관에 동의한 것은 아닙니다.",
          "한국어판과 영어판은 같은 의미로 작성되었습니다. 내용이 충돌하면 관련 법률이 허용하는 범위에서 한국어판이 우선합니다.",
        ],
      },
      {
        title: "이용 자격, 계정과 워크스페이스 권한",
        items: [
          "만 16세 이상이고 이 약관에 동의할 법적 능력이 있거나, 이용을 승인한 조직을 통해 서비스를 사용해야 합니다. 거주지 법률이 더 높은 연령을 요구하면 그 연령이 적용됩니다.",
          "정확한 계정 정보를 제공하고 기기와 세션을 보호하며 통제할 수 없게 된 접근은 즉시 철회해야 합니다.",
          "워크스페이스 Owner와 관리자는 멤버십, 역할, 연결 권한, 운영 승인과 초대를 관리할 책임이 있습니다. 관리하거나 사용할 권한이 있는 클라우드 프로젝트, DB와 기타 리소스만 구성해야 합니다.",
        ],
      },
      {
        title: "서비스 범위",
        paragraphs: [
          "DopeDB는 데스크톱 DB 클라이언트, 로컬 Agent 도구, 비밀값 없는 연결 템플릿·접근 정책·공급자 연동·버전·메타데이터 백업·초대·감사 이벤트를 공유하는 선택형 팀 워크스페이스를 제공합니다.",
          "호스팅 서비스는 DB 백업, 공급자 감사 로그, 보안 검토, 사고 대응 또는 전문적인 운영 판단을 대체하지 않습니다. 제품과 오픈소스 프로젝트 개발에 따라 기능은 변경될 수 있습니다.",
        ],
      },
      {
        title: "DB와 운영 환경 안전",
        paragraphs: [
          "DB 쿼리와 Agent 출력은 틀리거나, 파괴적이거나, 불완전하거나, 운영 환경에 부적합할 수 있습니다. SQL, 범위, 선택한 환경, 자격 증명, 백업, 롤백 계획, 승인과 실행 결과를 검토할 책임은 사용자에게 있습니다.",
          "DopeDB 안전 게이트는 위험을 줄이지만 쿼리의 안전성이나 복구 가능성을 보장하지 않습니다. 운영 접근에는 최소 권한, DB 자체 통제, 검증된 백업과 독립 모니터링을 사용해야 합니다.",
        ],
      },
      {
        title: "Agent와 사용자가 선택한 외부 서비스",
        paragraphs: [
          "DopeDB는 Codex와 Claude 같은 공식 Agent CLI 소프트웨어에 연결합니다. Agent 계정과 인증은 해당 공급자가 관리합니다. 사용자가 Agent에 요청한 작업에 따라 프롬프트와 선택한 스키마, 쿼리, 결과 또는 오류 맥락이 해당 공급자의 약관과 개인정보처리방침에 따라 전송될 수 있습니다.",
          "Google Cloud, Neon, PlanetScale, GitHub와 사용자가 선택한 기타 클라우드·DB 공급자에도 각자의 약관이 적용됩니다. 공개할 권한이 없는 데이터를 제출해서는 안 됩니다. DopeDB는 외부 서비스의 가용성, 출력, 보유 또는 정책 변경을 통제하지 않으며 Agent 출력의 정확성을 보장하지 않습니다.",
        ],
      },
      {
        title: "허용되지 않는 이용",
        items: [
          "권한 없이 시스템이나 데이터에 접근하거나, 안전·승인 통제를 우회하거나, 서비스를 방해하거나, 다른 사용자 데이터를 탐색하거나, 악성 코드를 배포하거나, 불법 활동에 서비스를 사용해서는 안 됩니다.",
          "공유 메타데이터용 필드에 비밀값을 업로드하거나 다른 구성원이 적법하게 받지 않은 자격 증명을 사용하게 해서는 안 됩니다.",
          "DopeDB, DopeDB의 보안 특성 또는 연결된 리소스에 대한 자신의 권한을 허위로 표시해서는 안 됩니다.",
        ],
      },
      {
        title: "오픈소스와 사용자 콘텐츠",
        paragraphs: [
          "DopeDB 소스 코드 권리는 공개 저장소에 포함된 라이선스에 따라 부여되며 이 서비스 약관은 해당 권리를 제한하지 않습니다. 해당 라이선스 밖의 DopeDB 이름, 로고, 호스팅 서비스와 프로젝트 자료는 관련 법률의 보호를 받습니다.",
          "사용자는 제공한 콘텐츠와 메타데이터에 대한 권리를 유지합니다. 사용자는 서비스 제공, 법률 준수와 지시 이행에 필요한 범위에서만 DopeDB에 해당 자료를 호스팅·처리·보호·백업·전송할 권한을 부여하며, 이를 제공할 권리가 있음을 보장합니다.",
        ],
      },
      {
        title: "개인정보와 보안",
        paragraphs: [
          "https://dopedb.dev/ko/privacy의 개인정보처리방침은 공개 웹사이트, 호스팅 워크스페이스, 데스크톱 앱과 선택형 연동에서 처리되는 개인정보와 서비스 데이터를 설명합니다.",
          "사용자는 적절한 워크스페이스 역할, DB 권한, 공유 설정과 공급자 권한을 선택할 책임이 있습니다. 계정이나 워크스페이스 침해가 의심되면 문의처로 즉시 알려 주세요.",
        ],
      },
      {
        title: "가용성과 변경",
        paragraphs: [
          "서비스에는 보장된 가동 시간이나 지원 수준이 없습니다. 보안, 법률, 운영 또는 제품상의 이유로 기능을 변경, 중단, 속도 제한 또는 종료할 수 있습니다.",
          "약관이 중요하게 변경되면 개정 약관과 시행일을 이 페이지에 게시하고, 법률이 요구하는 경우 별도로 알립니다. 시행일 이후의 계속 이용은 관련 법률이 허용하는 경우에만 변경된 약관에 대한 동의로 봅니다.",
        ],
      },
      {
        title: "이용 제한, 종료와 삭제",
        paragraphs: [
          "사용자는 언제든 서비스 이용을 중단하고 선택형 연동을 해제할 수 있습니다. 중대한 약관 위반, 보안 위험, 법적 요구 또는 서비스·다른 사용자에 대한 위협이 있는 경우 접근을 제한하거나 종료할 수 있습니다. 가능한 경우 사전에 알리고 문제를 바로잡을 기회를 제공합니다.",
          "서비스 이용 중단이나 워크스페이스 접근 상실만으로 모든 계정·워크스페이스 기록이 자동 삭제되지는 않습니다. 삭제와 보유는 개인정보처리방침에 따르며 권한 있는 사람은 확인 절차를 거쳐 삭제를 요청할 수 있습니다.",
        ],
      },
      {
        title: "보증 부인과 책임 제한",
        paragraphs: [
          "법률이 허용하는 범위에서 서비스는 상품성, 특정 목적 적합성, 비침해성, 정확성, 가용성 또는 데이터 보존에 대한 묵시적 보증 없이 ‘있는 그대로’, ‘제공 가능한 상태로’ 제공됩니다.",
          "법률이 허용하는 범위에서 DopeDB와 운영자는 서비스로 인한 간접, 부수적, 특별, 결과적, 예시적 또는 징벌적 손해나 데이터, 자격 증명, 매출, 이익, 신용 또는 사업 기회의 손실에 책임을 지지 않습니다.",
          "이 약관은 고의 또는 중대한 과실, 과실로 인한 사망·신체 손해, 강행적인 소비자 권리 또는 관련 법률상 배제·제한할 수 없는 다른 책임을 배제하거나 제한하지 않습니다.",
        ],
      },
      {
        title: "준거법과 문의",
        paragraphs: [
          "이 약관은 법률 충돌 원칙을 제외하고 대한민국 법률을 준거법으로 합니다. 이용자 거주지 법률의 강행적 보호는 영향을 받지 않습니다. 일부 조항이 집행 불가능해도 나머지 조항은 계속 유효하며 조항을 집행하지 않은 것이 권리 포기를 의미하지 않습니다.",
          `약관 문의는 ${contactEmail}으로 보낼 수 있습니다. 최신 한국어판은 https://dopedb.dev/ko/terms, 영어판은 https://dopedb.dev/terms에 게시됩니다.`,
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
      effectiveDate={effectiveDate[lang]}
      lang={lang}
      alternateHref={lang === "ko" ? "/terms" : "/ko/terms"}
      alternateLabel={lang === "ko" ? "English" : "한국어"}
    />
  );
}
