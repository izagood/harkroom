-- 스레드 머리의 물음·실패·위임 집계용 부분 색인(규모 L1).
--
-- 피드 줄(스레드 머리)마다 `thread_state`·`thread_open` LATERAL 이 그 스레드의 물음·실패·위임 줄을 모은다.
-- 지금까지는 `message_thread_root_seq_idx`(062)로 그 스레드의 **답글 전부**를 읽은 뒤 kind 로 걸렀다 —
-- 머리 한 줄의 비용이 답글 수에 비례해, 답글 수천 스레드가 한 페이지에 몇 개만 끼어도 목록 쿼리가 시한에 닿았다.
-- 이 색인에는 그 네 kind 의 답글만 든다. 집계 쪽 WHERE 가 `meta->>'kind' in (...)` 로 같은 부분집합을 밝혀 적어
-- 플래너가 이 색인을 고른다(조건이 색인의 술어를 함의해야 고를 수 있다 — kind 목록이 바뀌면 두 자리를 함께 고친다).
--
-- 뿌리 줄 자신(`t.id = m.id`)은 기본 키로 읽으므로 이 색인에 넣지 않는다(`thread_root_id is not null`).
--
-- `concurrently` 가 아닌 이유는 062 와 같다: 마이그레이션 하나가 트랜잭션 하나이고, 대상 행(이 네 kind 의 답글)이
-- 적어 쓰기를 막는 시간이 짧다.
create index if not exists message_thread_kind_seq_idx
  on message (thread_root_id, seq)
  where thread_root_id is not null
    and (meta->>'kind') in ('ask', 'askBundle', 'failure', 'delegation');
