// onboarding messages are owned by this bounded feature catalogue.
import { defineCatalog } from "../types";

export const onboardingCatalog = defineCatalog(
  {
    "onboarding.addConnection": "Add connection",
    "onboarding.agentBody":
      "Install the version-matched DopeDB Skill for Codex or Claude Code. The agent uses the local DopeDB CLI, while this app keeps database access visible and controlled.",
    "onboarding.agentTitle": "Connect your AI agent",
    "onboarding.databaseBody":
      "Add a PostgreSQL, MySQL, or SQLite connection. Credentials are stored in your OS credential store - never in plain text.",
    "onboarding.databaseTitle": "Connect a database",
    "onboarding.foot":
      "You can do both, or start with just a database and add the agent later.",
    "onboarding.lead":
      "A safe database client for the AI era. Your agent queries and edits databases through DopeDB, which keeps everything read-only by default, requires a human click for writes, and audits every statement.",
    "onboarding.setupAgentTools": "Set up agent tools",
    "onboarding.title": "Welcome to DopeDB",
  },
  {
    "onboarding.addConnection": "연결 추가",
    "onboarding.agentBody":
      "Codex 또는 Claude Code에 현재 앱 버전과 맞는 DopeDB 스킬을 설치하세요. 에이전트는 로컬 DopeDB CLI를 사용하고, 이 앱은 데이터베이스 접근을 표시하고 제어합니다.",
    "onboarding.agentTitle": "AI 에이전트 연결",
    "onboarding.databaseBody":
      "PostgreSQL, MySQL, SQLite 연결을 추가하세요. 인증 정보는 OS 보안 저장소에 저장되며 평문으로 남지 않습니다.",
    "onboarding.databaseTitle": "데이터베이스 연결",
    "onboarding.foot":
      "둘 다 설정해도 좋고, 데이터베이스부터 연결한 뒤 에이전트를 나중에 추가해도 됩니다.",
    "onboarding.lead":
      "AI 시대를 위한 안전한 데이터베이스 클라이언트입니다. 에이전트는 DopeDB를 통해 데이터베이스를 조회하고 수정하며, 기본은 읽기 전용이고 쓰기는 사람이 클릭으로 승인하며 모든 문장을 감사 로그로 남깁니다.",
    "onboarding.setupAgentTools": "에이전트 도구 설정",
    "onboarding.title": "DopeDB에 오신 것을 환영합니다",
  },
);
