-- 옛 열린 깨움 행 일회성 정리. inbox 줄이 없는데 열린 채 남은 깨움 행(181)을 `canceled` 로 닫는다.
--
-- - 왜 생겼나: 깨움 행을 inbox 줄과 같은 트랜잭션에서 쓰고 닫는 길(201, `core/wake_write.rs`)을 켜기 전에는 거울 루프가
--   inbox 줄을 베껴 넣기만 했다. 그 뒤 inbox 줄이 지워지면(안 읽은 줄을 새 줄로 갈음) 깨움 행을 닫아 줄 길이 없어 열린 채 남았다.
-- - 왜 닫나: 깨움 행을 읽어 「불렸다」를 판단하는 뒤 단계가 이 줄들을 아직 답하지 않은 부름으로 읽는다.
-- - 대상은 세 조건이 모두 맞는 줄뿐이다: 열림(`pending`·`delivered`) + inbox 줄 없음(`inbox_id` 가 비었거나 가리키는 줄이 없음)
--   + 아래 기준 시각보다 먼저 생김. 기준 시각 뒤에 생긴 줄은 건드리지 않는다 — 그 뒤로는 inbox 줄이 지워질 때 깨움도 같이
--   닫히고, 뒤 단계에서 inbox 줄 없이 쓰이는 깨움 행이 생겨도 이 문장에 걸리지 않는다.
-- - 닫힌 줄은 지우지 않는다(`state`·`closed_at` 만 바뀐다). 이미 닫힌 줄(`done`·`canceled`)과 inbox 줄이 있는 줄은 그대로다.
-- - 한 번만 돈다(`schema_migrations`). 다시 돌려도 대상이 없어 0줄이다. 닫은 줄 수는 notice 로 남긴다.
-- - 쓰기 역할 GRANT: 새로 필요한 것 없음(마이그레이션 역할이 돈다).
do $$
declare
  n bigint;
begin
  update wake w
     set state = 'canceled', closed_at = now()
   where w.state in ('pending', 'delivered')
     and w.created_at < timestamptz '2026-11-27 13:22:38+00'
     and not exists (select 1 from inbox i where i.id = w.inbox_id);
  get diagnostics n = row_count;
  raise notice '204: closed % open wake rows without an inbox row', n;
end $$;
