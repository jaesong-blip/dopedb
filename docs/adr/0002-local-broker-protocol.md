# ADR 0002: Local Broker protocol

- 상태: 승인
- 날짜: 2026-07-24
- 관련 계획: Phase 3

## 결정

`dopedb` CLI는 app SQLite, credential store, provider SDK, DB driver를 열지 않는다.
실행 중인 DopeDB Desktop Runtime과 사용자 로컬 IPC로만 통신한다.

- macOS/Linux: 사용자 전용 runtime directory의 Unix domain socket
- Windows: random runtime id를 포함하고 현재 사용자 SID만 허용하는 named pipe
- loopback HTTP/TCP: 사용하지 않음
- control message: 4-byte big-endian 길이 + UTF-8 JSON
- Terminal bytes, result stream, import/export bytes: control channel과 분리

공유 정본은 database/Tauri 의존성이 없는 `dopedb-protocol` crate다.

## Discovery

Desktop은 현재 사용자만 읽을 수 있는 `runtime.json`을 atomic replace로 기록한다.

```json
{
  "schemaVersion": 1,
  "runtimeId": "uuid",
  "pid": 1234,
  "appVersion": "<app-version>",
  "protocolMin": 1,
  "protocolMax": 1,
  "endpoint": "platform-specific endpoint",
  "startedAt": "RFC3339"
}
```

파일에는 reusable token, DB 정보, workspace 정보가 없다. PID와 runtime id가 stale이면
CLI는 파일을 신뢰하지 않고 `runtime_unavailable`로 종료한다.

## Envelope와 version

- `protocolVersion`: framing/envelope 의미
- `commandSchemaVersion`: command arguments/result 의미
- `requestId`: 응답 correlation용 UUID
- `authentication`: terminal session id와 선택적 ephemeral bearer capability
- `command`: v1의 closed command enum
- `arguments`: Phase 0 envelope에서는 구조 한도를 적용한 JSON value

지원 범위가 겹치면 가장 높은 protocol version을 선택한다. 겹치지 않으면
`protocol_mismatch`로 실패하고 app/CLI 버전 정보를 설명한다.

Broker를 활성화하기 전에는 지원하는 각 command의 arguments/result를
deny-unknown typed payload로 다시 decode해야 한다. Phase 0의 closed enum은 명령
이름과 envelope만 고정하며, 아직 연결되지 않은 command의 payload 완료를 의미하지
않는다.

## 한도

| 항목 | v1 한도 |
| --- | ---: |
| request frame | 1 MiB |
| response frame | 8 MiB |
| JSON depth | 32 |
| one collection's items | 10,000 |
| total JSON values (root 포함) | 10,000 |
| string | 256 KiB |

semantic query row/cell/byte cap은 이보다 더 작을 수 있다. 한도를 넘긴 요청은 읽기나
실행 전에 거절한다. secret은 stdout/stderr/Debug/log/error details에 넣지 않는다.
wire error message는 code별 고정된 안전 문구만 사용하고 raw DB/provider 오류는 내부
redacted telemetry에만 남긴다.

## 호환성

- field 제거, 이름 변경, 의미 변경은 protocol major 없이 하지 않는다.
- v1 envelope/DTO는 unknown field를 거절한다. optional field나 command를 추가할
  때도 `commandSchemaVersion`을 올리고 호환 범위를 명시한다.
- Phase 0은 envelope와 대표 query/status/error fixture를 고정한다.
- 실제 broker에서 command를 활성화하기 전 해당 command의
  request/success/error golden fixture를 모두 추가한다.
- CLI human renderer와 JSON serializer는 분리한다.

## ACP process-bound authentication

일반 Terminal 요청은 terminal session id와 ephemeral bearer를 함께 보낸다. ACP
Agent의 stdio MCP 설정에는 bearer나 다른 credential을 넣지 않는다. 공개
`dopedb` CLI도 ACP 실행 경로에 넣지 않는다. 대신 정확한 app-only Agent bridge의
launcher mode가 내부 `agent.session.register` 명령으로 자신의 OS PID와 process
start marker를 bearer 인증해 한 번 등록하고, bearer를 adapter child environment에서
제외한 뒤 고정된 공식 ACP adapter를 수정 없이 실행한다.

이후 같은 bridge의 typed MCP mode는 public CLI parser나 subprocess 없이
`BrokerClient`로 protocol `CommandSpec`을 직접 보내며 terminal session id만
인증 metadata로 사용한다. Broker는 owner-local IPC가
보고한 peer PID와 start marker가 살아 있는지 확인하고, 등록된 adapter root와
동일하거나 실제 descendant인 경우에만 session capability를 적용한다. 등록되지 않은
process, unrelated process, PID 재사용, 만료·취소·authority 변경 session은 같은
`authentication_denied` 경계에서 거부한다. process identity는 discovery나 SQLite에
저장하지 않고 해당 Desktop runtime의 메모리에만 둔다.

## Bounded Agent tools and cancellation

Agent의 catalog 검색은 `catalog.show` 응답을 bridge로 옮긴 뒤 필터링하지 않는다.
Desktop runtime이 canonical snapshot을 검색하고 최대 50개의 compact object
reference와 일치 field만 `catalog.search`로 반환한다. 따라서 relation/column 수가
많아도 검색 응답이 Broker frame 한도를 넘지 않는다.

stdio MCP는 database tool을 한 번에 하나만 실행하되 stdin reader를 분리해 실행
중에도 `notifications/cancelled`를 수신한다. 아직 대기 중인 tool은 queue에서
제거하고, 실행 중인 tool future는 중단한다. `query_read`가 이미 plan을 발급받은
경우에는 동일 operation id로 `query.cancel`을 Broker에 보내 실제 executor까지
취소를 전파한다. 취소된 JSON-RPC request에는 adapter가 response handler를 이미
폐기했으므로 별도 response를 쓰지 않는다.
