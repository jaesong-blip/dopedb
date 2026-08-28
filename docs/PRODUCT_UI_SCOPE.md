# 제품 UI 및 기능 범위 정본

이 문서는 DopeDB 화면 구조, 상호작용 원칙, 기능 범위 결정을 소유한다. 기준은
DopeDB의 제품 축, 실제 사용자 작업, 접근성, 운영 안전성, 지원 플랫폼의 동작이다.
제3자 제품의 화면, 기능 목록, 명칭, 코드, 자산은 정본이나 구현 근거가 아니다.

## 판단 순서

화면 또는 기능을 추가하기 전에 다음 순서로 판단한다.

1. workspace가 공유 접근과 구성원별 자격 증명을 더 안전하게 소유하게 하는가?
2. 연결의 첫 성공 경로를 더 짧고 명확하게 만드는가?
3. exact grant 안에서 일하는 Agent를 사람이 관찰·승인·중단·복구하는 데 필요한가?
4. SQL이나 Agent에게 한 문장으로 맡기는 편이 더 빠르지 않은가?
5. 실제 command와 authoritative state owner가 있는가?

`구현 안 함`, `범위 밖`, `미결` 항목은 label, icon, disabled placeholder를 제품
화면에 추가하지 않는다. 결정을 뒤집을 때는 이 문서를 먼저 고치고 화면을 고친다.

## UI 계약

### 화면 구조

- 상단은 workspace와 현재 문맥, document tab, 실제 전역 command를 제공한다.
- 왼쪽 Explorer는 `Project → Databases / Data sources / Analyses`의 계층과 실제
  catalog를 소유한다. Environment는 exact grant와 binding을 소유하는 domain으로
  유지하되 Project 아래 시각적 folder로 반복하지 않는다. `Databases`는 Project의
  모든 환경 binding을 한 목록으로 투영하고 각 DB 행에만 exact Environment의
  dev/staging/prod marker를 표시한다. Data source와 Analysis Article 행은 같은
  Project folder에 모으되 선택 시 원래 Environment identity를 보존한다. 아직
  Environment에 묶이지 않은 연결은 `Unassigned`에만 표시하고, 그 행을 원하는
  Environment에 이미 묶인 DB 행으로 끌어 놓으면 기존 environment-connection
  binding command로 이동한다. 대상 환경에 DB가 없으면 Environment database
  binding 화면을 사용하며, 이미 묶인 연결을 암묵적으로 재배치하거나 복제하지
  않는다. 한 workspace의 DB 연결은 동시에 한 Project Environment에만 배정되며,
  다른 Project로 옮기려면 DB 행의 명시적인 `프로젝트에서 제거` command로 기존
  binding을 먼저 해제한다. 이 command는 공유 연결이나 구성원 자격 증명을 삭제하지
  않는다. Project 행의 삭제 command도 connection 자체는 보존해 `Unassigned`로
  돌려보내고 source sync·Agent grant를 폐기하며 해당 Environment에 고정된 실행 중
  Agent session도 중단한다. active Analysis Article이 있는
  Project는 Article을 명시적으로 삭제하기 전에는 삭제할 수 없으며, 삭제된 Article의
  version history와 공개 HTML snapshot은 보존한다. Analysis collection의 문자·상태
  필터와 Article 선택도 Explorer가 소유하며, 중앙 Analysis document는 선택한
  Article만 표시하고 별도의 collection
  rail을 만들지 않는다.
- 중앙 document surface는 welcome, query, data, schema, analysis처럼 현재 작업
  하나를 소유한다. MongoDB 연결은 BSON `find`/`aggregate`/`count`를 수행하는
  조회 surface를 유지하되 이를 범용 `문서` 작성 기능으로 표현하지 않는다.
  마지막 MongoDB 조회 tab을 닫아도 모호한 문서 생성 화면을 만들지 않고 새
  MongoDB 조회 surface를 즉시 유지하며, 조회 가능한 collection이 없으면
  `조회할 컬렉션이 없습니다`라는 정확한 빈 상태만 표시한다.
- Personal Workspace의 첫 Welcome은 실제 파일 기반 SQLite, 로컬 Project와
  development Environment, 그 연결의 versioned binding을 한 번에 준비하는
  `가이드 데모` command 하나를 제공할 수 있다. 이 명령은 재실행해도 같은 데모
  자원을 재사용하고 team membership, 공유 credential, 권한을 꾸며내지 않는다.
  준비된 Welcome은 sample table 탐색, exact Environment에 고정된 Agent 읽기,
  `Settings → Safety`를 거치는 Agent 쓰기 승인의 실제 command 세 개만 flat
  목록으로 보여준다.
- 오른쪽 Agent surface는 exact 내부 grant와 검증된 database subset에 고정된
  대화, 도구 진행, 승인과 복구를 소유한다. context control은 사용자에게
  `프로젝트 전체`와 `개별 DB` 두 종류만 제공하고 Project Environment를 계층이나
  이름으로 노출하지 않는다. `프로젝트 전체`는 그 Project의 source revision과
  단일 production 내부 경계에 연결된 검증된 PROD DB 전체를, `개별 DB`는
  Project·환경 표시와 관계없이 선택한 DB 하나와 같은 내부 경계의 source revision을
  세션 시작 시 immutable하게 고정한다. production 내부 경계가 없거나 둘 이상이라
  하나로 확정할 수 없는 Project에는 전체 선택을 추정해 만들지 않고 개별 DB 선택만
  유지한다. 닫힌 trigger와 열린 menu 모두 선택 종류와 대상 이름을 함께 표시하며,
  DEV/staging 전체나 임의의 다중 DB checkbox 조합은 제공하지 않는다.
- 하단 Services surface는 실행, result, output, job, background task를 관찰하고
  중단하는 곳이다.
- status surface는 현재 database/source/schema/object, transaction과 background
  상태를 보여주되 이미 document가 소유한 설명을 반복하지 않는다.

### 밀도와 상호작용

- 작업용 chrome은 낮고 조용하게 유지하며 정보는 실행 문맥 가까이에 둔다.
- command row와 tree row는 compact density를 사용하고, 선택·focus·위험·실패처럼
  의미가 있는 상태에만 색과 elevation을 사용한다.
- Action Search는 672px 이하의 non-modal surface다. 빈 질의는 scope와 input만
  보이고, Database·Documents·Actions·Settings처럼 실제 결과가 있는 범주만 둔다.
- popup, menu, modal은 viewport collision, keyboard 이동, focus containment와
  trigger 복구를 책임진다.
- data grid의 header/row/row number는 28px, 기본 column은 144px을 기준으로 한다.
  virtualization 여부와 무관하게 selection, resize, sort, filter 계약은 같다.
- 사용자가 편집기에서 작성한 SQL은 Run 동작 자체를 exact payload 승인으로 사용해
  중복 검토 화면이나 확인 문구 입력 없이 실행한다. Agent와 background 작업이
  제안한 mutation은 사람이 작성한 것으로 간주하지 않고 별도 한 번의 명시적
  승인·거절을 유지한다.
- Desktop의 연결별 쓰기 실행 제어는 `Settings → Safety` 한 곳이 소유한다.
  연결 편집기와 작업 화면은 쓰기 권한을 변경하지 않으며, 상태 표시와 Safety
  진입만 제공한다. 관리형 연결의 `manage` 권한 보유자는 같은 Safety control로
  workspace 쓰기 상한과 현재 기기 gate를 함께 변경한다. 그 밖의 구성원에게
  workspace가 부여한 권한은 상한이고 기기별 Safety 설정은 이를 좁힐 수만 있다.
  관리형 단기 쓰기 자격 증명의 상한은 행 단위 DML이며 DDL 권한은 포함하지 않는다.
  관리형 연결의 DDL은 승인 화면이나 DB까지 보내지 않고, DB owner/migration
  자격 증명 또는 기존 migration 도구가 필요한 별도 경계임을 결과 화면에서 밝힌다.
- enabled control은 반드시 실제 command와 state owner를 가진다. 아직 없는 기능은
  tracker에 `missing`으로 기록하고 가짜 control을 만들지 않는다.

### 구현 시스템

- Tailwind v4의 정적 `tw:` utility와 `src/design-system/index.css`의 semantic role이
  화면 구현의 정본이다.
- 반복되는 시각·상호작용 계약은 공용 primitive로 승격하고
  `src/design-system/README.md`에 문서화한다.
- screen-level CSS, utility 문자열 객체, raw color, 동적 utility 조합은 금지한다.
- screenshot은 DopeDB 내부 회귀와 접근성 검수 증거로만 쓴다. screenshot 하나로
  기능 완료나 packaged runtime 동작을 주장하지 않는다.

## 기능 범위 결정

상태의 의미는 다음과 같다.

- `구현`: 현재 제품에 속한다. 상세 계약은 소유 domain과 ADR을 따른다.
- `구현 안 함`: 제품 축 대비 효용이 낮거나 Agent/SQL 경로가 더 직접적이다.
- `범위 밖`: 일반 IDE, 파일 시스템 또는 별도 플랫폼의 책임이다.
- `미결`: 제품 결정이 남아 있으며 구현을 시작하지 않는다.

| ID | 기능 | 결정 | 제품 계약 |
| --- | --- | --- | --- |
| PD-01 | Version Control | `범위 밖` | 일반 project VCS는 DB 접근 workspace의 책임이 아니다. |
| PD-02 | 자유 dock/move/detach | `구현 안 함` | left/right/bottom 고정 anchor와 resize를 유지한다. |
| PD-03 | project Local History | `범위 밖` | SQL document revision만 제품이 소유한다. |
| PD-04 | manual transaction | `구현` | query, table edit, connection-pinned Agent가 같은 물리 세션과 commit/rollback 경계를 공유한다. |
| PD-05 | structured Agent conversation | `구현` | 공식 ACP adapter와 로컬 CLI 로그인을 사용하고 앱은 provider token이나 login UI를 소유하지 않는다. |
| PD-06 | persistent multi-result | `구현` | bounded local snapshot과 capability-bound result artifact handle을 보존한다. |
| PD-07 | SQLite In-memory | `구현 안 함` | 비영속 연결은 공유·승인·감사 모델과 맞지 않는다. |
| PD-08 | 범용 cloud resource browser | `구현 안 함` | 연결 onboarding 중 검증된 target selector만 허용한다. |
| PD-09 | multi-database introspection | `구현` | Explorer, query, data editor와 Agent가 같은 정확한 database scope를 사용한다. |
| PD-10 | background task model | `구현` | SQL, 승인, ACP turn, import/export Job을 관찰하고 실제 backend cancel로 중단한다. |
| PD-11 | Services session command bar | `구현 안 함` | tree toggle과 document/session 활성화만 유지한다. |
| PD-12 | result의 광범위한 IDE command set | `구현 안 함` | bounded inspect/copy/export를 유지하고 재조회는 SQL이나 Agent가 소유한다. |
| PD-13 | Local History compare/navigation | `구현 안 함` | SQL revision 선택·검색·복원만 제공한다. |
| PD-14 | inline AI editor assistance | `구현 안 함` | connection-pinned Agent와 명시적 SQL context attachment가 소유한다. |
| PD-15 | project/files tool window | `범위 밖` | 일반 filesystem 탐색은 제품 밖이다. |
| PD-16 | data source template lifecycle | `구현` | workspace가 redacted template과 grant를 공유하고 자격 증명은 member-local 또는 단기 managed lease로 분리한다. |
| PD-17 | DDL file data source/mapping | `범위 밖` | 파일을 data source로 취급하지 않는다. |
| PD-18 | 검증된 DBMS/driver/credential broker 확장 | `구현` | 실제 수요가 있고 discovery·발급·TTL·회수·drift·E2E 경계를 닫은 adapter만 추가한다. 일반 PostgreSQL/MySQL은 서버 allowlist의 HashiCorp Vault Database Secrets AppRole로 구성원별 15분 이하 동적 자격증명을 발급할 수 있으며, 공용 static DB 비밀번호 배포는 금지한다. BigQuery는 수정하지 않은 공식 `bq`/`gcloud` CLI와 구성원별 인증만 사용하고 server dry-run·SELECT 제한·과금 바이트 상한·exact job 취소를 갖춘 read-only managed official-CLI driver로 한정한다. 검증된 system SDK가 있으면 우선 재사용하고, 없으면 macOS arm64/x64 또는 Windows x64용 버전·크기·SHA-256 고정 공식 archive와 macOS Python installer 서명을 검증해 app-owned 경로에 원자적으로 준비한다. 연결 onboarding은 project/dataset ID 직접 입력, `gcloud auth login` 브라우저 인증, 서비스 계정 JSON 경로를 `gcloud auth login --cred-file`에 일회성으로 넘기는 세 경로를 제공하며, 인증 뒤 `gcloud` project/`bq` dataset 결과를 실제 selector로 표시한다. 앱은 Google OAuth client, token, refresh token, service-account key 내용이나 경로를 읽거나 저장하지 않는다. |
| PD-19 | 고급 connection/session option | `구현` | direct TLS와 시스템 OpenSSH Host alias 하나만 제공하며 키와 passphrase는 OS가 소유한다. |
| PD-20 | Explorer object authoring | `구현 안 함` | DDL은 Agent가 작성하고 사람은 승인한다. |
| PD-21 | Settings staged apply/scope | `구현 안 함` | 즉시 또는 section별 저장을 유지한다. |
| PD-22 | data source comment/color | `구현 안 함` | 공유 연결 구분은 environment badge가 소유한다. |
| PD-23 | authentication/save policy 선택 | `구현 안 함` | engine마다 검증된 최소 입력 경로 하나를 유지한다. |
| PD-24 | status breadcrumb 탐색 | `구현` | 현재 문맥을 표시하고 Explorer의 정확한 문맥을 reveal한다. |
| PD-25 | 전역 manual transaction 상태 | `구현` | 장기 transaction을 발견하고 해당 연결에서 commit/rollback하도록 한다. |
| PD-26 | data grid quick-filter/history | `구현 안 함` | 기존 column filter와 WHERE/ORDER BY, Agent 재조회 경로를 사용한다. |
| PD-27 | 범용 workspace settings bag | `구현 안 함` | 공유 상태는 connection과 Analysis Article 같은 실제 revision owner에 둔다. |
| PD-28 | safe branch checkpoint/restore | `구현` | 승인된 격리 생성, connection revision 전환, 복귀·폐기와 audit를 하나의 durable operation으로 묶는다. |
| PD-29 | engine별 native query cancellation | `구현 안 함` | exact operation signal, timeout, connection-close fallback과 unknown outcome 보존을 유지한다. |
| PD-30 | disk-backed query result | `구현` | Rust가 bounded page artifact와 streaming CSV/JSON export를 소유한다. |
| PD-31 | HTML Analysis Article | `구현` | sanitized HTML 본문과 exact connection에 고정된 읽기 전용 쿼리 하나만 저장하고 Desktop에서 수동 재조회한다. |
| PD-32 | enterprise shared-secret suite | `구현 안 함` | 중앙 static secret 배포·SSO·SCIM·self-hosted 묶음을 별도 수요 없이 예약하지 않는다. PD-18의 좁은 Vault Database Secrets 동적 발급 adapter는 이 suite에 포함되지 않는다. |
| PD-33 | general Plugin Platform | `구현 안 함` | app-owned driver, provider, ACP adapter의 닫힌 목록만 지원한다. |
| PD-34 | realtime SQL CRDT/presence | `구현 안 함` | 일반 SQL text와 cursor는 로컬에 두고 공유할 가치가 있는 결과만 HTML Analysis Article로 저장한다. |
| PD-35 | Arrow/Parquet plugin export | `구현 안 함` | bounded native CSV/JSON sink의 정확성과 취소 경계를 유지한다. |
| PD-36 | Project Knowledge graph | `구현` | source identity, immutable graph revision, evidence anchor, KnowledgeGrant와 승인된 mapping을 공유한다. |
| PD-37 | Project→Environment exact scope | `구현` | session 시작 시 connection과 graph revision 집합을 immutable pin으로 고정한다. |
| PD-38 | funnel analysis/block migration | `구현 안 함` | funnel·cohort·chart는 별도 UI domain으로 이관하지 않고 SQL 또는 Agent 결과를 일반 HTML로 설명한다. |
| PD-39 | metric signal monitoring | `구현 안 함` | Article은 수동 재조회 문서이며 cron·signal·background runner를 소유하지 않는다. |
| PD-40 | Analysis Article archive | `구현` | ADR 0007의 sanitized HTML, 단일 bounded read query, 로컬 수동 재조회, immutable public HTML 계약을 따른다. |

## 변경 규칙

기능 결정을 바꾸는 변경은 다음을 함께 갱신한다.

1. 이 문서의 해당 `PD-*` 행과 제품 이유
2. [`UI_IMPLEMENTATION_TRACKER.md`](./UI_IMPLEMENTATION_TRACKER.md)의 상태와 소유자
3. 실제 command/state owner와 관련 architecture guard
4. 보안·wire contract·핵심 여정이면 기존 critical test 본문의 assertion

과거 비교 자료나 외부 제품 기능 목록은 결정 근거로 저장하지 않는다. 필요한
근거는 재현 가능한 DopeDB scenario, 접근성 결과, 성능 수치, ADR과 코드 계약으로
남긴다.
