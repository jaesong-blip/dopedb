// The advanced Shell Terminal is a bounded developer surface, separate from ACP.
import { defineCatalog } from "../types";

export const terminalCatalog = defineCatalog(
  {
    "terminal.close": "Close Terminal",
    "terminal.closeFailed": "Could not close the Terminal: {error}",
    "terminal.createFailed": "Could not start the Terminal: {error}",
    "terminal.description":
      "Open a system shell pinned to the selected data source. Database commands keep its exact workspace grant and safety policy.",
    "terminal.inputFailed": "Terminal input failed: {error}",
    "terminal.lifecycleExited": "Exited",
    "terminal.lifecycleFailed": "Failed",
    "terminal.lifecycleRunning": "Running",
    "terminal.lifecycleStarting": "Starting",
    "terminal.lifecycleStopping": "Stopping",
    "terminal.noConnection": "Select a data source before opening Terminal.",
    "terminal.open": "Open advanced Shell Terminal",
    "terminal.pinned": "Pinned to {name}",
    "terminal.readOnly": "Read-only",
    "terminal.approvalRequired": "Approval required for writes",
    "terminal.starting": "Starting Terminal…",
    "terminal.scopeChanged":
      "The workspace or data source changed before Terminal opened.",
    "terminal.title": "Advanced Shell Terminal",
  },
  {
    "terminal.close": "Terminal 닫기",
    "terminal.closeFailed": "Terminal을 닫지 못했습니다: {error}",
    "terminal.createFailed": "Terminal을 시작하지 못했습니다: {error}",
    "terminal.description":
      "선택한 데이터 소스에 고정된 시스템 셸을 엽니다. 데이터베이스 명령에는 정확한 워크스페이스 권한과 안전 정책이 계속 적용됩니다.",
    "terminal.inputFailed": "Terminal 입력을 전송하지 못했습니다: {error}",
    "terminal.lifecycleExited": "종료됨",
    "terminal.lifecycleFailed": "실패",
    "terminal.lifecycleRunning": "실행 중",
    "terminal.lifecycleStarting": "시작 중",
    "terminal.lifecycleStopping": "중지 중",
    "terminal.noConnection": "Terminal을 열기 전에 데이터 소스를 선택하세요.",
    "terminal.open": "고급 Shell Terminal 열기",
    "terminal.pinned": "{name}에 고정됨",
    "terminal.readOnly": "읽기 전용",
    "terminal.approvalRequired": "쓰기 작업은 승인 필요",
    "terminal.starting": "Terminal 시작 중…",
    "terminal.scopeChanged":
      "Terminal이 열리기 전에 워크스페이스 또는 데이터 소스가 변경되었습니다.",
    "terminal.title": "고급 Shell Terminal",
  },
);
