-- 「내 작업」 보드(2026-10-03, S1 — `GET /inbox/board`)가 "내가 최근에 말한 스레드"를 찾는다
-- (`listBoardRootIds`: `author_id = 나 and created_at > now() - 30일`). 지금 message 에는 author_id
-- 인덱스가 없어 그 조회가 표 전체를 훑는다 — 보드를 열 때마다, 그리고 메시지가 늘수록 느려진다.
--
-- 머리(thread_root_id is null)와 답글을 한 인덱스로 같이 본다: 조회가 둘을 함께 모으고
-- (`coalesce(thread_root_id, id)`), 갈라 두면 같은 범위를 두 번 훑는다. 지운 말은 보드에 세지
-- 않으므로 부분 인덱스로 뺀다.
create index if not exists message_author_created_idx on message (author_id, created_at desc)
  where deleted_at is null;
--
-- `concurrently` 가 아닌 이유는 062 와 같다(`migrate.ts` 가 마이그레이션을 트랜잭션으로 감싼다).
