# 기능 중심 리팩터링 최종 감사

Issue #70의 종료 기준을 2026-07-27 `main` 작업 트리에서 다시 검사했다.

## 결과

- Production source 706개가 architecture contract 대상이다.
- 900줄 초과 production source와 500줄 초과 production feature module은 0개다.
- `scripts/architecture-ratchet.json`의 대형 파일 예외는 0개다.
- frontend 10개와 Rust runtime 16개, 총 26개 mutable state의 단일 writer가 등록돼 있다.
- 삭제된 service, central command, facade, dispatcher, rollout flag 경로는 architecture deletion gate가 재등장을 차단한다.
- 항상 켜져 있던 `FeatureFlags`와 CLI, Skill, Terminal, Catalog, schema editor, ERD, staged row, Job의 조건부 실행 분기를 삭제했다.
- 활성 runtime compatibility exception은 0개다.

## 보존 자산

`compatibility-assets.json`의 항목은 과거 구현을 선택하는 fallback이 아니다. immutable migration, versioned decoder, read-only archive 또는 사용자가 명시적으로 실행하는 cleanup 도구만 허용한다. 각 항목은 경로, 보존 이유와 제거 조건을 가진다.

## 지속 게이트

`pnpm check:architecture`는 다음을 실패 처리한다.

- 대형 파일 예외가 다시 추가되거나 source/feature 한도를 넘는 경우
- 삭제된 경로·심볼·rollout flag가 돌아오는 경우
- active runtime exception 목록이 비어 있지 않은 경우
- 보존 자산의 경로·이유·제거 조건이 사라지는 경우
- mutable state writer가 둘 이상이거나 등록된 owner 밖으로 이동하는 경우

최종 검증은 frontend, workspace cloud, contract generation, visual regression, Rust format/clippy/test와 macOS·Windows CI를 함께 사용한다.
