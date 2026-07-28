# 커밋 메시지

한국어 Conventional Commits 형식을 사용한다.

```text
<type>(<scope>): <한국어 설명>

- 변경 사항
- 변경 사항

Refs: #123
```

`type`은 `feat`, `fix`, `test`, `refactor`, `build`, `ci`, `docs`, `chore`
중에서 고른다. 제목은 현재 변경을 50자 안팎의 동사형 한국어로 설명한다.
본문은 필요할 때만 2~8개의 간결한 bullet로 쓴다.

관련 Issue가 있으면 마지막에 `Refs: #번호` 또는 `Closes: #번호`를 추가한다.
Issue가 없으면 footer를 생략할 수 있다.

커밋 메시지에는 confidence, risk 점수, 분석 과정, AI 생성 설명, 장문의 검증
보고서를 넣지 않는다.
