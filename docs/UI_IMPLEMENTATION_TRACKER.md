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
| Welcome document | `complete` | `screens/Onboarding`, `features/onboarding` | Personal 가이드 데모의 idempotent DB·Project·Environment·binding 준비와 연결 전/후 실제 command 집합을 packaged smoke에서 확인 |
| Database Explorer | `complete` | `screens/Connections/DatabaseExplorer`, `features/catalogExplorer` | Project 바로 아래의 단일 Databases/Data sources/Analyses 계층, workspace당 connection 하나의 active Project binding, DB 행의 exact-binding 제거, connection 보존·source/grant 폐기·pinned Agent session 중단·active Article 차단을 지키는 Project 삭제, DB 행에만 보이는 Environment marker와 같은 schema group의 Diff 진입점을 유지하고, Unassigned→환경 DB 행 binding drag·loaded-only 객체 검색·대형 catalog selection/scroll을 packaged smoke에서 확인 |
| Connection editor | `complete` | `features/connections/useConnectionEditorController` | 연결 identity·접속 옵션만 소유하고 쓰기 실행 제어는 Settings → Safety 단일 경계를 유지 |
| Provider account access | `complete` | `workspace-cloud/features/providerAccess`, provider application modules | 실제 계정 OAuth/CLI 실패·recovery와 allowlisted Vault AppRole의 role/lease/revoke packaged 검수를 유지 |
| SQL/MongoDB query workflow | `complete` | `features/queries`, `features/documentQueries`, `screens/Sql`, `screens/Documents`, Rust query application | 수동 Run exact 승인, Agent 제안 분리, MongoDB의 지속되는 조회 surface와 collection 없는 정확한 빈 상태, 10 KiB/100 KiB/1 MiB 입력과 cancel/transaction packaged 검수를 유지 |
| Result/Data grid | `complete` | `features/queryResults`, Rust result artifact | 30열·50,000행 selection/filter/export와 메모리 경계 검수 |
| Services/Jobs | `complete` | `features/queryServices`, `features/jobs` | background cancel과 복원된 result handle, 쓰기 권한 차단 시 exact DB의 필요한 권한 계층·`Settings → Safety` 복구 진입을 packaged 검수 |
| Agent tool window | `complete` | `features/agents`, ACP Rust runtime | `프로젝트 전체`(source + PROD DB 전체)와 `개별 DB` 두 context만 구분하고 trigger에 현재 종류·대상 이름을 계속 표시하며 Project Environment 이름은 노출하지 않는다. 공식 adapter 설치·로그아웃·permission·resume, 첫 prompt 단일 제출과 동일 권한 focus-refresh 연속성, 실제 권한·process 중단 사유와 복구의 OS별 검수를 유지 |
| Knowledge graph | `complete` | Rust `features/knowledge`, frontend Knowledge projection | packaged GitHub 설치·기존 설치 업데이트 복귀, Local source revision, publish, mapping과 exact grant 검수 |
| Analysis Article | `partial` | `features/analysisArticles`, cloud analysis application | Explorer 소유 문자·상태 필터와 단일 중앙 HTML document, exact 단일 query의 로컬 수동 재조회, immutable public HTML 발행과 raw run timestamp의 RFC3339 응답을 실제 환경에서 검수 |
| Settings | `complete` | `features/settings`, `features/safetySettings` | Desktop `Settings → Safety`의 단일 쓰기 제어, 관리자용 workspace 상한 + 기기 gate의 fail-closed 저장, 미적용 변경 표시를 유지한다. 웹 DB 접근 화면은 같은 상한을 상태로만 표시하며 변경 control을 중복하지 않는다. compact viewport 검수 |
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

1. 실제 데이터 소스는 Welcome에서 새 연결을 열고 engine과 검증된 최소 필드만
   입력한다. 제품을 먼저 체험하려면 Personal Workspace에서 가이드 데모를 한 번
   실행한다.
2. 가이드 데모는 파일 기반 Demo SQLite를 검증하고 `DopeDB Demo → Sandbox`의
   로컬 Environment와 exact binding을 준비한다. 다시 실행해도 기존 자원을
   재사용한다.
3. Test가 실패하면 입력 가까이에서 원인과 recovery를 본다.
4. Apply/OK 또는 데모 준비 후 Explorer, table, query, Agent가 같은 connection
   identity와 Environment binding을 사용한다.

Acceptance: 임의 고급 옵션, 계획 중 provider, 저장되지 않는 가짜 control이 없어야
하며 장기 secret은 shared record에 들어가지 않는다. 데모도 team membership,
credential, 공유 권한을 꾸며내지 않고 실제 local command만 사용한다.

### 2. 공유 연결 사용

1. workspace의 redacted connection revision을 선택한다.
2. 구성원은 member-local secret을 바인딩하거나 허용된 provider/Vault broker의
   구성원별 managed lease를 받는다. Vault AppRole과 공용 DB 비밀번호는 Desktop으로
   전달되지 않는다.
3. Explorer, query, Agent가 같은 workspace/account/connection revision을 사용한다.
4. revoke나 revision 변경 뒤 stale cache와 실행 권한이 재사용되지 않는다.

Acceptance: account integration 조회 실패가 shared connection inventory 전체를
무너뜨리지 않고, 권한과 credential lifetime이 화면 상태와 일치해야 한다.

### 3. Query와 결과 관찰

1. SQL document에서 Run 또는 안전한 statement preview를 실행한다.
2. parameter와 manual transaction 상태를 확인한다. 사용자가 작성한 SQL은 Run이
   exact 승인이고, Agent가 제안한 mutation만 별도 승인·거절한다.
3. streaming result를 grid에서 선택·복사·filter하고 Services에서 작업을 관찰한다.
4. 큰 결과는 native artifact와 streaming export를 사용하고 renderer가 전체 row를
   보관하지 않는다.

Acceptance: cancel 후 connection을 검증 없이 재사용하지 않고 write outcome이
불명확하면 `outcome_unknown`을 보존한다.

### 4. Agent 작업

1. `프로젝트 전체`(Project source + 검증된 PROD DB 전체) 또는 `개별 DB`(Project·환경 표시와 무관한 DB 하나)를 선택하면, 선택 종류와 대상 이름을 trigger에 계속 표시하고 공식 ACP adapter를 선행 준비한 뒤 첫 prompt를 같은 제출 흐름에서 전송한다. 내부 Project Environment identity와 DEV/staging 전체 범위는 UI에 노출하지 않는다.
2. Desktop이 exact grant와 connection/graph revision을 immutable pin으로 고정한다.
3. 화면은 tool 진행, permission, result, 중단과 복구를 보여준다.
4. provider 인증은 로컬 CLI가 소유하며 앱은 token을 읽거나 login UI를 만들지 않는다.

Acceptance: general MCP server, arbitrary provider API, 승인 우회 mode와 stale session
focus가 없어야 한다.

### 5. Knowledge와 Analysis Article

1. GitHub repository 또는 Local Folder를 Project Environment에 연결한다.
2. deterministic extraction이 immutable graph revision과 evidence anchor를 만든다.
3. Agent는 exact connection grant에서 sanitized HTML Article draft와 단일 bounded
   read query를 제안한다.
4. 사람은 Desktop에서 query를 수동 재조회하고 immutable public HTML을 발행한다.

Acceptance: public article은 query, result row, credential 없이 immutable sanitized
HTML snapshot만 읽고 재조회 command는 인증된 Desktop에만 존재한다.

## 트래커 갱신 규칙

- 화면을 바꾸면 해당 행의 상태, owner, 남은 gap을 같은 변경에서 갱신한다.
- `complete`는 build 통과만 뜻하지 않는다. 실제 command/state owner와 변경 위험에
  비례한 runtime 검수가 모두 필요하다.
- `missing`은 구현된 것처럼 보이는 disabled control로 대체하지 않는다.
- 시점별 긴 작업 일지, 외부 비교 screenshot, 임시 hash는 이 문서에 누적하지 않는다.
  재현 가능한 영구 계약은 ADR, test, architecture guard 또는 제품 scope로 승격한다.
