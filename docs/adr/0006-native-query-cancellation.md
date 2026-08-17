# ADR 0006: 엔진별 native query cancellation 보류

- 상태: Accepted
- 결정일: 2026-08-05
- 관련 이슈: GitHub #110

## 배경

DopeDB의 Stop은 renderer가 DB process ID를 보내는 명령이 아니다. Operation
Runtime이 발급한 UUID에 process-local cancellation slot을 등록하고, 같은
operation을 소유한 화면이나 runtime만 그 signal을 보낼 수 있다. 실행 future가
취소되거나 300초 제한을 넘으면 SQLx가 checkout한 connection을 release 전에
검사하며, 일관성을 확인하지 못한 connection은 pool로 돌려보내지 않는다.

서버별 native cancel은 더 빨리 실행을 멈추거나 connection을 재사용할 수 있지만,
중단 요청이 도착했다는 것과 query가 실제로 중단됐다는 것은 다르다. raw backend
key, processlist ID와 MongoDB op ID는 credential에 가까운 target capability이므로
renderer, Agent, CLI, audit payload에 노출할 수도 없다.

현재 driver 기준은 SQLx 0.9.0과 MongoDB Rust driver 3.8이다.

## 결정

네 engine 모두 native cancellation을 이번 계약에 채택하지 않는다. 공통 Stop UI,
immutable operation identity, 300초 timeout과 connection retirement fallback을
유지한다. native 경로를 사용할 수 있는 것처럼 보이는 engine별 control이나 상태는
추가하지 않는다.

| Engine | 결정 | 근거 |
| --- | --- | --- |
| PostgreSQL | fallback 유지 | PostgreSQL 18 protocol 3.2는 cancellation secret을 4바이트에서 가변 길이로 바꿨다. SQLx 0.9.0은 protocol 3.0의 process ID와 4바이트 secret을 private field로만 보관하고 공개 cancel token/API를 제공하지 않는다. 사설 field를 읽거나 TLS·SSH·Cloud SQL connector·pooler를 우회해 CancelRequest를 직접 만들면 driver와 exact backend ownership을 증명할 수 없다. PostgreSQL도 CancelRequest에 직접 응답하지 않아 성공 acknowledgement를 제공하지 않는다. |
| MySQL/MariaDB | fallback 유지 | 같은 DB account는 broad `CONNECTION_ADMIN` 없이 자기 thread에 `KILL QUERY`를 보낼 수 있다. 그러나 별도 control connection, exact `CONNECTION_ID()`, query 종료 전까지 target connection을 재사용하지 않는 fence가 필요하다. `KILL`은 flag 설정 뒤 실제 중단을 기다리지 않고 반환하며 non-transactional write는 부분 변경을 남길 수 있다. SQLx가 public cancel identity를 제공하지 않는 상태에서 이 경로를 공통 성공 receipt로 만들지 않는다. |
| SQLite | fallback 유지 | `sqlite3_interrupt()`와 SQLx progress handler는 별도 권한 없이 중단할 수 있다. 하지만 interrupt 대상은 exact native handle이고, 실행이 끝나기 직전이면 효과가 없으며 현재 statement가 모두 끝날 때까지 같은 connection에서 시작한 새 statement도 영향을 받을 수 있다. ordinary pool, streaming, write와 manual transaction 전체에서 handle 설치·제거·close를 하나의 driver-owned lifetime으로 증명하기 전에는 app hook을 주입하지 않는다. |
| MongoDB | fallback 유지 | `mongod`에서는 사용자가 자기 operation을 추가 kill privilege 없이 중단할 수 있지만 exact op ID를 `currentOp` 결과와 안전하게 결합해야 한다. `mongos`의 `killOp`는 sharded write에 shard propagation을 보장하지 않는다. 다른 operation이나 internal operation을 건드릴 수 있는 admin command를 공통 Stop의 성공 경로로 광고하지 않는다. |

이 결정은 native cancellation이 영구히 불가능하다는 뜻이 아니다. driver가
connection-bound cancel handle과 결과 의미를 공개하고 아래 재개 조건을 만족할 때
한 engine씩 PD-29를 먼저 변경한다.

## 권한과 비밀 경계

- managed/member-local, read/write 어느 연결도 cancellation 때문에 권한을 늘리지
  않는다.
- 별도 admin credential, `PROCESS`, `CONNECTION_ADMIN`, MongoDB `killop` 권한을
  요구하지 않는다.
- PostgreSQL backend key, MySQL processlist ID, SQLite raw handle, MongoDB op ID를
  renderer, Agent, CLI, log, audit와 durable operation payload에 넣지 않는다.
- cancellation signal의 `true` 응답은 local registry에 exact operation이 있었다는
  뜻일 뿐, 서버가 query를 중단했다는 acknowledgement가 아니다.

## Race와 terminal receipt

| 시점 | target 처리 | DopeDB terminal 의미 |
| --- | --- | --- |
| 실행 claim 전 | 저장된 cancel signal을 확인하고 DB acquire를 시작하지 않음 | `cancelled` |
| connect/acquire 중 | future를 중단하고 중간에 획득한 connection을 재사용하지 않음 | target statement가 시작되지 않았음을 증명하면 `cancelled` |
| read 실행 중 | future와 cursor를 중단하고 결과를 버리며 connection release 검증 실패 시 hard-close | 결과를 전달하지 않았으면 `cancelled`; server 종료 acknowledgement를 주장하지 않음 |
| transactional write 실행 중, commit 전 | transaction future를 중단하고 connection retirement로 rollback을 유도 | rollback acknowledgement가 없으면 `outcome_unknown`; 단순 cancel signal만으로 `cancelled`라 하지 않음 |
| commit 요청 전송 후 ack 전 | connection을 폐기해도 commit 여부를 알 수 없음 | 항상 `outcome_unknown` |
| commit ack 후 | 이미 성공한 operation에 늦은 cancel은 terminal state를 바꾸지 않음 | `succeeded` |

Manual transaction은 취소 뒤 rollback-only 상태가 되며 commit을 허용하지 않는다.
rollback 또는 connection close가 끝나기 전에는 그 physical session을 다른 query에
재사용하지 않는다.

## Negative test 계획

native 경로를 나중에 채택하는 engine은 기존 critical test 예산 안에서 다음을
검증해야 한다.

- 등록되지 않은 UUID와 이미 terminal인 operation의 cancel은 target I/O를 만들지
  않는다.
- 다른 workspace, account, renderer capability 또는 operation UUID로 현재 query를
  중단할 수 없다.
- cancel-before-start, connect, read, write, commit-ack race에서 위 상태표보다 강한
  성공·취소 결과를 기록하지 않는다.
- native identity가 바뀌거나 재사용된 뒤에는 요청을 보내지 않는다.
- proxy, managed lease, SSH tunnel과 direct TLS에서 exact target을 독립 검증한다.
- native 요청이 거절·유실·무응답이어도 300초 timeout과 connection retirement가
  계속 작동한다.

## 재개 조건

한 engine의 driver가 다음을 모두 제공할 때 별도 구현 결정을 연다.

1. public, versioned, connection-bound cancel handle
2. renderer와 durable payload에 raw identity를 노출하지 않는 호출 경계
3. proxy와 managed connector를 포함한 exact backend 검증
4. 요청 수락과 query 종료를 구분하는 driver 결과
5. timeout·close fallback을 유지한 macOS·Windows race E2E

## 공식 근거

- PostgreSQL protocol flow와 CancelRequest:
  https://www.postgresql.org/docs/current/protocol-flow.html
- PostgreSQL 18 protocol 3.2와 variable cancellation key:
  https://www.postgresql.org/docs/current/protocol-overview.html
- MySQL KILL 권한과 비동기 kill flag:
  https://dev.mysql.com/doc/refman/9.7/en/kill.html
- SQLite interrupt 수명과 rollback 의미:
  https://www.sqlite.org/c3ref/interrupt.html
- MongoDB killOp 권한과 sharded write 제약:
  https://www.mongodb.com/docs/manual/reference/command/killop/
