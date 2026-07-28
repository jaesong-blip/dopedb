# UI 벤치마크 하네스 운영 가이드

이 문서는 DopeDB의 DopeDB 기반 UI 벤치마크 하네스를 실행하고 검토하며
baseline을 승인하는 절차를 설명한다. 구현 배경과 완료 조건은
[`docs/DopeDB_UI_BENCHMARK_HARNESS_PLAN.md`](../DopeDB_UI_BENCHMARK_HARNESS_PLAN.md)에
있다.

## 1. 무엇을 검증하는가

하네스는 서로 다른 세 기준을 섞지 않는다.

| 기준 | 역할 | 판정 |
| --- | --- | --- |
| DopeDB actual | 실제 `src/App.tsx`와 제품 컴포넌트 | pixel·구조·상호작용·접근성 차단 |
| DopeDB baseline | 사람이 승인한 이전 actual 화면 | pixel 회귀 차단 |
| DopeDB reference/clone | 정보 구조, 밀도, 명령 위치, 맥락 유지 | 비차단 리뷰 |

DopeDB 이미지를 DopeDB baseline으로 쓰거나 두 제품을 직접 pixel 비교하지
않는다. 제품 UI에는 Explorer 폭, 트리 행 밀도, 문서 탭, 편집기/결과 분할 같은
일반적인 IDE 원칙만 DopeDB 토큰과 기능으로 재해석한다. DopeDB 코드,
브랜드, 아이콘, 문구, 폰트와 CSS는 복제하지 않는다.

## 2. 실제 App 실행 구조

`tests/ui-harness/app/main.tsx`는 strict mock runtime을 먼저 설치한 뒤 실제
`src/App.tsx`를 dynamic import한다. 제품 진입점과 같은 provider,
TanStack Query 상태, design token, 화면과 컴포넌트를 사용한다.

mock 경계는 Tauri IPC, event와 대상 database뿐이다.

```text
Playwright
  ├─ actual: 실제 React App
  │    └─ strict Tauri IPC/event router + deterministic fixture
  └─ reference clone: tests/ui-benchmark/clone
       └─ 관찰 문서에서 유래한 브랜드 중립 측정값
```

router allowlist에 없는 command는 즉시 실패하고 호출 로그의 `unhandled`에도
남는다. 실제 network, database, credential 접근은 허용하지 않는다.

## 3. 등록 장면

| Tier | 장면 |
| --- | --- |
| 0 | `first-run`, `explorer-connected`, `compact-shell`, `terminal-open` |
| 1 | `table-data`, `sql-terminal`, `schema-erd`, `dashboard`, `settings` |
| 2 | `provider-setup`, `permission-review`, `loading-error`, `empty-results`, `long-content`, `keyboard-only` |

`desktop`은 1440×900, `compact`는 900×680이다. 560px drawer 동작은
interaction 계약에서 별도로 검증한다.

각 장면은 다음을 가진다.

- 제품이 실제로 읽는 localStorage seed
- frontend 타입에 맞춘 비민감 fixture
- 장면 전체 command allowlist와 중요 command 횟수
- command/action trigger 기반 event script
- DopeDB reference와 clean-room clone 연결
- 필요한 영역, role, 최소 main 폭과 Terminal 표시 계약

## 4. 설치와 일반 실행

최초 한 번 Chromium을 설치한다.

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
```

전체 검수:

```sh
pnpm ui:harness:test
```

이 명령은 먼저 다음 validator를 실행한 뒤 Playwright suite를 실행한다.

```sh
pnpm ui:harness:validate
```

validator는 TypeScript, helper self-test, reference/observation/rubric,
15개 장면 레지스트리, clean-room clone 격리, fixture 비밀정보,
baseline 파일·SHA-256·미승인 PNG를 검사한다.

하네스는 일상 push/PR CI에 포함하지 않는다. UI 집중 검수나 baseline 승인 때
로컬에서 명시적으로 실행한다.

## 5. 검수 항목

`shell.harness.ts`는 모든 장면에 대해 다음 검사를 분리 실행한다.

- strict IPC: allowlist, 횟수, page/console error, 외부 요청
- 구조·밀도: viewport overflow, 영역 경계, `min-width: 0`, control 높이,
  visual depth, resize handle, grid/Terminal 크기
- 접근성: landmark, accessible name, form label, heading 순서, inert,
  reduced motion과 장면별 role
- pixel: 승인된 macOS Chromium baseline

`workflows.harness.ts`는 Explorer→table, SQL script 실행, Terminal
focus/close, provider 실패·재시도, exact permission 거절, dashboard,
560px drawer, divider reset, portal menu와 keyboard-only 흐름을 실제 클릭과
키보드 입력으로 검증한다.

`benchmark.harness.ts`는 reference manifest, rubric, private-reference 부재 시
실행 가능성, clone의 외부 요청·브랜드 중립성과 측정값을 검증한다.

## 6. readiness와 결정성

고정 sleep은 쓰지 않는다. 준비 과정은 다음 신호를 기다린다.

- `document.fonts.ready`
- strict router pending 0
- skeleton, `aria-busy`, Terminal lazy surface와 ERD drag 상태 해제
- 주요 영역의 bounds, scroll size, transform, opacity가 연속 frame에서 동일

환경은 다음처럼 고정된다.

- 현재 시각: `2026-07-28T09:00:00.000Z`
- 순차적인 deterministic UUID
- `ko-KR`, `Asia/Seoul`, dark color scheme
- reduced motion, 숨긴 caret, 비활성 animation
- 장면 진입 때 scroll과 focus 초기화

핵심 장면 20회:

```sh
pnpm ui:harness:stability -- --scene first-run,explorer-connected --repeat 20
```

전체 장면 10회:

```sh
pnpm ui:harness:stability -- --all --repeat 10
```

반복 검사는 Chromium의 무의미한 PNG stream 차이를 배제하고 decoded RGBA를
pixelmatch threshold 0.01로 비교한다. 원시 pixel SHA-256은
`hashes.json`에 진단 정보로 남는다.

## 7. 후보 캡처와 review pack

한 장면을 고유 run id로 캡처한다.

```sh
pnpm ui:harness:capture -- --scene table-data --run table-toolbar-review
```

결과 위치:

```text
output/playwright/ui-review/table-toolbar-review/table-data/
  actual.png
  reference-clone.png
  measurements.json
  ipc-calls.json
  capture-metadata.json
```

review pack 생성:

```sh
pnpm ui:harness:review -- --scene table-data --run table-toolbar-review
```

추가 산출물은 DopeDB reference metadata/image(배포 정책이 허용할 때만),
이전 DopeDB baseline, diff, diff summary, scorecard template, review prompt,
외부 CDN이 없는 self-contained `review.html`이다.

review score는 다음 여섯 항목을 0–4로 기록한다.

- orientation
- workbench hierarchy
- density and alignment
- action locality
- context continuity
- accessibility

DopeDB 비교와 AI score는 참고 정보다. merge를 자동 차단하거나 baseline을
자동 승인하지 않는다.

## 8. Baseline 승인

일반 실패 때 `playwright --update-snapshots`를 사용하지 않는다. 의도적인
화면 변경은 먼저 캡처와 review pack을 확인한 뒤 장면 하나와 이유를 명시한다.

```sh
pnpm ui:harness:approve -- \
  --scene table-data \
  --run table-toolbar-review \
  --reason "Data toolbar density and edge alignment approved"
```

승인 스크립트는 다음 순서로 동작한다.

1. 기존 manifest와 모든 PNG hash를 검증한다.
2. 승인 전 baseline을 `previous.png`로 보존하고 diff를 만든다.
3. 지정한 장면의 candidate만 baseline으로 복사한다.
4. viewport, reference id, SHA-256, 이유, 날짜를 manifest에 기록한다.
5. 지정하지 않은 baseline이 바뀌지 않았는지 다시 검증한다.
6. 승인 후에도 이전 비교가 남도록 review pack을 재생성한다.

정본은
`tests/ui-benchmark/approvals/baseline-manifest.json`과
`tests/ui-harness/__screenshots__/chromium-macos/shell.harness.ts/`다.
manifest에 없는 PNG, hash 불일치, 중복/누락 장면은 validator가 실패시킨다.

## 9. 실패 산출물

Playwright 산출물은 저장소 루트의 `output/playwright/`에만 생성되고 git에서
제외된다.

```text
output/playwright/
  report/          HTML report
  test-results/    expected / actual / diff / trace / attachments
  ui-review/       명시적 capture와 review pack
  stability/       반복 hash와 perceptual mismatch
```

pixel 실패에는 expected/actual/diff와 trace가, shell 실패에는
measurements/accessibility/IPC JSON attachment가 함께 남는다.

## 10. 장면 추가

1. `tests/ui-harness/fixtures/`에 frontend 타입과 일치하는 fixture를 만든다.
   host/email은 `example.invalid`, 경로와 id는 `fixture-` 계열만 쓴다.
2. `scenarios/<name>.ts`에 storage, IPC, event, benchmark, expected 계약을
   작성한다.
3. `scenarios/types.ts`의 id union과 `scenarios/index.ts` registry에 등록한다.
4. 필요한 실제 사용자 흐름은 `workflows.harness.ts`에 추가한다.
5. observation과 clone metric이 새로 필요하면 source anchor까지 기록한다.
6. capture→review→approve 순서로 baseline 하나를 추가한다.
7. `pnpm ui:harness:validate`와 관련 suite를 실행한다.

하네스 파일은 critical test budget을 잠식하지 않도록 `*.harness.ts`로
유지한다. 테스트 전용 제품 shell, `vf-*` 호환 markup, 관대한 catch-all IPC,
production feature flag와 실제 사용자 데이터는 추가하지 않는다.

## 11. Reference 보관 정책

`tests/ui-benchmark/manifest.json`은 제품/버전/platform/scene/resolution/hash와
observation을 기록한다.

- `repository-audit`: 이미 저장소에 있는 감사용 crop을 hash로 검증한다.
- `private-reference`: 원본 경로나 이미지를 git에 기록하지 않고 logical key와
  hash만 보관한다.

private 원본이 없어도 actual, clone, 구조, 접근성, workflow와 baseline 검사는
모두 실행돼야 한다. review pack에도 private 이미지가 자동 포함되지 않는다.

## 12. 제품 UI 적용 원칙

현재 actual App에는 벤치마크에서 확인한 다음 원칙이 반영돼 있다.

- 40px global rail과 기본 304px Explorer
- 28px 객체 트리 행과 한 행당 suffix 최대 1개
- 36px 문서 탭과 얕은 toolbar stack
- edge-to-edge 데이터 그리드
- SQL 실행 toolbar, 큰 editor, 결과의 연속 split
- Terminal/permission surface가 현재 connection 맥락을 유지
- 카드 대신 평평한 first-run workbench

이 값들은 DopeDB 픽셀을 추출한 것이 아니라 observation을 DopeDB 기능과
semantic token으로 재해석한 값이다. 향후 DopeDB 또는 DopeDB major UI가
바뀌면 reference 갱신→observation 검토→clone 수정→actual 후보
capture→사람 승인 순서로 반복한다.
