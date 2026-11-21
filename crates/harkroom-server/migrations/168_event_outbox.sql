-- 이벤트 버스 outbox(S5.0, Rust 전환). 다른 프로세스(Rust 서버)가 낸 워크스페이스 이벤트를 TS 서버의 WS 구독자에게 옮긴다.
--
-- 쓰는 쪽은 한 트랜잭션에서 이 표에 한 줄을 넣고 `pg_notify('harkroom_event_outbox', id::text)` 로 **id 만** 알린다 —
-- NOTIFY 페이로드는 8000바이트 미만이라 메시지 본문(최대 8000자)을 실을 수 없다. 받는 쪽(`src/eventBus.ts`)이 id 로 다시 읽는다.
-- 줄은 받은 뒤 지우지 않는다(서버 프로세스가 여럿이면 각자 읽는다). 한 시간 지난 줄을 받는 쪽이 주기적으로 걷는다.
create table if not exists event_outbox (
  id bigserial primary key,
  event jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists event_outbox_created_at on event_outbox (created_at);
