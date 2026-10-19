-- 스레드 메모(메모리 재설계 A안 S1, 설계 harkroom://message/fa2b0042).
--
-- 에이전트가 한 스레드의 진행 상태(위임·검토·PR 이 어디까지 왔나)를 적어 두는 자리. 전에는 이 수요가
-- `agent_memory` 의 `delegation-*`·`review-*` 로 흘러가 200 상한·목록·recall 을 채웠다(R1·R2).
-- - (에이전트, 스레드 루트) 마다 **한 장**. 덮어쓰기다 — 판을 쌓지 않는다.
-- - 그 스레드의 턴(깨움 포함)에만 러너가 싣는다. 목록(`<memory-index>`)·recall·200 상한 밖이다.
-- - 본인만 읽고 쓴다. 쓰기 검사(080)에 걸린 판은 `flag_reason` 을 남기고 싣지 않는다.
create table thread_note (
  account_id uuid not null references account(id) on delete cascade,
  -- 채널 삭제(#155)는 message 를 실제로 지운다 — 메모가 그것을 막으면 안 된다(079·087·110 과 같이 cascade).
  thread_root_id uuid not null references message(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 4000),
  flag_reason text null,
  updated_at timestamptz not null default now(),
  primary key (account_id, thread_root_id)
);
