-- 의무가 무엇으로 닫히는가(U1). 위임 의무(`team_delegation`)에 닫는 조건 칸 하나를 더한다.
--
-- - `report`(기본): 담당의 `message.report`·`message.fail`·기한·중단으로 닫힌다 — 지금의 `message.delegate` 그대로다.
-- - `reply`: 담당이 그 스레드에 쓴 첫 답글로 닫힌다(묻기). `agent.call` 의 `expect: "reply"` 가 적는다.
--
-- 「어떻게 생겼나」(`kind`: delegate·mention)와 「무엇으로 닫히나」는 다른 축이라 칸을 가른다.
-- 지금 있는 행은 모두 `report` 다 — 이 마이그레이션 뒤에도 옛 위임의 동작은 같다.
-- 쓰기 역할 GRANT: 더할 것 없음(행을 만들 때만 적는다 — `team_delegation` INSERT 는 이미 있다).
alter table team_delegation add column if not exists close_on text not null default 'report'
  check (close_on in ('report', 'reply'));
