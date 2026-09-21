-- 스레드 집계용 인덱스. **채널을 처음 여는 조회가 이것 하나로 살아난다.**
--
-- `listMessages` 가 쓰는 `THREAD_STATS`·`THREAD_STATE_FACTS` 는 반환 행 하나마다
-- `thread_root_id = m.id` 를 상관 서브쿼리로 되묻는다(답글 수·참여자·미답 물음·마지막 말
-- 해서 대여섯 번). `001_init.sql` 이 만든 message 인덱스는 `(channel_id, seq)`·search GIN·
-- avcs_oid 셋뿐이라 `thread_root_id` 에 인덱스가 없었고, 그 되묻기가 전부 전체 스캔이었다.
--
-- 첫 조회는 500행이므로(`desktop/src/state/controller.ts::INITIAL_HISTORY_LIMIT`) 비용이
-- **페이지 크기 × 테이블 전체 행수**로 붙는다 — 그 채널이 조용해도 워크스페이스 전체
-- 메시지가 늘면 모든 채널이 같이 느려진다. 실측(2026-09-21, message 49,200행):
--
--     인덱스 없음               3,900ms
--     (thread_root_id)             45ms
--     (thread_root_id, seq)        15ms
--
-- `seq` 를 붙인 이유는 `thread_last` 의 `order by t.seq desc limit 1` 까지 인덱스 안에서
-- 끝나기 때문이다(위 45 → 15ms 가 그 차이다).
--
-- 부분 인덱스인 이유: 스레드 머리는 `thread_root_id` 가 null 이고, 되묻는 조건
-- (`thread_root_id = m.id`)은 null 행에 절대 맞지 않는다. 빼면 인덱스가 답글 수만큼만
-- 커지고 계획은 그대로다.
--
-- `concurrently` 가 아닌 이유: `migrate.ts` 가 마이그레이션 하나를 트랜잭션으로 감싸고,
-- `create index concurrently` 는 트랜잭션 안에서 못 돈다. 이 테이블 크기에서 쓰기를 막는
-- 시간은 1초 미만이라 트랜잭션 밖으로 빼낼 이유가 이 인덱스에는 없다.
create index if not exists message_thread_root_seq_idx
  on message (thread_root_id, seq)
  where thread_root_id is not null;
