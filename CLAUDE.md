# DopeDB 클라이언트

Tauri v2 기반 데이터베이스 클라이언트다. React/TypeScript 프론트엔드와
Rust 코어, 연결 고정 Terminal, 로컬 CLI Broker로 구성된다.

## 작업 규칙

저장소 정책은 `AGENTS.md`, 사람용 흐름은 `CONTRIBUTING.md`를 따른다.
협업·배포 정책을 바꿀 때는 세 파일을 함께 갱신한다. 커밋 메시지는
`docs/commit.md`를 따른다. 작업 전에는 `git status`를 확인하고 다른 변경을
보존한다.

UI를 수정하기 전에는 `src/design-system/README.md`를 읽는다. 새 레이아웃은
`tw:` Tailwind utility와 semantic token을 사용하고 raw color, 동적 class
조립, 중복 primitive를 만들지 않는다. 변경한 화면은 직접 실행해 확인한다.

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
