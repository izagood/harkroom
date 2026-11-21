-- 사람 글이 접은 깨움을 **그 글로 깨어난 턴에게 알린다**(2026-10-06).
--
-- 왜 필요한가: 사람이 스레드에서 에이전트를 부르면 그 스레드에 걸린 그 에이전트의 대기 깨움은
-- 전부 접힌다(`agentWakes.ts::preemptWakesForThread`, 부름이 있으면 canceled). 그런데 부름으로 뜬
-- 턴은 그 사실을 몰랐다 — "11:22 에 다시 본다"고 믿은 채 다른 일만 하고 끝나, 약속한 확인이
-- 조용히 사라졌다. 어느 글이 접었는지 남겨 두면 `inbox.poll` 이 그 글의 항목에 접힌 사유를 싣고,
-- 러너가 프롬프트에 "이 예약들이 접혔다 — 아직 필요하면 다시 걸어라" 를 적는다.
--
-- 행은 지우지 않는다: 접은 글이 지워져도 깨움 기록은 남는다(`on delete set null`).
alter table agent_wake
  add column canceled_by_message_id uuid null references message(id) on delete set null;

create index agent_wake_canceled_by on agent_wake (canceled_by_message_id)
  where canceled_by_message_id is not null;
