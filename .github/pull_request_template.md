<!--
PR 제목·본문은 한국어로 쓴다(CONTRIBUTING.md 「Language Convention」).
제목 형식: type(scope): 설명 (#이슈번호)   예) fix(desktop): 스레드 패널이 닫히지 않는다 (#123)
-->

## 무엇을 · 왜

<!-- 바꾼 것과 그 이유. 관련 이슈가 있으면 `Closes #번호` 로 잇는다 -->

## 어떻게

<!-- 접근 방식. 고르지 않은 대안이 있었다면 왜 버렸는지 -->

## 검증

<!-- 실제로 돌린 것만 적는다. 화면이 바뀌면 스크린샷을 붙인다 -->

- [ ] 바꾼 패키지의 타입체크: `cd packages/<p> && npx tsc -p .`
- [ ] 바꾼 패키지의 테스트 전체: `pnpm --filter @harkroom/<p> test`
- [ ] 버그 수정이면 회귀 테스트가 **수정 전에 빨갛고** 수정 후 초록인 것을 확인했다
- [ ] 공용 타입(`packages/shared`)을 건드렸다면 모든 패키지 타입체크를 돌렸다

## 체크

- [ ] 새 화면 문구는 i18n 키로 넣고 `en.ts`·`ko.ts` 를 둘 다 채웠다
- [ ] 앱이 서버의 새 기능에 기대면 `MIN_SERVER_VERSION` 을 올렸다(`packages/shared/src/compat.ts`) — 해당 없으면 지운다
- [ ] 로그·스크린샷에 토큰·비밀번호가 없다
