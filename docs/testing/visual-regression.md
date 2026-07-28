# UI 시각 회귀 테스트

Playwright 시각 테스트는 실제 앱 데이터나 외부 서비스 없이 핵심 워크벤치 구조를 고정한다. 기준 환경은 `macos-15`의 Playwright Chromium, 1440×900 viewport, `ko-KR`, `Asia/Seoul`, 다크 모드, reduced motion이다. 좁은 창 계약은 900×680에서 별도로 검증한다.

## 포함 범위

- Connections와 빈 상태
- SQL 편집기, 결과 그리드, Terminal Dock
- Tables와 기본 숨김 가능한 detail panel
- Schema/ERD
- Dashboard
- Settings와 Workspace/Auth
- loading, error, empty 상태
- macOS 44px 안전 영역, 48px rail, 좌우 panel 경계, 28px compact control, 시각 깊이 최대 3

Fixture는 `tests/visual/fixture/`의 가상 이름과 통계만 사용한다. 실제 이메일, 연결 문자열, 토큰, 비밀번호, 계정 ID를 복사하지 않는다.

Tailwind로 이전한 화면은 fixture 전용 CSS를 복제하지 않고 production의 정적
style map 또는 실제 컴포넌트를 import한다. CSS를 utility로 바꿨다는 이유만으로
기준 이미지를 갱신하지 않는다. 기존 모습이 의도라면 계산된 line-height·spacing을
맞춰 동일한 screenshot을 통과시키고, 의도적인 디자인 변경일 때만 아래 갱신
절차를 따른다.

## 실행과 기준 이미지 갱신

```sh
pnpm exec playwright install chromium
pnpm test:visual
```

의도적인 UI 변경으로 기준 이미지가 달라졌을 때만 다음 명령을 실행한다.

```sh
pnpm test:visual:update
pnpm test:visual
```

갱신된 `tests/visual/__screenshots__/` 이미지를 직접 확인하고 변경한 화면만 커밋한다. 픽셀 허용치는 전체 이미지의 0.4%, 색상 threshold는 0.2다. 구조 assertion은 overflow, 안전 영역, control 높이, panel 경계와 깊이 회귀를 별도로 차단하므로 기준 이미지를 무작정 덮어써서 우회하지 않는다.

## CI artifact

macOS `build` job이 Chromium을 설치하고 시각 테스트를 실행한다. 실패 시 `test-results/`와 `playwright-report/`를 14일간 artifact로 보존한다. 기준 이미지는 macOS Chromium 전용이며 Windows job에서는 실행하지 않는다.
