# AI와 사람이 함께 탐색하기 쉬운 코드 구조

이 문서는 파일 줄 수가 아니라 **응집도, 책임 경계, 탐색 왕복 비용**으로 코드
구조를 판단하는 저장소 기준이다. 목표는 파일을 작게 만드는 것이 아니라 한 번의
검색으로 개념의 진입점, 상태 소유자, 효과 경계, 검증 계약을 재구성할 수 있게 하는
것이다.

## 기본 결정

- 300줄은 실패 기준이 아니라 응집도 검토가 시작되는 지점이다.
- 수작업 제품 코드가 800줄을 넘으면 분리 또는 유지 근거를 적극적으로 검토한다.
- 생성 코드, 선언적 schema/catalog, migration, fixture, 긴 계약 테스트는 서로 다른
  임계값으로 관찰한다.
- 줄 수를 맞추기 위한 `helpers`, `utils`, `part1`, `part2` 파일은 만들지 않는다.
- 기존 파일을 나눴다는 이유만으로 완료로 보지 않는다. 분리 후 공개 진입점과 상태
  writer가 더 명확하고, 한 작업을 이해하기 위한 파일 왕복이 줄어야 한다.
- 반대로 여러 작은 파일이 하나의 변경 이유와 한 소비자만 가지며 서로 계속
  import한다면 같은 책임 경계로 다시 합칠 수 있다.

## 분리 판단

다음 중 하나 이상이 명확할 때 책임 이름으로 분리한다.

1. 독립적으로 변경되는 이유가 둘 이상이다.
2. presentation, state/application, transport, persistence, policy가 한 파일에서
   각각 독립된 흐름을 가진다.
3. 변경 가능한 상태의 writer 또는 비동기 lifecycle이 둘 이상이다.
4. 독립적으로 이름 붙이고 입력·출력 계약을 검증할 수 있는 단위가 있다.
5. 파일의 주 산출물을 찾기 전에 긴 구현 세부나 정적 catalogue를 지나야 한다.

권장 형태는 기능별 composition root와 명시적인 하위 책임이다.

```text
feature/
  FeaturePanel.tsx          # 조합과 공개 진입점
  useFeatureController.ts   # 상태와 command lifecycle
  FeatureForm.tsx           # presentation leaf
  domain.ts                 # 순수 계약과 정책
  tauriAdapter.ts           # IPC 경계
```

모든 기능이 위 파일을 전부 가져야 하는 것은 아니다. 한 책임이 짧고 독립성이 없다면
진입점 안에 그대로 둔다.

## 재결합 판단

다음 조건이 함께 나타나면 과도하게 흩어진 구조인지 검토한다.

- 작은 sibling 파일 여러 개가 거의 같은 파일에서만 소비된다.
- 파일 사이 내부 import가 많고 외부 소비자는 하나 또는 둘뿐이다.
- 각 파일이 독립된 public contract, state owner, adapter boundary를 갖지 않는다.
- 변경 하나가 항상 같은 파일 묶음을 함께 수정하게 만든다.
- 파일 이름이 책임보다 구현 순서나 포괄적 보조 역할을 나타낸다.

`domain`, `ports`, `types`, `errors`, `contracts`처럼 의존 방향이나 공개 계약을
고정하는 작은 파일은 단순히 짧다는 이유로 합치지 않는다. 재결합 후에도 dependency
cycle이 없어야 하고, 더 넓은 범용 `utils`가 생겨서는 안 된다.

## 실행 하네스

전체 스캔은 다음 명령으로 실행한다.

```bash
pnpm audit:code-structure
pnpm audit:code-structure -- --all
pnpm check:code-structure
```

`audit`은 저장소의 TS, TSX, JS, Rust, Python, shell, CSS를 전수 스캔하고 다음을
분리해 보고한다.

- category별 줄 수 임계값
- top-level declaration과 import fan-out
- presentation/state/transport/persistence/policy/process 책임 신호
- 강하게 결합된 작은 sibling module 군집

결과는 **검토 후보**다. scanner 점수만으로 파일을 이동하지 않는다.
`check`는
[`docs/architecture/code-structure-baseline.json`](architecture/code-structure-baseline.json)의
현재 high-confidence hotspot과 fragment cluster를 ratchet으로 사용한다. 새 hotspot,
기존 위험 증가, 이미 개선된 항목을 계속 baseline에 남기는 일을 실패시킨다.

baseline은 다음 경우에만 갱신한다.

1. audit 결과와 실제 책임 경계를 사람이 함께 검토했다.
2. 새 hotspot을 허용하기 위해서가 아니라 기존 hotspot이 줄거나 정당한 분류가
   교정되었다.
3. 변경 전후 `pnpm check:code-structure`와 해당 build/test가 통과한다.

`--print-baseline`은 검토용 후보를 stdout에 출력한다. 결과를 자동으로 덮어쓰지
않는 이유는 구조 회귀를 수치 갱신으로 숨기지 않기 위해서다.

## 변경 검증

구조 변경은 동작 변경과 같은 수준으로 검증한다.

- TypeScript/TSX: `pnpm lint:hooks`, `pnpm build`, 관련 smoke test
- Rust: `cargo fmt --all -- --check`, 관련 package test 또는 `pnpm test:rust`
- UI projection: 기존 화면의 command, 접근성 이름, focus, responsive 상태 수동 확인
- 모든 코드 변경: `pnpm check:code-structure`, `graphify update .`

파일 수 감소나 평균 줄 수 감소는 완료 증거가 아니다. 공개 API, dependency 방향,
single-writer 상태, 테스트 결과가 유지되고 탐색 경로가 짧아졌을 때 완료다.
