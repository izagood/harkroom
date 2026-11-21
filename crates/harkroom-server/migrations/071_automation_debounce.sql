-- 자동화 디바운스 병합 — N초 안에 몰린 이벤트를 **글 하나**로 모은다.
--
-- 왜: 머지 다섯 건이 10분 안에 들어오면 같은 에이전트에게 턴 다섯 개가 뜬다. 대개 원하는 것은
-- "그동안 들어온 것 전부를 한 번에 봐라"다. 켜면 첫 이벤트가 회차를 열고(`not_before` =
-- 지금 + N초) 그 사이 이벤트는 새 회차가 아니라 **그 회차의 목록에 붙는다**. 시각이 되면
-- sweeper 가 `{{events}}` 에 목록을 채워 한 번 보낸다.
--
-- null/0 이면 끈 것이다(이벤트마다 한 회차). schedule 트리거에는 뜻이 없다.
alter table automation add column debounce_sec int null
  check (debounce_sec is null or (debounce_sec >= 0 and debounce_sec <= 3600));
alter table automation_run add column not_before timestamptz null;
