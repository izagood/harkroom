-- migrate: no-transaction
--
-- 상한 없이 자라는 표를 훑던 질의 셋에 색인을 단다(2026-11-09 쿼리 검토 A3·A4·A6).
--
-- ## A3 — 시작 스레드(startedIn)의 「사람이 그 스레드에서 나를 불렀나」
--
-- `listInbox` 의 startedIn 은 위임장 하나마다 `exists (inbox hi join message h … where h.channel_id = d.channel_id
-- and coalesce(h.thread_root_id, h.id) = d.thread_root_id)` 를 되묻는다. 식에 맞는 색인이 없어 플래너는
-- `message_channel_seq` 로 **그 채널의 메시지 전부**를 훑고 coalesce 를 줄마다 걸렀다(채널이 클수록 비례해 커진다).
-- 식 색인 `(channel_id, coalesce(thread_root_id, id))` 는 그 스레드(머리 + 답글)만 바로 짚는다. 질의가
-- `h.deleted_at is null` 을 같이 걸므로 부분 색인으로 지운 글은 뺀다. 그 뒤 `inbox_message_idx (message_id, account_id)`(120)
-- 로 내 inbox 줄을 찾는다.
--
-- ## A4 — 답 없는 요청 스위퍼의 부분 색인(049 `inbox_stale_idx`) 좁히기
--
-- 049 의 술어는 `read_at is null and stale_notified_at is null` 뿐이었다. 스위퍼(`staleRequests.ts`)는 요청 사유
-- 넷(`REQUEST_REASONS`: mention·team_mention·thread_reply·dm)만 집고 그것에만 `stale_notified_at` 을 찍으므로, 그 밖의
-- 사유(wake·ask_answered·delegation_* …)의 안 읽은 줄은 스위퍼가 절대 지우지 못한 채 색인에 영원히 남는다.
-- 사유 조건을 술어에 더해 스위퍼가 볼 수 있는 줄만 담는다. 스위퍼의 `i.reason = any($1)` 은 node-pg 가 매번 값으로
-- 계획하므로(이름 없는 prepared statement → custom plan) 플래너가 `reason in (…)` 를 함의로 증명할 수 있다.
-- `REQUEST_REASONS` 를 바꾸면 이 술어도 같이 바꿔야 한다(안 바꾸면 색인을 못 쓸 뿐 결과는 같다).
--
-- 열은 `created_at` 이 아니라 `id` 다: 스위퍼는 `order by i.id limit 200` 이라, 후보가 200 을 넘을 만하면 플래너는
-- `created_at` 색인을 버리고 `inbox_pkey` 를 처음부터 걸으며 거른다(합성 데이터 실측: 049 색인이 있어도 inbox 전체
-- 50k 줄을 훑음). `id` 순서의 부분 색인이면 그 걸음이 후보만 걷는다. `created_at` 조건은 그 줄들에서 거른다.
-- 사람 계정의 안 읽은 요청 줄은 이 술어로도 남는다(계정 종류는 부분 색인 술어에 넣을 수 없다) — 그래도 색인은 표가
-- 아니라 안 읽은 요청 줄만큼만 자란다.
--
-- 이름을 새로 짓는 이유: 같은 이름을 걷고 다시 만들면 그 사이에 색인이 없는 틈이 생긴다. 새 것을 먼저 만들고 옛 것을 걷는다.
--
-- ## A6 — 보존 기간 sweeper(`retention.ts`)의 시간마다 세기
--
-- `idempotency_key.created_at`·`session.expires_at` 에 색인이 없어 한 시간마다 두 표를 통째로 훑었다(지우기 스위치가
-- 기본 꺼짐이라 세기만 하는 동안 표는 계속 자란다). 범위 조건이라 평범한 btree 다.
--
-- 트랜잭션 밖에서 concurrently 로 만든다(120·121·123 과 같은 이유): 만드는 동안 쓰기를 막지 않는다. 앞서 실패해
-- INVALID 로 남은 것이 있으면 `if not exists` 가 그것을 「있다」고 보므로 먼저 걷는다.
drop index concurrently if exists message_channel_thread_key_idx;
create index concurrently if not exists message_channel_thread_key_idx
  on message (channel_id, (coalesce(thread_root_id, id)))
  where deleted_at is null;

drop index concurrently if exists inbox_stale_request_idx;
create index concurrently if not exists inbox_stale_request_idx on inbox (id)
  where read_at is null and stale_notified_at is null
    and reason in ('mention', 'team_mention', 'thread_reply', 'dm');
drop index concurrently if exists inbox_stale_idx;

drop index concurrently if exists idempotency_key_created_at_idx;
create index concurrently if not exists idempotency_key_created_at_idx on idempotency_key (created_at);

drop index concurrently if exists session_expires_at_idx;
create index concurrently if not exists session_expires_at_idx on session (expires_at);
