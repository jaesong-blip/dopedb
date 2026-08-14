import { defineCatalog } from "../types";

export const productAnalyticsCatalog = defineCatalog(
  {
    "productAnalytics.accept": "Share limited usage data",
    "productAnalytics.decline": "Don't share",
    "productAnalytics.description":
      "DopeDB records only allowlisted outcomes and coarse duration or count buckets. It never collects SQL text, AI prompts or responses, database or table names, or local file names.",
    "productAnalytics.disabledBody":
      "Product analytics is unavailable in this build. Development and source builds do not send events.",
    "productAnalytics.disabledTitle": "Unavailable in this build",
    "productAnalytics.onboardingBody":
      "You can optionally share limited product usage events to help improve DopeDB. You can change this choice in Privacy settings at any time.",
    "productAnalytics.onboardingTitle": "Help improve DopeDB",
    "productAnalytics.privacyPolicy": "Privacy policy",
    "productAnalytics.revokeBody":
      "Turning this off immediately deletes queued events and this installation's analytics identifier.",
    "productAnalytics.settingLabel": "Share limited product usage events",
    "productAnalytics.settingsBody":
      "Choose whether this official desktop build may send privacy-bounded product usage events.",
    "productAnalytics.settingsTitle": "Product analytics",
    "productAnalytics.updateFailed":
      "The privacy choice could not be saved. Please try again.",
    "settings.privacy": "Privacy",
  },
  {
    "productAnalytics.accept": "제한된 사용 데이터 공유",
    "productAnalytics.decline": "공유하지 않기",
    "productAnalytics.description":
      "DopeDB는 허용 목록에 포함된 결과와 대략적인 시간 또는 개수 구간만 기록합니다. SQL 텍스트, AI 프롬프트나 응답, 데이터베이스나 테이블 이름, 로컬 파일 이름은 수집하지 않습니다.",
    "productAnalytics.disabledBody":
      "이 빌드에서는 제품 분석을 사용할 수 없습니다. 개발 및 소스 빌드는 이벤트를 전송하지 않습니다.",
    "productAnalytics.disabledTitle": "이 빌드에서는 사용할 수 없음",
    "productAnalytics.onboardingBody":
      "DopeDB 개선을 위해 제한된 제품 사용 이벤트를 선택적으로 공유할 수 있습니다. 이 선택은 언제든 개인정보 설정에서 변경할 수 있습니다.",
    "productAnalytics.onboardingTitle": "DopeDB 개선에 참여하기",
    "productAnalytics.privacyPolicy": "개인정보 처리방침",
    "productAnalytics.revokeBody":
      "이 기능을 끄면 대기 중인 이벤트와 이 설치의 분석 식별자가 즉시 삭제됩니다.",
    "productAnalytics.settingLabel": "제한된 제품 사용 이벤트 공유",
    "productAnalytics.settingsBody":
      "공식 데스크톱 빌드에서 개인정보 보호 범위가 제한된 제품 사용 이벤트를 전송할지 선택합니다.",
    "productAnalytics.settingsTitle": "제품 분석",
    "productAnalytics.updateFailed":
      "개인정보 선택을 저장하지 못했습니다. 다시 시도해 주세요.",
    "settings.privacy": "개인정보",
  },
);
