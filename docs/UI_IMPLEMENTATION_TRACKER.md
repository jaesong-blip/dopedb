# UI 구현 상태 트래커

이 문서는 [`PRODUCT_UI_SCOPE.md`](./PRODUCT_UI_SCOPE.md)가 허용한 화면의 현재 구현
상태와 소유 경계를 기록한다. 외부 제품과의 기능 개수나 시각 유사도를 평가하지
않는다. 검수는 같은 DopeDB scenario의 전후 상태, accessibility tree, packaged
runtime과 성능 수치로 수행한다.

## 상태

- `complete`: 실제 command와 authoritative state owner가 있고 자동·수동 검수가 끝남
- `partial`: 핵심 경로는 동작하지만 아래 명시된 acceptance gap이 남음
- `missing`: 범위에는 속하지만 아직 구현하지 않음
- `out-of-scope`: 제품 범위 결정상 화면이나 placeholder를 만들지 않음

## 화면 상태

| 영역 | 상태 | 현재 소유자 | 남은 acceptance gap |
| --- | --- | --- | --- |
| App shell/chrome | `complete` | `features/appShell`, design-system chrome primitives | packaged macOS·Windows에서 keyboard launcher와 compact window를 정기 확인 |
| Action Search | `complete` | `features/actionSearch` | cached catalog scope, `/` action mode, focus 복구와 bounded top-k를 유지 |
| Welcome document | `complete` | `screens/Onboarding` | 연결 전/후 실제 command 집합이 달라지는지 packaged smoke에서 확인 |
| Database Explorer | `complete` | `screens/Connections/DatabaseExplorer`, `features/catalogExplorer` | 대형 catalog의 selection/scroll 보존과 accessibility tree 확인 |
| Connection editor | `complete` | `features/connections/useConnectionEditorController` | 지원 engine별 최소 입력·Test·Apply/OK 실제 연결 검수 |
| Provider account access | `complete` | `workspace-cloud/features/providerAccess`, provider application modules | 실제 계정 OAuth/CLI 실패·recovery 및 revoke 검수 |
| SQL editor/query workflow | `complete` | `features/queries`, `screens/Sql`, Rust query application | 10 KiB/100 KiB/1 MiB 입력과 cancel/transaction packaged 검수 |
| Result/Data grid | `complete` | `features/queryResults`, Rust result artifact | 30열·50,000행 selection/filter/export와 메모리 경계 검수 |
| Services/Jobs | `complete` | `features/queryServices`, `features/jobs` | background cancel과 복원된 result handle packaged 검수 |
| Agent tool window | `complete` | `features/agents`, ACP Rust runtime | 공식 adapter 설치·로그아웃·permission·resume의 OS별 검수 |
| Knowledge graph | `complete` | Rust `features/knowledge`, frontend Knowledge projection | GitHub/Local source revision, publish, mapping과 exact grant 검수 |
| Analysis Article | `partial` | `features/analysisArticles`, cloud analysis application | production runner, publication, metric signal의 실제 환경 검수 |
| Settings | `complete` | `features/settings` | keyboard navigation, compact viewport와 scope별 즉시 저장 검수 |
| Diagnostics/Recovery | `complete` | design-system diagnostics, feature recovery boundaries | failure injection에서 오류 owner와 retry가 유지되는지 확인 |

## 공용 UI 계약

| 계약 | 상태 | 검증 |
| --- | --- | --- |
| semantic token과 raw color 차단 | `complete` | `pnpm check:ui-palette` |
| 공용 icon command/accessible name | `complete` | `pnpm check:ui-primitives` |
| static Tailwind v4 utility | `complete` | build와 source guard |
| modal focus containment/trigger 복구·title drag | `complete` | browser interaction smoke, 공용 primitive와 native mouse drag |
| popup/menu viewport collision | `complete` | 공용 popup/menu primitive |
| grid composite keyboard/resize separator | `complete` | 공용 roving helper, `ResizeSeparator`, packaged interaction smoke |
| grouped AppShell presentation contract | `complete` | `pnpm check:architecture` |
| generic UI의 feature/adapter 비의존 | `complete` | transitive architecture guard |
| critical test 예산 | `complete` | `pnpm check:test-budget` |

## 핵심 사용자 시나리오

### 1. 처음 연결

1. Welcome에서 새 연결을 연다.
2. engine을 고르고 검증된 최소 필드만 입력한다.
3. Test가 실패하면 입력 가까이에서 원인과 recovery를 본다.
4. Apply/OK 후 Explorer와 새 query가 같은 connection identity를 사용한다.

Acceptance: 임의 고급 옵션, 계획 중 provider, 저장되지 않는 가짜 control이 없어야
하며 장기 secret은 shared record에 들어가지 않는다.

### 2. 공유 연결 사용

1. workspace의 redacted connection revision을 선택한다.
2. 구성원은 member-local secret을 바인딩하거나 허용된 managed lease를 받는다.
3. Explorer, query, Agent가 같은 workspace/account/connection revision을 사용한다.
4. revoke나 revision 변경 뒤 stale cache와 실행 권한이 재사용되지 않는다.

Acceptance: account integration 조회 실패가 shared connection inventory 전체를
무너뜨리지 않고, 권한과 credential lifetime이 화면 상태와 일치해야 한다.

### 3. Query와 결과 관찰

1. SQL document에서 Run 또는 안전한 statement preview를 실행한다.
2. parameter, approval, manual transaction 상태를 실행 전에 확인한다.
3. streaming result를 grid에서 선택·복사·filter하고 Services에서 작업을 관찰한다.
4. 큰 결과는 native artifact와 streaming export를 사용하고 renderer가 전체 row를
   보관하지 않는다.

Acceptance: cancel 후 connection을 검증 없이 재사용하지 않고 write outcome이
불명확하면 `outcome_unknown`을 보존한다.

### 4. Agent 작업

1. Project·Environment를 선택하고 공식 ACP adapter를 시작한다.
2. Desktop이 exact grant와 connection/graph revision을 immutable pin으로 고정한다.
3. 화면은 tool 진행, permission, result, 중단과 복구를 보여준다.
4. provider 인증은 로컬 CLI가 소유하며 앱은 token을 읽거나 login UI를 만들지 않는다.

Acceptance: general MCP server, arbitrary provider API, 승인 우회 mode와 stale session
focus가 없어야 한다.

### 5. Knowledge와 Analysis Article

1. GitHub repository 또는 Local Folder를 Project Environment에 연결한다.
2. deterministic extraction이 immutable graph revision과 evidence anchor를 만든다.
3. Agent는 exact graph/connection grant에서 Analysis Article draft와 bounded read를
   제안한다.
4. 사람만 mapping, schedule, result publication과 public snapshot을 승인한다.

Acceptance: Local 원문은 명시적 publish 전 local-only이며 public article은 query나
credential 없이 immutable approved snapshot만 읽는다.

## 트래커 갱신 규칙

- 화면을 바꾸면 해당 행의 상태, owner, 남은 gap을 같은 변경에서 갱신한다.
- `complete`는 build 통과만 뜻하지 않는다. 실제 command/state owner와 변경 위험에
  비례한 runtime 검수가 모두 필요하다.
- `missing`은 구현된 것처럼 보이는 disabled control로 대체하지 않는다.
- 시점별 긴 작업 일지, 외부 비교 screenshot, 임시 hash는 이 문서에 누적하지 않는다.
  재현 가능한 영구 계약은 ADR, test, architecture guard 또는 제품 scope로 승격한다.
