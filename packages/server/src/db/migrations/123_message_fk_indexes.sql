-- migrate: no-transaction
--
-- message 를 가리키는 외래키 중 **앞자리 색인이 없던 14개**에 색인을 단다(2026-10-13 쿼리 개선 Q5).
--
-- 메시지를 지울 때(채널 삭제는 그 채널의 메시지 전부) Postgres 는 외래키마다 「이 메시지를 아직 가리키는 행이 있나」를
-- 확인한다. 가리키는 열에 색인이 없으면 그 확인이 **지우는 메시지 한 줄마다 그 표를 통째로 훑는다**. 로컬 운영 크기
-- (메시지 22,608개 채널)에서 message.cause_message_id 하나가 11.4초였다 — message 자기 자신을 메시지 수만큼 훑었다.
-- 나머지는 지금은 작은 표지만(push_job·secret_turn_lease·idempotency_key 는 글·턴마다 자란다) 같은 꼴이다.
--
-- null 이 많은 열은 부분 색인(where … is not null)이다 — 외래키 확인은 null 을 찾지 않으므로 그 행은 색인에 필요 없다.
-- 트랜잭션 밖에서 concurrently 로 만든다(#1331 의 no-transaction 표지): 만드는 동안 그 표의 쓰기를 막지 않는다.
-- 앞서 실패해 INVALID 로 남은 것이 있으면 if not exists 가 그것을 「있다」고 보므로 먼저 걷는다.
drop index concurrently if exists automation_run_message_id_fk_idx;
create index concurrently if not exists automation_run_message_id_fk_idx on automation_run (message_id) where message_id is not null;
drop index concurrently if exists idempotency_key_message_id_fk_idx;
create index concurrently if not exists idempotency_key_message_id_fk_idx on idempotency_key (message_id);
drop index concurrently if exists inbox_thread_state_root_id_fk_idx;
create index concurrently if not exists inbox_thread_state_root_id_fk_idx on inbox_thread_state (root_id);
drop index concurrently if exists invoke_reply_grant_thread_root_id_fk_idx;
create index concurrently if not exists invoke_reply_grant_thread_root_id_fk_idx on invoke_reply_grant (thread_root_id);
drop index concurrently if exists merge_denial_card_message_id_fk_idx;
create index concurrently if not exists merge_denial_card_message_id_fk_idx on merge_denial (card_message_id) where card_message_id is not null;
drop index concurrently if exists message_cause_message_id_fk_idx;
create index concurrently if not exists message_cause_message_id_fk_idx on message (cause_message_id) where cause_message_id is not null;
drop index concurrently if exists permission_request_card_message_id_fk_idx;
create index concurrently if not exists permission_request_card_message_id_fk_idx on permission_request (card_message_id) where card_message_id is not null;
drop index concurrently if exists push_job_message_id_fk_idx;
create index concurrently if not exists push_job_message_id_fk_idx on push_job (message_id);
drop index concurrently if exists saved_message_message_id_fk_idx;
create index concurrently if not exists saved_message_message_id_fk_idx on saved_message (message_id);
drop index concurrently if exists scheduled_message_sent_message_id_fk_idx;
create index concurrently if not exists scheduled_message_sent_message_id_fk_idx on scheduled_message (sent_message_id) where sent_message_id is not null;
drop index concurrently if exists scheduled_message_thread_root_id_fk_idx;
create index concurrently if not exists scheduled_message_thread_root_id_fk_idx on scheduled_message (thread_root_id) where thread_root_id is not null;
drop index concurrently if exists secret_turn_lease_cause_message_id_fk_idx;
create index concurrently if not exists secret_turn_lease_cause_message_id_fk_idx on secret_turn_lease (cause_message_id);
drop index concurrently if exists team_delegation_message_id_fk_idx;
create index concurrently if not exists team_delegation_message_id_fk_idx on team_delegation (message_id);
drop index concurrently if exists team_delegation_item_closed_by_message_id_fk_idx;
create index concurrently if not exists team_delegation_item_closed_by_message_id_fk_idx on team_delegation_item (closed_by_message_id) where closed_by_message_id is not null;
