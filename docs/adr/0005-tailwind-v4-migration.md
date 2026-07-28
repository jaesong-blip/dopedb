# ADR 0005: Tailwind CSS v4 점진 이전

- 상태: Accepted
- 결정일: 2026-07-28

## 배경

DopeDB 데스크톱에는 화면별 CSS가 누적되어 같은 간격과 control이 서로 다른
selector로 다시 구현되고 있었다. 새 UI를 추가할 때 기존 grid, visual depth,
semantic color 계약이 깨지는 회귀도 반복됐다. 워크스페이스 웹과 소개 사이트는
각자 별도 global CSS를 사용해 동일한 구현 규율을 자동으로 공유하지 못했다.

한 번에 모든 CSS를 교체하면 Tauri shell, xterm, data grid와 두 Next 앱의 reset이
동시에 바뀐다. 그 방식은 시각 회귀의 원인을 분리하기 어렵고 Preflight selector가
기존 의미 클래스와 충돌할 수 있다.

## 결정

세 실행면에 Tailwind CSS 4.3.3을 즉시 도입하되 기능 단위로 이전한다.

1. 데스크톱은 공식 Vite plugin, Next 앱은 공식 PostCSS plugin을 사용한다.
2. utility에는 `tw:` 접두어와 important scope를 적용한다.
3. Preflight는 기존 reset migration이 끝날 때까지 import하지 않는다.
4. Tailwind theme는 각 앱의 semantic token을 `@theme inline`으로만 노출한다.
5. 새 화면 배치는 Tailwind utility가 기본이며, 기존 화면은 CSS 파일 하나 또는
   완결된 기능 단위로 옮긴다.
6. migration이 끝난 화면의 전용 CSS와 import는 같은 변경에서 삭제한다.
7. `.btn`, `.badge`, `.ds-*` 상호작용 primitive와 복잡한 grid/vendor 경계는
   정본 CSS가 소유한다.

첫 migration slice는 Agent Tools와 Skill Setup이다. 런타임과 visual fixture가
같은 정적 style map을 사용해 테스트 전용 복제 CSS도 제거한다. 워크스페이스와
소개 사이트의 root layout도 theme utility를 실제로 사용해 설치만 된 상태가
되지 않게 한다.

## 회귀 방지

`pnpm check:ui`는 다음을 자동으로 검사한다.

- visual boundary 깊이 최대 3
- `data-primary-flow` 안의 primary action 최대 1
- production TypeScript의 raw color literal
- control size와 grid track 계약
- legacy color alias가 기준선보다 증가하지 않는지

legacy token ratchet은 기존 부채의 증가를 막는 장치다. 수가 줄어들면 같은
변경에서 기준선을 낮춰야 하므로 개선분이 다시 돌아오지 않는다. 실제 화면은
Playwright visual regression으로 별도 검증한다.

## 완료 조건

Tailwind 도입 자체는 이 결정으로 완료된다. 전체 migration은 다음 조건이 모두
충족될 때 끝난다.

- 화면 전용 legacy CSS와 관련 import가 0개다.
- legacy token ratchet이 비어 있다.
- 세 앱에서 Preflight 활성화 여부를 별도 시각 회귀 변경으로 결정했다.
- 유지되는 CSS는 design-system primitive, shell, data grid, vendor integration
  경계로 분류되어 문서화됐다.

완료 전까지 기존 CSS와 Tailwind를 섞을 수 있지만 한 컴포넌트의 같은 책임을 두
경로에 중복 구현해서는 안 된다.

남은 기능별 migration은 [GitHub Issue #104](https://github.com/json-choi/dopedb/issues/104)에서
추적한다.
