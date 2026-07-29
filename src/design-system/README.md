# DopeDB UI 디자인 시스템

DopeDB의 UI/UX는 사용자가 제공한 DopeDB 2026.1 macOS reference를
clean-room 정본으로 한다. app chrome, tool window, document tab, toolbar,
data editor, query console, Services와 status bar의 구조·밀도·상호작용을
DopeDB 기준에 맞춘다. DopeDB의 안전 승인·감사 기능은 같은 UI 문법 안에서
확장한다.

DopeDB는 Tailwind CSS v4를 화면 배치의 기본 도구로 사용한다. Tailwind는 별도
디자인 언어가 아니라 `--ds-*` 역할 토큰과 앱 정본 primitive를 사용하는 얇은
utility 계층이다. 기존 CSS는 기능 단위로 제거하며, 데이터 그리드·vendor widget·
앱 shell처럼 CSS가 구조적으로 더 알맞은 경계는 유지한다.

영역별 UI/UX 패리티와 기능 패리티는
[`docs/DopeDB_PARITY_IMPLEMENTATION_TRACKER.md`](../../docs/DopeDB_PARITY_IMPLEMENTATION_TRACKER.md)에
분리해 기록한다. 기존 DopeDB screenshot baseline은 디자인 정본이 아니다.

## 정본

| 관심사 | 정본 |
| --- | --- |
| 색상·타이포그래피·간격·radius·elevation | `src/design-system/tokens.css` |
| Tailwind theme bridge와 진입점 | `src/design-system/index.css` |
| 버튼·배지·카드·폼·toolbar·상태 | `src/design-system/system.css` |
| 반복되는 React UI primitive | `src/design-system/components/` |
| 앱 shell과 workbench 레이아웃 | `src/styles.css` |
| 새 화면 고유 배치 | TSX에 직접 작성한 정적 `tw:` utility |

컴포넌트 코드에 토큰이 이미 있는데 hex/rgb 값을 직접 추가하지 않는다. 새 역할이
필요하면 `tokens.css`에 surface/foreground 쌍으로 정의하고 사용한다.

## Tailwind v4 계약

- `tailwindcss`와 공식 Vite/PostCSS 통합은 `4.3.3`으로 고정한다.
- 모든 utility는 `tw:` 접두어를 사용한다. 기존 의미 클래스와 이름이 충돌하지
  않게 하는 migration 경계다.
- Preflight는 import하지 않는다. 기존 reset을 화면별로 옮기고 세 앱의 시각
  회귀를 확인한 뒤 별도 변경에서만 활성화를 검토한다.
- `@theme inline`은 semantic token만 노출한다. `tw:bg-[#111]`,
  `tw:text-[rgb(...)]` 같은 raw color utility는 금지한다.
- utility class는 TSX에 보이는 정적인 완전한 문자열이어야 한다. 런타임 조각
  조합과 utility 문자열만 감추는 `styles.ts`/style map은 사용하지 않는다.
- 같은 시각·상호작용 계약이 반복되면 class 문자열을 복사하지 않고
  `src/design-system/components/`의 실제 공용 컴포넌트나 `system.css`의 정본
  primitive로 승격하고 이 문서에 등록한다.
- `.btn`, `.badge`, `.ds-panel`, `.ds-toolbar` 같은 상호작용 primitive는
  `system.css`가 계속 소유한다. utility로 같은 primitive를 화면마다 재구현하지
  않는다.
- 새 screen/component CSS와 CSS module은 만들지 않는다. CSS 추가는 token,
  reset, 정본 primitive, 문서화된 shell grid/data-grid/vendor integration
  경계에만 허용한다.
- 전용 CSS를 이전하면 import와 파일을 같은 변경에서 삭제한다. 호환용 wrapper나
  중복 selector를 남기지 않는다.
- 데스크톱은 `@tailwindcss/vite`, 두 Next 앱은 `@tailwindcss/postcss`를
  사용한다. 세 실행면 모두 같은 migration 원칙을 따른다.

결정 배경과 완료 조건은
[`docs/adr/0005-tailwind-v4-migration.md`](../../docs/adr/0005-tailwind-v4-migration.md)에
기록한다.

## 시각 방향

- 앱 chrome은 눈에 띄지 않고 사용자의 데이터와 도구를 감싼다.
- macOS native menu와 별도로 WebView 안에 File/Edit/View 계열 텍스트 메뉴를
  만들지 않는다. 앱 내부 title toolbar는 project context, tool-window launcher,
  search와 settings를 소유한다. project context의 chevron은 단순 화면 이동
  button에 붙이지 않는다. 실제 활성 workspace 이름과 전환, 새 연결, workspace
  관리 action을 제공하는 portal menu여야 하며 Explorer 안에 같은 selector를
  중복 배치하지 않는다.
- title toolbar 중앙에는 현재 주요 tool window의 직접 launcher만 둔다.
  보조 tool window와 document 생성 action은 끝단의 실제 `ToolbarMenu`에
  배치하고, 구현되지 않은 Files/VCS를 모양만 있는 launcher로 만들지 않는다.
  DopeDB 기준 위치에 없는 DopeDB 전용 Dashboard도 직접 launcher로 승격하지
  않고 More menu가 소유한다.
- generic `새 연결` 진입은 특정 engine form을 임의 선택하지 않고 검색 가능한
  provider/driver `CommandMenu`를 즉시 연다. engine/provider preset이 명시된
  진입만 해당 속성 form을 바로 표시한다. 실제 생성하지 않는 demo나 지원하지
  않는 provider resource를 선택지 설명으로 약속하지 않는다.
- tool window는 좌·우·하단 anchor, tab stack, resize와 persistence를 공유하는
  하나의 layout 문법으로 구현한다.
- Database Explorer header는 전체 tree의 expand/collapse, 실제 view option,
  hide를 소유한다. 그 아래 command row가 data source 추가, refresh, 설정,
  query console과 search toggle을 소유하며, 검색 input은 toggle이 열었을
  때만 표시한다. connection row마다 같은 global action을 반복하지 않는다.
- 색상보다 `muted`, `selection`, `border`를 먼저 사용한다.
- 일반 surface는 평평하게 유지한다. 그림자는 popover, dialog, toast처럼 떠 있는
  surface에만 사용한다.
- 카드 안에 카드를 중첩하지 않는다.
- 선택 상태는 `--ds-selection`을 사용한다. primary 색을 선택 배경으로 쓰지 않는다.
- primary 버튼은 한 흐름에 하나만 둔다.

## 색상 역할

토큰은 surface와 foreground를 쌍으로 사용한다.

| 역할 | 용도 |
| --- | --- |
| `--ds-background` / `--ds-foreground` | 앱 canvas와 기본 텍스트 |
| `--ds-card` / `--ds-card-foreground` | canvas 위 작업 패널 |
| `--ds-popover` / `--ds-popover-foreground` | menu, dialog, toast |
| `--ds-primary` / `--ds-primary-foreground` | 단일 affirmative action |
| `--ds-secondary` / `--ds-secondary-foreground` | 낮은 강조의 control |
| `--ds-muted` / `--ds-muted-foreground` | caption, placeholder, 비활성 chrome |
| `--ds-selection` / `--ds-selection-foreground` | hover, active, current row |
| `--ds-destructive` / `--ds-destructive-foreground` | 삭제·폐기·차단 |
| `--ds-input` | form field와 outline control |
| `--ds-ring` | focus-visible과 selected cell outline |
| `--ds-editor-surface` | SQL editor와 코드 인접 surface |
| `--ds-worktree-sidebar*` | database explorer와 navigation |

DopeDB 기존 화면은 `--ds-surface-*`, `--ds-text*`, `--ds-accent*` 별칭을 사용한다.
이 별칭은 위 역할 토큰에 연결되어 있으므로 새 화면에서는 역할이 더 명확한 정본
토큰을 우선한다.

색상 상태는 다음에만 사용한다.

- `--ds-info`: 정보와 실행 중 상태
- `--ds-success`: 성공, 연결됨, trust
- `--ds-warning`: 검토 필요, medium risk
- `--ds-danger`: 실패, 차단, destructive

상태색을 navigation 선택이나 장식에 재사용하지 않는다.

## 타이포그래피

- Sans: `Geist` 우선, OS sans-serif fallback.
- Mono: `--ds-font-mono`. 경로, SQL, 값, 식별자, 숫자 비교에 사용한다.
- Body: 14px.
- Dense UI: 13px.
- 보조 텍스트: 12px.
- uppercase category label: 11px, 600–700 weight, `0.05em` tracking.
- 큰 제목은 `-0.02em`, 패널 제목은 `-0.01em` tracking을 사용한다.
- 데이터 숫자는 `font-variant-numeric: tabular-nums`를 사용한다.

## Radius와 elevation

DopeDB 2026.1의 compact control과 둥근 outer tool-window geometry를 역할별
scale로 표현한다.

- 작은 내부 요소: `--ds-radius-xs` (6px)
- button/input: `--ds-radius-sm` (8px)
- 일반 surface: `--ds-radius-md` (10px)
- card/panel: `--ds-radius-lg` (14px)
- badge/count: `--ds-radius-pill`

Elevation은 세 단계만 허용한다.

1. 기본: border 또는 divider
2. control: `--ds-shadow-control`
3. floating: `--ds-shadow-popover`

일반 card/panel에는 shadow를 추가하지 않는다.

## 컴포넌트

### React primitive

- `ToolWindowHeader`: Database Explorer, Agent, provider 패널의 고정 헤더와
  우측 action 슬롯.
- `ToolWindowSection`: dense tool window 안의 제목 있는 명령 그룹.
- `ToolWindowAction`: provider/demo/object launcher의 icon-label-trailing 행.
- `Field`, `TextInput`, `SelectInput`, `CheckboxField`: label, focus, disabled
  상태를 함께 소유하는 dense form control.
- `PanelTabs`: 데이터소스 속성·설정 패널의 ARIA tab navigation.
- `EnvironmentBadge`: dev/staging/prod 의미색과 대문자 표기를 한곳에서 소유.
- `TreeSectionButton`, `TreeSearch`: DopeDB 객체 트리의 일반 문장형
  hierarchy row, keyboard toggle과 dense object search. 데이터베이스·스키마·
  객체 폴더 이름을 uppercase category heading처럼 바꾸지 않는다.
- `PopupMenu`, `PopupMenuItem`, `PopupMenuCheckbox`: 평평한 popover menu
  surface와 keyboard-focus 가능한 command/check row.
- `CommandMenu`, `CommandMenuGroup`, `CommandMenuItem`: 검색 입력, 분류,
  설명이 필요한 생성·선택 command popup.
- `ModalBackdrop`, `ModalSurface`: background interaction을 차단하는 공용
  viewport backdrop과 responsive dialog frame. SQL parameter처럼 실행 전에
  값을 완성하는 feature dialog도 이 frame과 `.ds-action-row` footer를 사용하고
  별도 modal CSS를 만들지 않는다.
- `WorkbenchPane`, `WorkbenchToolbar`, `WorkbenchSelect`,
  `WorkbenchContextHeader`, `WorkbenchDivider`, `WorkbenchEmptyState`: 데이터
  편집기·SQL·문서 화면의 평평한 IDE pane, command row, compact context select,
  object context, empty state 계약.
  중앙 workbench의 data source 문맥은 별도 대형 connection header를 만들지
  않고 document tab, context toolbar, status bar에 나눠 표시한다. SQL 문서
  제목은 tab을 더블 클릭해 편집한다. SQL schema selector는 catalog에서 발견한
  namespace만 표시하는 compact native control이며, 선택값을 문서에 영속하고
  Explain/read/write/script 실행과 status/Services projection이 같은 값을
  사용한다. Playground/Script resolve mode도 같은 `WorkbenchSelect`를 사용하고
  문서에 영속하며, SQL editor의 engine dialect와 caret 기준 schema completion
  context를 바꾼다. selector를 위해 feature CSS나 style map을 만들지 않는다.
  SQL 실행 상태는 실행 당시 document snapshot과 정확한 CodeMirror source
  range가 현재 문서에 그대로 남아 있을 때만 문장 끝 inline widget으로
  표시한다. 성공 duration과 running/waiting/failed/cancelled label은 Services와
  같은 lifecycle projection을 사용한다. 동일한 SQL이 여러 번 있어도 단순
  문자열 검색으로 첫 occurrence에 붙이지 않으며, widget은 정적 Tailwind
  utility와 semantic token만 사용한다.
  document tab은 welcome/schema/data/SQL/activity를 숨김 예외 없이 같은 strip에
  투영한다. 각 tab은 읽을 수 있는 고정 폭을 유지하고 활성 문서가 바뀌면
  수평 strip 안에서 자동으로 드러난다. 끝단의 portal `ToolbarMenu`는 모든
  열린 문서를 나열해 overflow된 문서도 실제 활성화할 수 있어야 한다. 새 쿼리,
  Activity처럼 title toolbar나 status에서 이미 제공하는 action을 tab strip에
  중복 배치하지 않으며, tab용 feature CSS나 style map을 만들지 않는다.
- Explorer와 Local History는 같은 왼쪽 anchor를 쓰되 서로 다른 저장 폭을
  가진다. AI Chat도 오른쪽 anchor 폭을 별도로 저장해 한 tool window의 수동
  resize가 다른 종류의 기본 비율을 훼손하지 않게 한다.
- Local History의 현재 `Recent` view는 tool-window header가 소유한다. 실제
  revision 복원 action은 검색/필터 문맥과 같은 command row에 두고 panel
  close와 섞지 않는다. project external-change 기능이 생기기 전에는 빈 file
  tree나 가짜 view action을 추가하지 않는다.
- Services는 tool window 이름과 닫기 action을 전체 폭 `ToolWindowHeader`가
  소유한다. 그 아래에서 실행 가능한 database/document/session tree와
  Output/Result tab surface를 약 `32% / 68%`로 나눈다. Schema·Activity처럼
  query lifecycle에 속하지 않는 열린 문서는 Services tree에 투영하지 않는다.
- tabular Result는 `WorkbenchToolbar`에 현재 grid 표시, 실제 전체 셀 검색,
  복사·CSV·JSON action을 놓고 `DataGrid` 아래 고정 footer에
  visible/filtered row count와 duration을 표시한다. DopeDB에 보인다는 이유만으로
  transaction, DDL, edit action을 handler 없이 추가하지 않는다.
- AI Chat composer는 큰 multiline surface, 내부 context chip/action row,
  외부 model/data-source context row의 세 층을 사용한다. 첨부 chip과 popup은
  semantic token과 기존 button/icon 규칙으로 조합하며 feature CSS를 만들지
  않는다. session 전용 tab action menu는 활성 session이 있을 때만 표시하며
  빈 AI Chat에 disabled kebab을 남기지 않는다.
- Query parameter dialog는 parameter token/이름과 SQL expression 값을 한 행에
  대응시키고, 빈 값에서는 primary 실행 action을 비활성화한다. 치환 설명은
  semantic muted surface에 두며 feature 전용 CSS나 style map을 만들지 않는다.
- SQL toolbar의 실행은 채움 primary button이 아니라 DopeDB command 문법의
  평평한 icon action과 semantic success glyph를 사용한다. manual transaction이
  구현되기 전에는 `Tx: Auto`에 가짜 menu chevron이나 commit/rollback action을
  붙이지 않는다.
- `ResultMeta`, `SqlSnippet`: 결과 pane의 고정 metadata bar와 축약 SQL 표기.
- `WorkbenchStatusFooter`: table data와 query result가 공유하는 고정 하단
  상태선. 페이지/visible row 범위, duration, 선택 상태처럼 현재 grid에서
  계산된 값만 표시하며 상단 context header와 같은 정보를 중복하지 않는다.
- `ResultWorkbenchToolbar`, `ResultWorkbenchFooter`: materialized/streaming
  결과가 공유하는 grid mode, 전체 셀 검색, 실제 export action과 행·duration
  footer. `ResultWorkbenchFooter`는 `WorkbenchStatusFooter`를 합성하고, 부분
  stream은 평탄화하지 않고 완료된 결과에만 검색을 적용한다.
- 일반·가상 `DataGrid`는 `data-data-grid-scroll` surface 계약을 공유한다.
  sticky header, filter, zebra/hover/selection, resize handle, scrollbar는
  컴포넌트의 정적 Tailwind v4 utility와 semantic token으로만 구성한다.
  grid 전용 CSS 파일이나 class selector를 다시 만들지 않는다. 주변 pane이
  compact/busy 상태를 투영할 때도 이 data attribute를 사용한다.
  두 grid의 셀 선택은 공용 anchor/focus 좌표 계약을 사용한다. Shift+click과
  Shift+방향키는 직사각형 범위를 확장하고, 범위 복사는 행을 줄바꿈하고 셀을
  tab으로 구분한 텍스트를 만든다. 선택 배경과 focus ring도 기존
  `selection`/`ring` semantic token만 사용한다.
- SQL table data editor는 command toolbar 바로 아래에 같은 폭의 `WHERE`와
  `ORDER BY` expression field를 둔다. Enter 또는 field action으로 실제
  server query를 다시 실행하고 Escape는 적용되지 않은 draft를 되돌린다.
  fragment는 backend read-only proposal을 통과해야 하며 주석, 문장 구분자,
  다른 clause로 경계를 벗어나 generated `LIMIT`을 삼킬 수 없다.
- 정렬 trigger와 column filter trigger는 header 안의 서로 다른 button이다.
  filter popover는 현재 page에서 관찰한 값과 원래 개수를 검색 가능한 checklist로
  표시하고, 선택 뒤 결과가 바뀌어도 그 inventory를 유지한다. popover, field,
  selected trigger는 공용 menu와 semantic `popover`/`selection` token의 정적
  Tailwind v4 utility로만 구성한다.
- `InspectorHeader`, `InspectorFooter`: 셀 보기·행 편집·검토 inspector의 제목,
  action cluster, sticky footer 계약.
- `ToolbarMenuItem`: portal 기반 `ToolbarMenu` 안에서 사용하는 공통 command row.
- `StatusDot`, `StatusBarItem`, `LoadingLabel`, `InlineNotice`: lifecycle 상태 점,
  IDE 하단 상태 segment, 비동기 진행 label, warning/danger inline 상태 행.
  SQL 상태선은 CodeMirror가 보고한 실제 `line:column`, line ending, encoding과
  동일한 editor indent 설정을 `StatusBarItem`으로 나눈다. Agent broker의
  unread operation은 공용 bell action의 semantic dot으로만 표시하고 누르면
  실제 Activity 문서를 연다. 화면 전용 status CSS나 style map은 만들지 않는다.
- `DiagnosticSummary`, `DiagnosticCount`: 설정·속성 편집기의 Problems 목록과
  오류/경고 개수를 같은 compact hierarchy로 표시.
- `SettingsGroup`: 설정·정책 화면의 제목, 중립 border, dense spacing을 공유하는
  control group surface.

툴윈도우 primitive는
[`src/design-system/components/ToolWindow.tsx`](components/ToolWindow.tsx)에
있고 form과 tab primitive는 같은 디렉터리의 `FormControls.tsx`,
`PanelTabs.tsx`에 있다. 같은 형태는 화면에서 utility 문자열로 다시 만들지
않는다.

### 버튼

기본 클래스는 `.btn`이며 DopeDB toolbar의 낮은 chrome 무게를 표현한다.

| 조합 | 용도 |
| --- | --- |
| `.btn.primary` | 저장·확인·실행 등 한 흐름의 단일 affirmative action |
| `.btn` | toolbar 또는 독립 outline action |
| `.btn.ghost` | icon button과 list-row action |
| `.btn.link` | 문장 안의 inline action |
| `.btn.danger` | 삭제·폐기·되돌릴 수 없는 action |
| `.btn.danger-ghost` | toolbar의 삭제 후보 action; 최종 확인 전에는 채우지 않음 |
| `.btn.small` | 32px dense toolbar control |
| `.btn.small.icon-only` | 32px toolbar icon action; padding 없는 정사각형 |
| `.btn.small.icon-only.icon-xs` | 24px close·dismiss·inline remove action |

Cancel, Close, Dismiss는 destructive가 아니다. 기본 `.btn` 또는 `.btn.ghost`를
사용한다.

아이콘 버튼은 중요도에 따라 세 단계만 사용한다.

1. 24px: 패널 닫기, tab/목록의 제거처럼 주변 문맥이 분명한 보조 action
2. 32px: toolbar, pagination, refresh, overflow menu의 기본 icon action
3. 36px: product rail과 workspace처럼 앱의 주 navigation action

아이콘만 있는 `.btn`에는 반드시 `.icon-only`와 `aria-label`을 함께 둔다. `title`은
hover tooltip으로 병행할 수 있지만 접근 가능한 이름을 대신하지 않는다. 보통
icon action은 투명한 surface로 시작하고 hover/active에서만 중립 배경을 드러낸다.
삭제 icon도 idle 상태에서는 빨간 채움 상자로 만들지 않고 의미색 glyph를 사용하며,
최종 확인 action만 `.btn.danger`의 채움 surface를 사용한다. 변경한 화면에서는
단일 아이콘 `.btn`의 정사각형 규격과 접근 가능한 이름을 직접 확인한다.

### Surface

- `.card` / `.ds-card`: 반복 항목과 작은 정보 그룹
- `.ds-panel`: 넓은 작업 surface
- `.grid-panel`: job 결과 surface
- `[data-data-grid-scroll]`: Tailwind로 구성하는 표·쿼리 결과 surface

Surface는 기본적으로 `card + border + rounded-lg + no shadow`다. floating surface만
`--ds-shadow-popover`를 사용한다.

### Badge

- `.badge`: 중립 metadata
- `.badge.kind`: 선택보다 약한 category 표기
- `.badge.status-ok`, `.badge.risk-low`: 성공/trust
- `.badge.risk-medium`: warning/review
- `.badge.status-error`, `.badge.risk-high`: 오류/차단
- `.badge.nowhere`: 실행 위치가 없어 실제로 차단된 상태

### Form

- label과 control은 `space-2` 수준의 간격을 유지한다.
- input/select/textarea는 `--ds-input` surface를 사용한다.
- 오류는 `aria-invalid`, `role="alert"`, semantic danger utility로 표시한다.
- 사용자가 읽거나 재시도해야 하는 오류는 toast로만 숨기지 않는다.
- form action은 destructive → neutral → primary 순으로 배치한다.

### 리스트 행

- idle: 투명
- hover: `--ds-muted`
- keyboard selected/current: `--ds-selection`
- focus: `--ds-ring`

선택 상태를 임의 hex나 primary 버튼 색으로 만들지 않는다.

## 공통 클래스

워크벤치:

- `.ds-workbench-head`, `.ds-workbench-title`, `.ds-title-line`
- `.ds-meta-row`, `.ds-meta-dot`

Toolbar:

- `.ds-toolbar-spacer`
- `.ds-control-row`
- `ToolbarMenu`, `.ds-menu-popover`, `.ds-menu-item`

Agent/safety:

- `.ds-card-stack`, `.ds-card-title-row`, `.ds-card-row`
- `.ds-tone-trust`
- `.ds-attention-stack`, `.ds-attention-badge`

Utility:

- `.icon`, `.ui-help`, `.icon-only-badge`
- `.scrollbar-sleek`

텍스트 색·크기·간격 같은 단일 속성을 `.muted`, `.error`, `.loading`, `.form`
같은 범용 클래스에 다시 모으지 않는다. 화면에서는 semantic `tw:` utility를
사용하고, 비동기 진행처럼 구조와 접근성 계약이 있는 경우 `LoadingLabel` 같은
React primitive로 승격한다.

## UX 규칙

1. 0–100ms 작업에는 별도 feedback을 보이지 않는다.
2. 100ms–1s는 control만 disabled 처리한다.
3. 1–3s는 spinner 또는 label swap을 사용한다.
4. 3s 이상은 현재 단계를 구체적인 동사로 표시한다.
5. loading label이 길어져도 layout이 움직이지 않도록 공간을 예약한다.
6. tooltip은 icon-only control의 이름을 알려줄 때만 사용한다.
7. 오류·경고·blocking state는 사용자가 행동할 수 있는 곳에 inline으로 둔다.
8. `Esc`는 조용히 빠져나가는 경로이며 별도 색상이나 keyboard chip을 붙이지 않는다.
9. icon-only 버튼에는 `aria-label` 또는 접근 가능한 이름이 있어야 한다.
10. hover, focus-visible, disabled, empty, error 상태를 함께 구현한다.
11. 애니메이션은 continuity를 설명할 때만 사용하고 reduced motion을 존중한다.
12. macOS, Windows, Linux와 좁은 창에서 control label과 shortcut을 확인한다.

## 툴바와 floating menu 계약

데이터·ERD처럼 control 수가 많은 작업 툴바는 두 영역으로 나눈다.

1. 선행 작업 영역은 `min-width: 0`과 수평 overflow를 소유한다.
2. pagination, 저장, overflow menu 같은 끝단 control은 축소되지 않고 고정된다.

좁은 창에서 툴바 전체를 여러 줄로 쌓지 않는다. 덜 자주 쓰는 명령은
`ToolbarMenu`로 이동하고, icon-only shortcut은 접근 가능한 이름과 tooltip을
  유지한다. 이 구조는 DopeDB data editor와 query console에서 확인한 action
  locality와 고정된 끝단 control을 현재 workbench에 맞게 표현한 것이다.

toolbar의 command overflow menu는 반드시 portal 기반 `ToolbarMenu`를 사용한다.

- `--ds-menu-min-width`보다 작아지지 않으며 항목 label을 숨기지 않는다.
- `--ds-viewport-gutter` 안으로 좌우 위치를 clamp하고, 아래 공간이 부족하면 위로
  뒤집는다.
- pane의 `overflow: hidden/auto`에 잘리지 않는다.
- `Esc`, 바깥 클릭, 위·아래/Home/End 키 이동을 제공한다.
- 각 항목은 박스형 `.btn`을 중첩하지 않고 평평한
  `role="menuitem"` `.ds-menu-item`을 사용한다.

과거의 `.toolbar-menu`와 `.toolbar-menu-panel`은 금지한다.

## 좁은 창 shell 계약

Tauri 최소 창 크기에서는 explorer와 main을 세로로 고정 분할하지 않는다. 고정
분할은 header와 toolbar가 본문 높이를 모두 소비해 데이터 행을 볼 수 없게 만든다.

- 560px 이하에서는 main이 rail 위의 전체 높이를 소유한다.
- explorer는 왼쪽 drawer이며 현재 product rail 버튼, 바깥 scrim, `Esc`로
  열고 닫는다.
- table/connection을 선택하면 drawer를 닫아 결과에 초점을 돌린다.
- macOS overlay title bar의 높이는 닫힌 drawer에서도 main 위쪽에 구조적으로
  예약한다.
- drawer는 본문을 재배치하지 않고 덮으므로 열고 닫을 때 데이터 grid의 크기와
  scroll 위치가 바뀌지 않는다.

## 시각적 깊이 계약

한 화면의 시각적 깊이는 control을 포함해 최대 3단계다.

1. 화면/영역: 배경 또는 한 방향 divider
2. 작업 surface/반복 항목: 실제 정보 그룹에만 border
3. control/상태: button, input, badge

`panel -> card -> card`나 `inspector -> bordered list -> bordered row` 구조를 만들지
않는다. 새 박스보다 여백, 제목, divider를 먼저 사용한다.

새 horizontal control cluster는 `.ds-control-row`를 포함하고, grid track은 `1fr`
대신 `minmax(0, 1fr)`를 사용한다.
화면별 높이는 해당 행에 `--ds-row-control-size`를 지정한다. 공통 규칙은 이 값을
재정의하지 않고 `--ds-control-field` fallback만 사용하므로 CSS import 순서에 따라
32px/36px control이 뒤섞이지 않는다. `.btn.small`과 `.icon-only`처럼 크기를
명시한 control은 `--ds-control-local-size`가 row fallback보다 우선하므로, 뒤에서
로드된 `.ds-control-row`가 32px 버튼을 다시 36px로 키울 수 없다.

## 새 UI를 추가할 때

1. 가장 가까운 sibling screen을 먼저 확인한다.
2. `system.css`와 `src/design-system/components/`의 기존 primitive를 먼저
   검색한다.
3. 화면 고유 배치는 TSX의 정적 `tw:` utility로 구현한다.
4. 같은 class/interaction 묶음이 반복되면 실제 공용 컴포넌트로 승격하고 이
   문서의 컴포넌트 목록에 추가한다.
5. 이관한 기능의 legacy selector, import, CSS 파일을 같은 변경에서 삭제한다.
6. 색상은 theme role로만 선택하고 raw arbitrary color를 쓰지 않는다.
7. 새 token은 세 화면 이상에서 같은 의미로 반복될 때만 추가한다.
8. 한 사용자 흐름은 `data-primary-flow` 경계 안에 primary action 하나만 둔다.
9. `pnpm build`를 실행하고 실제 앱에서 변경한 화면과 좁은 창을 확인한다.

참고 기준:

- [`docs/DopeDB_PARITY_IMPLEMENTATION_TRACKER.md`](../../docs/DopeDB_PARITY_IMPLEMENTATION_TRACKER.md)
- [DopeDB tool windows](https://www.DopeDB.com/help/DopeDB/tool-windows.html)
- [DopeDB query consoles](https://www.DopeDB.com/help/DopeDB/query-consoles.html)
- [DopeDB Services tool window](https://www.DopeDB.com/help/DopeDB/services-tool-window.html)
