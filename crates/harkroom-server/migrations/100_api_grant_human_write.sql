-- 외부 API 권한(C안 P4, 설계 스레드 07519d86) — grant 마다 「쓰기는 사람 글 턴만」.
--
-- 켜면 쓰기 메서드(POST·PUT·PATCH·DELETE)는 그 턴을 띄운 메시지가 사람 글일 때만 통과한다(머지의 allow_agent_cause 와 반대
-- 방향의 같은 칸). 읽기(GET)는 그대로다 — 에이전트끼리 일을 넘기는 것이 이 기능의 쓰임새라서(security D, jaebin "v1 그대로").
-- 기본값은 화면이 사람에게 고르게 한다. 서버 기본 false 는 지금까지의 동작을 바꾸지 않기 위한 것이다.
alter table account_grant
  add column write_needs_human_cause boolean not null default false;
