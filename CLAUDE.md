# DopeDB 클라이언트

Tauri v2 기반 데이터베이스 클라이언트다. React/TypeScript 프론트엔드와
Rust 코어, 연결 고정 Terminal, 로컬 CLI Broker로 구성된다.

## 작업 규칙

저장소 정책은 아래 import로 함께 읽는 `AGENTS.md`, 사람용 흐름은
`CONTRIBUTING.md`를 따른다.

@AGENTS.md

협업·배포 정책을 바꿀 때는 세 파일을 함께 갱신한다. 커밋 메시지는
`docs/commit.md`를 따른다. 작업 전에는 `git status`를 확인하고 다른 변경을
보존한다.

UI를 수정하기 전에는 `src/design-system/README.md`를 읽는다. 새 레이아웃은
`tw:` Tailwind utility와 semantic token을 사용하고 raw color, 동적 class
조립, 중복 primitive를 만들지 않는다. utility 문자열을 숨기는 화면별
`styles.ts`, 새 component/screen CSS, CSS module은 만들지 않는다. 정적 utility는
TSX에 직접 두고, 반복되는 시각·상호작용 패턴은 실제 공용 컴포넌트 또는 정본
primitive로 `src/design-system/`에 적립한 뒤 README에 기록한다. 기능을 이관하면
기존 selector, import, 파일을 같은 변경에서 삭제하며 Tailwind와 legacy CSS가
같은 책임을 동시에 소유하지 않게 한다. shell, tool-window, data-grid 배치는
정적 Tailwind와 공용 React primitive가 소유하며 CSS 예외는 문서화된 vendor
integration, reset, token, 정본 primitive뿐이다. 변경한 화면은 직접 실행해
확인한다.

## 제품 방향

DopeDB는 팀과 AI Agent를 위한 공유 DB 접근 workspace다. workspace가 연결의
정체성, 정책, 협업 상태를 소유하고, 각 구성원은 자신의 로컬 자격 증명을
보관하거나 최소 권한의 단기 managed 자격 증명을 받으며, 모든 Agent는 정확히
하나의 grant 안에서 일한다. 범용 desktop DB client, text-to-SQL 제품, 범용 MCP
server로 포지셔닝하지 않는다. Rust desktop shell, keychain 저장, read-only 검사,
승인, 감사, 넓은 driver 지원은 필요한 기본기이지 차별점이 아니다. 시장 약속과
공개 claim의 정본은 `docs/PRODUCT_POSITIONING.md`가 소유한다.

DopeDB에는 세 개의 제품 축이 있다. 기능을 넣을지는 DopeDB이나 경쟁 제품의
기능 목록이 아니라 이 축으로 판단한다.

**1. workspace가 공유 접근을 소유하고 구성원이 자격 증명을 소유한다.** 제품의
단위는 한 사람의 컴퓨터가 아니라 팀 workspace다. 연결 정체성, provider resource,
environment 정책, grant, 대시보드, report는 그 안에서 공유되기 위해 존재한다.
장기 비밀값은 공유 레코드를 따라가지 않는다. member-local 접근은 각자의 OS
credential store에 남고, managed 접근은 최소 권한의 구성원별 단기 자격 증명을
프로세스 메모리에만 발급한다. 접근을 안전하게 공유 가능하게 만드는 기능은 로컬
편의 기능보다 우선한다.

**2. 연결은 간단하게 유지한다.** 데이터베이스에 닿는 일은 모든 사용자가 처음
하는 일이고 포기하는 지점이다. 동작하는 최소 입력, 실제 기본값, engine별로
검증된 경로 하나를 우선한다. DopeDB에 property tab이 있다는 이유로 그 표면을
그대로 가져오지 않는다. 옵션을 하나 늘리려면 첫 실행이 길어지는 비용을 이겨야
한다. OS가 이미 소유한 메커니즘은 form으로 다시 만들지 않고 위임한다. SSH
터널은 `~/.ssh/config`의 Host 별칭만 받고 시스템 `ssh`를 띄우므로 키,
passphrase, agent, ProxyJump는 앱 밖에 남는다.

**3. Agent는 정확한 grant 안에서 일하고 화면은 관찰·승인·복구한다.**
데이터베이스 작업의 대부분은 연결에 고정된 Agent가 수행한다. 권한은 저장된
연결이나 범용 tool server에서 상속하지 않고 현재 workspace, account, connection
revision, process ancestry, local policy에 묶는다. 기능을 넣을지는 다음 순서로
묻는다.

1. Agent가 대신할 수 없는 일인가. 자격 증명 입력, 쓰기 승인, 결과 확인,
   감사 열람, 스키마 검증은 사람만 할 수 있으므로 화면이 소유한다.
2. Agent에게 맡기면 오히려 위험해지는 일인가. 실행을 되돌리는 경계, 폭주를
   끊는 손잡이, 실행 결과의 보존은 Agent 자율성이 커질수록 더 필요하다.
3. Agent가 SQL이나 대화로 더 빨리 해내는 일인가. 그렇다면 만들지 않는다.
   결과 재조회, object DDL 편집, revision 비교, inline completion은 buttons
   대신 명령 한 문장이 낫다.

Agent는 ACP(Agent Client Protocol) 클라이언트로 붙인다. Anthropic과 OpenAI가
배포하는 공식 어댑터를 수정 없이 구동하고, 인증은 사용자의 로컬 `claude`,
`codex` 로그인이 소유한다. 앱은 토큰을 읽거나 갱신하지 않고 로그인도 제공하지
않는다. 이 경계를 지켜야 구독 사용자가 그대로 쓸 수 있고, 한 공급자의 정책이
바뀌어도 그 어댑터만 빠진다. 자체 채팅 프로토콜이나 provider별 통합을 따로
만들지 않는다.

저장된 연결을 상시 실행되는 범용 MCP database server로 노출하지 않는다. typed
MCP-compatible bridge는 Desktop이 정확한 연결에 고정해 시작하고 Broker가 process
identity와 권한을 검증하는 ACP session 안에서만 존재할 수 있다.

공급자 API를 앱이 직접 호출하지 않는다. 모든 공급자 트래픽은 공식 CLI
바이너리를 거쳐야 하며 구독 사용량 표시 같은 부가 기능도 예외가 아니다.
저장된 토큰을 읽어 `api.anthropic.com`이나 공급자 백엔드를 부르는 코드는
지름길이 아니라 금지된 경로다. Anthropic은 2026년 3월 이 경계를 서버에서
강제해 CLI 바이너리를 거치지 않는 요청을 거절하기 시작했고, 그때 차단된 것은
규모가 큰 제품이 아니라 토큰을 직접 쓴 오픈소스 도구들이었다.

Agent가 정확히 판단하려면 실제 스키마를 정확히 봐야 한다. introspection의
범위와 깊이는 시각 기능보다 우선한다.

각 기능의 결정 상태는 `docs/DopeDB_VISUAL_REFERENCE_SPEC.md`의 기능 범위
결정 표가 소유한다. `AI가 대체`와 `범위 밖`으로 정한 기능은 트래커의
우선순위와 무관하게 구현하지 않고 label, icon, disabled placeholder도 만들지
않는다. 결정을 뒤집을 때는 그 표를 먼저 고친다.

DopeDB 2026.1은 위 판단을 통과한 기능의 UI/UX clean-room 정본이다. 화면
구조, 밀도, 상호작용은 DopeDB을 따르되 기능 목록까지 따르지는 않는다.
Tailwind v4와 DopeDB semantic token은 그 화면을 구현하는 수단이며 별도 시각
방향이 아니다. UI/UX 차이와 기능 부재는
`docs/DopeDB_PARITY_IMPLEMENTATION_TRACKER.md`에서 별도 상태로 관리한다.
DopeDB 자체 screenshot baseline 통과를 DopeDB 패리티 완료로 해석하지 않고,
enabled control에는 실제 command와 state owner가 있어야 한다.

## 아키텍처

- `src/screens/`: 화면 단위 진입점.
- `src/features/`: frontend 기능별 domain/state/application/adapter.
- `src/components/`: 여러 화면이 공유하는 UI.
- `src/lib/`: DOM 없는 공용 로직과 전역 query cache.
- `src/design-system/`: semantic token과 공통 primitive.
- `src-tauri/src/features/`: Rust 기능별 domain/application/ports/adapters.
- `src-tauri/src/kernel/`: 기능 사이의 작은 공용 타입과 권한 primitive.
- `dopedb-protocol/`, `dopedb-cli/`, `site/`, `workspace-cloud/`: 독립 하위
  프로젝트.

기능 코어는 Tauri, SQLx, Store, keychain, network, 전역 `AppState`를 직접
참조하지 않는다. 변경 가능한 상태에는 writer를 하나만 두고, 화면과 adapter는
상태를 직접 수정하지 않고 command를 전달한다.

## 핵심 명령

- `pnpm build`: skill bundle 검증, TypeScript, Vite build.
- `pnpm test`: 가장 중요한 frontend smoke suite.
- `pnpm test:rust`: Rust workspace 핵심 테스트.
- `pnpm dev:app`: 데스크톱 앱 개발 실행.

변경 범위에 맞는 명령만 실행한다. UI 변경은 build 뒤 해당 화면을 수동으로
확인하고, Windows 또는 전체 릴리스 검증은 플랫폼·릴리스 변경일 때만 수행한다.

테스트는 104개 고정 예산을 사용한다. 보안·안전 불변식, 공개 wire contract,
핵심 end-to-end 흐름만 테스트하고 구현 세부, 중복 DOM, snapshot, 성능 수치
테스트는 추가하지 않는다. 새 테스트가 필요하면 기존의 가치가 낮은 테스트를
대체하고 `tests/critical-test-budget.json`에 보호 이유를 기록한다. 사용자의
명시적 요청 없이 예산을 늘리지 않는다.

## 코드 규칙

- 화면은 `screens/X/index.tsx`, 컴포넌트는 PascalCase, TypeScript 유틸은
  camelCase, Rust 파일은 snake_case를 사용한다.
- `src/lib/*`는 named export만 사용한다. 그 밖의 파일은 주 산출물이 하나면
  default export, 여러 개면 named export를 사용한다.
- backend 읽기는 TanStack Query 옵션을 통해 수행한다. 화면에서
  `useEffect`와 `invoke`로 직접 fetch하지 않는다.
- 기능 IPC는 frontend `features/<feature>/tauriAdapter.ts`, Rust
  `features/<feature>/transport.rs`에 둔다. 직렬화 형태와 필드 순서를 맞춘다.
- 번역은 `en`과 `ko`를 함께 추가하고 `namespace.camelCaseKey`를 사용한다.
- Rust 모듈은 파일 상단에 `//!` 설명을 둔다.
- 45줄이 넘는 TS/TSX 화면·컴포넌트·lib 파일은 import 앞에 역할을 설명하는
  짧은 주석을 둔다.
- 이전이 끝난 기능은 같은 변경에서 옛 경로, re-export, fallback, flag를
  제거한다.

## 주의사항

- Tauri v2 이벤트 이름에는 `.` 대신 `:` 같은 구분자를 사용한다.
- `NUMERIC`과 `MONEY` 값은 정밀도 보존을 위해 문자열로 직렬화한다.
- 정식 릴리스는 명시적 요청이 있을 때만 `json-choi`가 `main`에서
  `app-vX.Y.Z` 태그로 발행한다. 버전 파일과 signing secret을 임의로 다루지
  않는다.
- macOS 정식 릴리스는 ARM64/x64 모두 Developer ID·공증·staple·Gatekeeper와
  DMG/updater 동일 app payload 영수증을 통과해야 하며, finalizer는 그 영수증을
  정확한 공개 asset bytes에 고정하지 못하면 실패한다.

## 릴리스 노트 준비 상태

사용자용 릴리스 노트 파이프라인은 정식 MVP 전까지 의도적으로 `prepared` 모드를
유지한다. `.release-notes/config.json`이 `prepared`인 동안 실제 fragment를
요구하거나 적립하지 않고 안정 릴리스는 기존 다운로드 안내문을 사용한다. 정식
MVP 이후 사용자가 명시적으로 결정하기 전에는 `active`로 바꾸지 않는다. 활성화
뒤에는 사용자에게 보이는 모든 변경이 `.release-notes/fragments/`의 검증된
append-only fragment를 추가하며, 커밋과 이슈 링크는 설명이 아니라 근거로만
붙인다. 형식과 활성화 절차는 [`.release-notes/README.md`](.release-notes/README.md)가
소유한다.

## graphify

`graphify-out/graph.json`이 있으면 코드베이스 질문은 원본 파일을 광범위하게
검색하기 전에 `graphify query "<질문>"`으로 범위를 좁힌다. 관계는
`graphify path "<A>" "<B>"`, 개별 개념은 `graphify explain "<개념>"`을
사용하고, 넓은 아키텍처 검토에만 `graphify-out/GRAPH_REPORT.md`를 읽는다.
코드를 바꾼 뒤에는 외부 API를 쓰지 않는 `graphify update .`로 AST 그래프를
갱신한다.
