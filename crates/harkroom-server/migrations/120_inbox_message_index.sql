-- migrate: no-transaction
--
-- `inbox` 를 **메시지로** 찾는 자리(2026-10-12 쿼리 검토 #3). 지금 인덱스는 `(account_id, id)`(001) 뿐이라
-- 메시지 id 로 찾으면 inbox 전체를 훑는다 — 스레드 상태 판정(`threadStatus.ts` FACTS, 글이 올 때마다 두 번)·
-- `mentionDepthFor`(최대 50번 탐침)·inbox 줄 정리·위임·비밀 접근 확인이 모두 이 꼴이다. 로컬 운영 크기(inbox 31k)
-- 에서 FACTS 안의 inbox 가 seq scan 이었다. 채널 삭제(FK `inbox.message_id` 의 cascade)도 메시지마다 이 표를 훑는다.
--
-- `account_id` 를 뒤에 둔다 — 「이 메시지가 이 계정의 inbox 에 있나」도 인덱스만으로 끝난다.
--
-- 트랜잭션 밖에서 `concurrently` 로 만든다(`migrate.ts` NO_TRANSACTION_MARK) — 만드는 동안 inbox 쓰기를 막지 않는다.
-- 앞서 실패해 INVALID 로 남은 것이 있으면 `if not exists` 가 그것을 「있다」고 보므로 먼저 걷는다.
drop index concurrently if exists inbox_message_idx;
create index concurrently if not exists inbox_message_idx on inbox (message_id, account_id);
