# User-facing release notes

DopeDB의 릴리스 노트는 커밋 제목을 나열하지 않고 사용자가 실제로 느끼는
변화를 설명한다. 변경을 구현할 때 작은 JSON fragment를 남기고, 안정 릴리스가
이전 공개 버전 이후 추가된 fragment를 결정론적으로 조립한다. 이 과정은 외부
AI API를 호출하지 않는다.

## 현재 상태

`config.json`의 `mode`는 현재 `prepared`다.

- 안정 릴리스 워크플로는 생성기를 실행하지만 기존의 일반 다운로드 안내문을
  그대로 사용한다.
- 실제 `fragments/` 파일은 요구하지 않으며 MVP 이전 변경을 적립하지 않는다.
- `examples/`와 생성기 검증만 유지해 준비 코드가 썩지 않게 한다.
- 정식 MVP가 확정되기 전에는 `mode`를 `active`로 바꾸지 않는다.

## MVP 이후 활성화

1. `config.json`의 `mode`를 `active`로 바꾼다.
2. 사용자에게 보이는 각 변경에 `fragments/<issue>.<slug>.json`을 하나 추가한다.
3. `pnpm check:release-notes`와 `pnpm release:notes:preview`로 결과를 확인한다.
4. 활성화 이후 fragment는 append-only로 취급한다. 이미 릴리스된 fragment를
   수정, 삭제, 이름 변경하지 않는다.

활성 모드에서 릴리스 생성기는 이전 GitHub latest 안정 태그부터 새 태그까지
추가된 fragment만 읽는다. 기존 fragment 변경이나 fragment 없는 릴리스는
안전하게 실패한다.

## 작성 규칙

- `title`은 코드가 아니라 사용자가 얻는 결과를 설명한다.
- `summary`는 무엇이 어떻게 달라졌는지 한 문장으로 쓴다.
- `details`는 꼭 필요한 동작 차이만 최대 네 문장으로 제한한다.
- 커밋 해시와 이슈 번호는 설명의 근거이지 설명 자체가 아니다.
- 측정하지 않은 성능 향상이나 검증하지 않은 호환성을 주장하지 않는다.
- 내부 빌드·테스트·문서 정리는 꼭 기록할 필요가 없다. 필요하면
  `audience: internal`로 두며 `highlight`는 사용할 수 없다.

형식은 `fragment.schema.json`, 실제 문장 예시는 `examples/`를 따른다.

## 명령

```bash
pnpm check:release-notes
pnpm release:notes:preview
```

첫 명령은 설정, schema, 예제와 현재 fragment를 검증한다. 두 번째 명령은
예제를 실제 GitHub 릴리스 본문 형태로 출력할 뿐 파일이나 릴리스를 변경하지
않는다.
