# DopeDB (도프디비)

DopeDB(도프디비)는 **팀과 AI Agent가 DB 인증정보를 공유하지 않고 같은 연결에서
일하게 하는 무료 오픈소스 데이터베이스 워크스페이스**입니다. 팀은 비밀값이 없는
연결과 정책을 공유하고, 각 구성원은 자신의 로컬 자격 증명을 사용하거나 최소 권한의
단기 managed 자격 증명을 받습니다. Codex와 Claude는 정확한 workspace, account,
connection revision, local policy에 고정된 session 안에서 일하며 DB traffic, 승인,
중단, 복구, 감사는 Desktop 경계에 남습니다. 현재 공개 빌드는 alpha입니다.

- 웹사이트: https://dopedb.dev/ko (English: https://dopedb.dev)
- 다운로드: [Windows x64](https://github.com/json-choi/dopedb/releases/latest/download/DopeDB-windows-x64-setup.exe) · [macOS Apple Silicon](https://github.com/json-choi/dopedb/releases/latest/download/DopeDB-macos-arm64.dmg) · [macOS Intel](https://github.com/json-choi/dopedb/releases/latest/download/DopeDB-macos-x64.dmg)
- English: [README.en.md](./README.en.md)
- 상세 문서: [docs/PROJECT.md](./docs/PROJECT.md)
- 제품 방향: [docs/PRODUCT_POSITIONING.md](./docs/PRODUCT_POSITIONING.md)

## 주요 기능

- Personal/team workspace, device sign-in, invitation, membership, role
- 비밀값 없는 공유 연결 template과 구성원별 local credential binding
- PlanetScale, Neon, GCP Cloud SQL의 구성원별 단기 managed access
- PostgreSQL, MySQL/MariaDB, SQLite, MongoDB 연결과 schema introspection
- 정확한 연결에 고정된 공식 Codex/Claude ACP session과 심화 Shell Terminal
- 포트나 별도 서버 없이 동작하는 로컬 `dopedb` CLI Broker
- 기본 읽기 전용 실행, SQL 분류, 불변 write proposal과 exact approval
- 실행 중단, manual transaction rollback, durable result, hash-chain 감사 로그
- 에이전트 쿼리 결과를 앱 안에서 실시간 확인
- 한국어/영어 지원: 소개 사이트, 데스크톱 클라이언트 UI, GitHub README
- GitHub Releases 기반 macOS/Windows 다운로드와 Tauri updater

## 왜 DopeDB인가

좋은 DB 클라이언트, AI SQL 생성기, 범용 MCP server는 이미 많습니다. DopeDB는
기능 수로 그 제품들과 경쟁하지 않습니다. 팀이 하나의 DB 접근을 공유하면서도
공용 password나 넓은 Agent 권한을 만들지 않는 문제에 집중합니다.

- workspace는 연결의 정체성, provider resource, 환경 정책, grant, revision을
  공유하지만 장기 비밀값은 공유 record에 넣지 않습니다.
- 구성원은 자신의 OS credential store를 쓰거나 provider가 발급한 구성원별 단기
  credential만 process memory에서 사용합니다.
- 공식 Codex/Claude ACP session은 저장된 모든 연결을 보는 범용 MCP server가
  아니라 Desktop이 선택한 정확한 연결과 권한에만 고정됩니다.
- SQL 조회는 `query plan`과 단일 사용 `query run`으로 실행하고, 쓰기와 DDL은 CLI가
  승인할 수 없는 불변 제안으로 만들어 사람이 exact payload를 승인합니다.
- 실행을 중단하고 transaction을 rollback하며 결과·승인·receipt를 다시 검토할 수
  있는 화면을 Agent 자율성의 필수 경계로 둡니다.

## 언어 지원

- 소개 사이트: [한국어](https://dopedb.dev/ko) / [English](https://dopedb.dev/)
- 데스크톱 클라이언트: Settings -> Language에서 한국어/English 선택
- GitHub README: [한국어](./README.md) / [English](./README.en.md)

## 개발 실행

필요한 도구:

- Rust stable 1.94 이상
- Node.js 24
- pnpm 11.17.0
- macOS 빌드용 Xcode Command Line Tools

```sh
pnpm install
pnpm tauri dev
```

`pnpm tauri dev`와 `pnpm tauri build --debug`는 `DopeDB Dev` /
`dev.dopedb.desktop.dev`로 실행됩니다. 운영판과 Dock 등록 및 로컬 Broker runtime을
공유하지 않으므로 개발 앱이 설치된 DopeDB를 가로채지 않습니다. macOS 개발 실행은
빌드마다 같은 개발용 코드 서명을 적용해 최초 Keychain 허용 뒤 재빌드할 때마다 암호를
다시 묻지 않습니다. DB 암호와 워크스페이스 세션은 OS 보안 저장소에 유지되고, 실행
중에는 메모리 캐시에서 재사용됩니다.

개별 검증:

```sh
pnpm build
pnpm test
pnpm test:rust
pnpm site:build
pnpm build:sidecars
```

`pnpm build:sidecars`는 Local Broker용 `dopedb` CLI와 SHA-256으로 고정한
공식 Cloud SQL Auth Proxy를 staging합니다. 앱의
설정 > 명령줄에서 사용자 전용 CLI 위치와 PATH 변경 내용을 확인한 뒤 명시적으로
설치할 수 있습니다.

설정 > 에이전트 도구에서는 Codex와 Claude Code의 공식 사용자 Skill 경로를
확인하고 DopeDB Skill을 한 번의 동의로 설치할 수 있습니다. 설치 파일에는 탐색용
안내만 두고, 실제 전체 가이드는 현재 앱 버전과 함께 빌드된 CLI가 오프라인으로
제공합니다. 기존 파일이 있거나 사용자가 수정한 경우 자동으로 덮어쓰지 않으며,
경로별 충돌을 보여준 뒤 명시적으로 복구할 때 기존 디렉터리를 백업합니다.
같은 화면의 레거시 정리 도구는 이전 DopeDB MCP 설정을 먼저 미리 보여주고,
사용자가 확인한 정확한 항목만 백업 후 제거합니다.

외부 셸 자동완성 스크립트는 `dopedb completion bash|zsh|fish|powershell|elvish`로
출력할 수 있으며, 이 명령은 Desktop Runtime이나 세션 자격 증명을 요구하지 않습니다.

UI를 수정하기 전에는 [디자인 시스템](./src/design-system/README.md)을 먼저
확인합니다. 새 화면 배치는 Tailwind CSS v4의 `tw:` utility를 사용하고 기존
화면은 기능 단위로 이전합니다. 변경 뒤에는 `pnpm build`와 실제 앱 화면 확인을
수행합니다.

## 릴리스

정식 버전은 저장소 소유자만 발행합니다. `main`에 합쳐진 커밋에 소유자가 `app-v*` 태그를 push하고 `stable-release` 환경을 승인하면 GitHub Actions가 macOS Apple Silicon/Intel 빌드, Windows x64 NSIS 설치 파일, updater metadata를 draft release에 모은 뒤 한 번에 공개합니다. 공개된 새 release의 태그와 asset은 immutable release 정책으로 잠깁니다.

```sh
git tag app-v0.1.1
git push origin app-v0.1.1
```

릴리스 워크플로우에는 `TAURI_SIGNING_PRIVATE_KEY` repository secret이 필요합니다. 협업자는 `work/<GitHub아이디>/<작업명>` 브랜치에서 본인 전용 unsigned canary prerelease를 만들 수 있습니다. 브랜치, PR, 카나리 절차는 [CONTRIBUTING.md](./CONTRIBUTING.md)를 참고하세요.

## macOS 경고

첫 Developer ID 서명·공증 릴리스 전에 발행된 macOS Alpha 설치본은 개발자 확인 경고를 표시할 수 있습니다. GitHub Releases에서 받은 파일인지 확인한 뒤 System Settings -> Privacy & Security -> Open Anyway로 실행을 허용할 수 있습니다.

터미널로 quarantine 플래그를 해제해야 한다면, DopeDB를 Applications 폴더에 복사한 뒤 아래 명령을 실행하세요.

```sh
sudo xattr -dr com.apple.quarantine /Applications/DopeDB.app
open /Applications/DopeDB.app
```

`/Applications/DopeDB.app`이 아니라면 실제 앱 경로로 바꾸세요. 이 명령은 macOS가 다운로드 파일에 붙인 격리 플래그를 제거하므로, 공식 GitHub Release에서 받은 파일에만 사용하세요.

## Windows 경고

코드 서명 전 Windows Alpha 설치본은 Microsoft Defender SmartScreen 경고를 표시할 수 있습니다. 공식 GitHub Release에서 받은 파일인지 확인한 뒤 추가 정보 -> 실행을 선택하세요. 이 경로는 서명 전 Alpha 설치본에만 해당하며 출처를 확인하지 않은 실행 파일에는 사용하지 마세요.

## 라이선스

MIT License. [LICENSE](./LICENSE)를 참고하세요.
