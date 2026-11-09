-- 164 의 짝 검사 `(outcome = 'closed') = (closed_reason is not null)` 는 열린 의무(outcome null)에서 왼쪽이 null 이 되어
-- 검사 전체가 null(=통과)이 된다 — 열린 의무에 closed_reason 만 붙어도 막지 못했다. `is not distinct from` 으로 null 을
-- false 로 읽게 고친다. 지금 있는 행은 모두 이 검사를 이미 만족한다(164 뒤로 closed_reason 을 쓰는 코드가 없었다).
alter table team_delegation_item drop constraint team_delegation_item_closed_reason_pair;
alter table team_delegation_item add constraint team_delegation_item_closed_reason_pair
  check ((outcome is not distinct from 'closed') = (closed_reason is not null));

-- ## 턴 끝 update 의 자리(P3, 스위치 `HARKROOM_DELEGATION_V2` 뒤)
-- 담당이 위임 스레드에 글을 쓰면 그 글을 「대기 중 update」로 적어 두고, 그 턴이 끝나면(임대 끝·임대 만료·마지막 글 60초 뒤
-- 중 먼저) 스위퍼가 위임자에게 `delegation_update` 하나를 만든다. `update_count` 는 위임 하나당 상한(40)을 센다.
alter table team_delegation_item add column update_pending_message_id uuid references message(id) on delete set null;
alter table team_delegation_item add column update_pending_at timestamptz;
alter table team_delegation_item add column update_count integer not null default 0;
-- 침묵 알림(stalled)은 한 번만.
alter table team_delegation_item add column stalled_notified_at timestamptz;
create index team_delegation_item_update_pending_idx on team_delegation_item (update_pending_message_id)
  where update_pending_message_id is not null;
