-- 채널 **피드 페이지**(`GET /channels/:id/messages?before=…&feed=1`, `listMessages` 의 before 갈래)용 부분 인덱스.
--
-- 피드 페이지는 채널 본문에 서는 줄(스레드 머리·`also_in_channel` 답글)만 seq 내림차순으로 limit 개 받는다.
-- `(channel_id, seq)`(001) 만 있으면 그 사이의 답글을 전부 훑고 버린다 — 답글이 많은 채널은 머리 200개를
-- 모으려고 수만 행을 읽는다. 머리는 전체 메시지의 일부라 부분 인덱스가 작고, 같은 술어의 `hasMore`
-- (`hasOlderFeedMessages`)도 이 인덱스 한 번으로 끝난다.
--
-- 술어는 `messages.ts::FEED_ROW` 와 같은 뜻이어야 한다 — 조회의 where 가 이 술어를 함의해야 플래너가 이 인덱스를 고른다.
--
-- `concurrently` 가 아닌 이유는 062 와 같다(`migrate.ts` 가 마이그레이션을 트랜잭션으로 감싼다).
create index if not exists message_channel_feed_seq_idx
  on message (channel_id, seq)
  where thread_root_id is null or also_in_channel;
