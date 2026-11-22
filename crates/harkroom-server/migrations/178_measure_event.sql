-- 기준선 측정 기록(A1). 뒤 단계의 「켬」 판단이 비교할 지금 값을 한 주 쌓는다 — 기록만 하고 동작은 바꾸지 않는다.
--
-- - 한 줄 = 한 사건. `kind` 가 무엇을 쟀는지(`core/measure.rs` 의 `KIND_*`), `value` 는 그 사건의 수(초·건수·토큰), `detail` 은 갈래.
--   - `queue.wait`          — 멘션이 inbox 에 들어온 뒤 턴 임대가 나기까지 기다린 초(`value`).
--   - `merge.denied`        — 머지 권한 거절 한 건. `detail.code`(거절 코드)·`detail.branch`(끊긴 갈래).
--   - `delegation.outcome`  — 위임 의무 하나가 닫힌 결말. `detail.outcome`·`detail.reason`, `ref_id` 는 위임 id.
--   - `call.missed`         — 에이전트 글이 `@핸들` 을 적었지만 깨우지 못한 호출(뒤 PR 이 적는다).
--   - `turn.tokens`         — 턴 하나의 토큰(뒤 PR 이 적는다. `detail` 에 input·output·cache).
-- - FK 를 걸지 않는다 — 계정·채널이 지워져도 수치는 남고, 기록이 그쪽 지우기를 막거나 늦추지 않는다. 글 본문·핸들은 싣지 않는다(id 와 수만).
-- - 기록은 best-effort 다. 실패해도 요청은 그대로 간다(로그 한 줄).
-- - 쓰기 역할 GRANT: select, insert. 없으면 Rust 는 기록을 켜지 않는다(나머지는 그대로 돈다).
create table if not exists measure_event (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  account_id uuid,
  channel_id uuid,
  thread_root_id uuid,
  ref_id text,
  value bigint,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists measure_event_kind_created_idx on measure_event (kind, created_at);
