-- 머지 래퍼 cause 판정을 위임 사슬로 넓힌다(A안, 스레드 0e30c565, security C1~C5·Q3).
--
-- ① `message.cause_message_id` — 이 글을 낸 턴을 띄운 메시지. 에이전트 발화와 wake 대기 줄에만, **오퍼레이터를 거친 요청**이고
--    그 메시지가 작성자를 실제로 깨웠을 때(inbox)만 서버가 적는다(`postMessage`). 머지 판정(`causeChainRoot`)이 이 칸을 거슬러
--    올라가 사슬의 뿌리가 그 에이전트의 소유자 글인지 본다.
--    C1: **insert 때만** 쓴다 — 아래 트리거가 다른 값으로 바꾸는 갱신을 거절한다(지운 메시지를 가리키던 값이 null 이 되는
--    `on delete set null` 만 지나간다).
alter table message add column cause_message_id uuid null references message(id) on delete set null;

create function message_cause_insert_only() returns trigger language plpgsql as $$
begin
  if new.cause_message_id is not null and new.cause_message_id is distinct from old.cause_message_id then
    raise exception 'message.cause_message_id is set only on insert';
  end if;
  return new;
end $$;

create trigger message_cause_insert_only before update of cause_message_id on message
  for each row execute function message_cause_insert_only();

-- ② PR 이 머지되거나 닫히면 그 PR 의 기다리는 머지 카드를 닫는다(Q3). 닫힌 카드는 승인·7일 허락·답을 409 로 거절하고,
--    「하루 한 장」·pending 중복 판정에서 빠진다(그 PR 이 다시 열리거나 새 PR 이 오면 새 카드가 선다).
alter table permission_request drop constraint permission_request_status_check;
alter table permission_request add constraint permission_request_status_check
  check (status in ('pending', 'granted', 'denied', 'approved_once', 'obsolete'));

alter table merge_denial add column obsoleted_at timestamptz null;
