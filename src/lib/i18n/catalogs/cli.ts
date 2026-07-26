// cli messages stay together so this catalogue has one clear UI owner.
import { defineCatalog } from "../types";

export const cliCatalog = defineCatalog(
  {
    "cli.alreadyCurrent": "The CLI is already current.",
    "cli.binaryStatus": "CLI binary",
    "cli.configurePath": "Add CLI to PATH",
    "cli.conflict":
      "A different file already exists at {path}. Confirm replacement only if you intend DopeDB to manage this command.",
    "cli.current": "Current",
    "cli.description":
      "Installs the bundled, version-matched DopeDB CLI for this user. Database commands still require an approved in-app Terminal session.",
    "cli.error": "Could not manage the CLI: {error}",
    "cli.inAppPath": "In-app CLI directory",
    "cli.install": "Install CLI",
    "cli.installPath": "Install location",
    "cli.installed": "DopeDB CLI installed.",
    "cli.installedWithPath": "DopeDB CLI installed and the user PATH was updated.",
    "cli.notInstalled": "Not installed",
    "cli.outdated": "Different or outdated",
    "cli.pathChange": "PATH change",
    "cli.pathConsent":
      "Installing with the button below applies exactly this user-level PATH change. System paths are not modified.",
    "cli.pathMissing": "Not available in new shells",
    "cli.pathReady": "Available in PATH",
    "cli.pathStatus": "Shell access",
    "cli.ready": "CLI ready",
    "cli.refresh": "Check again",
    "cli.reinstall": "Reinstall CLI",
    "cli.replaceConfirm": "Replace the existing file?",
    "cli.title": "Command line",
    "cli.update": "Update CLI",
    "cli.version": "Bundled version",
    "cli.working": "Installing...",
  },
  {
    "cli.alreadyCurrent": "CLI가 이미 최신 상태입니다.",
    "cli.binaryStatus": "CLI 바이너리",
    "cli.configurePath": "CLI를 PATH에 추가",
    "cli.conflict":
      "{path}에 다른 파일이 있습니다. DopeDB가 이 명령을 관리하도록 할 때만 교체를 확인하세요.",
    "cli.current": "최신",
    "cli.description":
      "앱과 버전이 일치하는 번들 DopeDB CLI를 현재 사용자에게 설치합니다. 데이터베이스 명령은 설치 후에도 앱에서 승인한 Terminal 세션 안에서만 동작합니다.",
    "cli.error": "CLI를 관리하지 못했습니다: {error}",
    "cli.inAppPath": "인앱 CLI 디렉터리",
    "cli.install": "CLI 설치",
    "cli.installPath": "설치 위치",
    "cli.installed": "DopeDB CLI를 설치했습니다.",
    "cli.installedWithPath": "DopeDB CLI를 설치하고 사용자 PATH를 업데이트했습니다.",
    "cli.notInstalled": "설치되지 않음",
    "cli.outdated": "다른 파일 또는 이전 버전",
    "cli.pathChange": "PATH 변경",
    "cli.pathConsent":
      "아래 버튼을 누르면 표시된 사용자 PATH 변경만 적용합니다. 시스템 경로는 수정하지 않습니다.",
    "cli.pathMissing": "새 셸에서 아직 사용할 수 없음",
    "cli.pathReady": "PATH에서 사용 가능",
    "cli.pathStatus": "셸 접근",
    "cli.ready": "CLI 준비됨",
    "cli.refresh": "다시 확인",
    "cli.reinstall": "CLI 다시 설치",
    "cli.replaceConfirm": "기존 파일을 교체할까요?",
    "cli.title": "명령줄",
    "cli.update": "CLI 업데이트",
    "cli.version": "번들 버전",
    "cli.working": "설치 중...",
  },
);
