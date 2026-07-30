# Collaboration workflow

AI 작업자는 변경 전에 `AGENTS.md`와 `CLAUDE.md`를 읽는다. 협업 또는 릴리스
정책을 바꾸면 세 파일을 같은 변경에서 갱신한다.

기능을 넣을지는 두 파일의 제품 방향으로 판단한다. DopeDB의 축은 workspace가
연결과 대시보드를 공유하되 장기 비밀값은 공유 레코드를 따라가지 않고
member-local OS 저장 또는 구성원별 단기 managed 자격 증명을 사용하는 것,
연결을 간단하게 유지하는 것, Agent가 일하고 화면이 관찰·승인·복구하는 것이다.
개별 기능의 결정 상태는
[`docs/DopeDB_VISUAL_REFERENCE_SPEC.md`](docs/DopeDB_VISUAL_REFERENCE_SPEC.md)의
기능 범위 결정 표가 소유한다.

## 기본 흐름

1. `git status --short --branch`로 다른 작업을 확인하고 보존한다.
2. 현재 `main`에서 요청 범위만 변경한다. Issue, 별도 branch, PR은 필요할
   때나 사용자가 요청할 때만 만든다.
3. 변경 범위에 맞춰 `pnpm build`, `pnpm test`, `pnpm test:rust` 중 필요한
   검증을 실행한다.
4. 커밋할 때는 `pnpm repo:identity`와
   [`docs/commit.md`](docs/commit.md)를 사용한다.
5. push를 요청받았고 `jaesong-blip`이 활성 계정이면
   `pnpm gh:owner -- git push origin main`을 사용한다.

원시 `gh auth switch`, force push, `main` 삭제, 실패한 검증 은폐, secret
출력은 금지한다. 계정 wrapper가 중단됐다면 실행 중인 프로세스가 없는지
확인하고 `pnpm gh:restore`로 복구한다.

## 테스트 변경

테스트는 `tests/critical-test-budget.json`의 104개 예산 안에서 유지한다. 새
테스트는 보안·안전, 공개 계약, 핵심 사용자 여정 중 하나를 보호해야 하며 보호
이유를 manifest에 기록한다. 기존 테스트를 확장하거나 가치가 낮은 테스트를
교체하고, 사용자의 명시적 결정 없이 총량이나 파일 수를 늘리지 않는다.
`pnpm check:test-budget`와 해당 smoke 명령을 실행한다.

## UI 변경

TSX, CSS, Tailwind, layout을 수정하기 전에
[`src/design-system/README.md`](src/design-system/README.md)를 읽는다.
semantic token과 공통 primitive를 재사용한다. 새 UI는 정적 `tw:` utility를
TSX에 직접 작성하고, utility 문자열만 보관하는 `styles.ts`, 화면별 CSS, CSS
module은 추가하지 않는다. 반복되는 시각·상호작용 패턴은 복사하지 않고 실제 공용
컴포넌트나 정본 primitive로 디자인 시스템에 올린 뒤 문서화한다. 이전한 화면의
낡은 selector, import, CSS 파일은 같은 변경에서 제거하고 같은 책임을 Tailwind와
legacy CSS 양쪽에 두지 않는다. shell, tool-window, data-grid 배치는 정적
Tailwind와 공용 React primitive가 소유하며 새 CSS는 문서화된
vendor/reset/token/primitive 경계에서만 허용한다. `pnpm build` 후 변경한 화면을
앱에서 직접 확인한다.

DopeDB 2026.1 reference가 UI/UX 정본이다. 변경한 scenario는
[`docs/DopeDB_PARITY_IMPLEMENTATION_TRACKER.md`](docs/DopeDB_PARITY_IMPLEMENTATION_TRACKER.md)의
UI 상태와 기능 상태를 각각 갱신한다. DopeDB 자체 baseline을 승인해 패리티를
증명하지 않으며, 아직 없는 기능은 동작하는 control처럼 만들지 않는다.

## 정식 릴리스

정식 릴리스는 사용자가 명시적으로 요청한 경우에만 `json-choi`가 수행한다.
모든 버전 소스를 같은 값으로 맞추고 `main`의 검증된 커밋에
`app-vX.Y.Z` 태그를 만든다. 보호된 환경, tag 규칙, signing key를 우회하거나
노출하지 않는다.
