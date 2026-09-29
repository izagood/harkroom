-- 멘션 연쇄 상한(043)을 **앱에서** 정할 수 있게 한다.
--
-- 지금까지 상한은 `MENTION_CHAIN_LIMIT = 4` 상수였다. 사람이 #task 의 작업 관리 에이전트
-- 한 곳에만 말하고, 그 에이전트가 담당을 부르고 회수하는 흐름에서는 작업 스레드에 사람의
-- 글이 없다 — 깊이가 0 으로 돌아갈 기회가 없어 두 번 왕복하면 반드시 막혔다(2026-09-29,
-- #harkroom seq 3336). 워크스페이스마다 맞는 값이 다르므로 admin 이 설정 화면에서 고친다.
--
-- 행이 하나뿐인 테이블이다(017_agent_defaults.sql·041_projection_config.sql 과 같은 관용구).
create table mention_policy (
  id boolean primary key default true check (id),
  -- 1 미만이면 에이전트가 아무도 못 부르고, 너무 크면 상한이 폭주를 못 막는다.
  -- 범위는 shared 의 MENTION_CHAIN_LIMIT_MIN/MAX 와 같다.
  chain_limit int not null default 8 check (chain_limit between 1 and 50)
);

-- 읽는 쪽이 "행이 없다" 를 따로 다루지 않도록 처음부터 한 행을 둔다.
insert into mention_policy (id) values (true);
