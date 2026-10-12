-- migrate: no-transaction
--
-- 계정의 **안 읽은** inbox(2026-10-12 쿼리 검토 #4). 러너의 `inbox.poll` 이 25초마다(바쁘면 더 자주),
-- 앱은 `inbox.updated` 때마다 `?unread=1` 로 읽는다. `(account_id, id)`(001) 로는 그 계정의 **읽은 것까지**
-- 전부 훑고 거른다 — 읽은 줄은 지우지 않으므로 계정이 오래 살수록 커진다(한 계정 6.3k 줄 중 안 읽은 것 595).
--
-- 술어는 `listInbox` 의 `i.read_at is null` 과 같아야 플래너가 이 인덱스를 고른다. `id` 순서 그대로라
-- `inbox.poll` 의 상한(`INBOX_POLL_LIMIT`)이 앞에서 끊고 멈춘다.
--
-- 트랜잭션 밖 이유는 120 과 같다.
drop index concurrently if exists inbox_unread_idx;
create index concurrently if not exists inbox_unread_idx on inbox (account_id, id) where read_at is null;
