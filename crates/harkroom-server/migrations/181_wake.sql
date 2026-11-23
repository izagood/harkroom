-- 깨움 표(E1). 에이전트를 깨우는 한 건을 「깨움 행」 하나로 적는다 — 뒤 단계에서 에이전트 inbox 를 대신할 자리다.
-- 이 마이그레이션은 표만 만든다: 지금은 `loops/wake_mirror.rs` 가 에이전트 inbox 행을 그대로 베껴 넣을 뿐이고(그림자),
-- 정본은 여전히 `inbox` 다. 이 표를 읽어 판단하는 경로는 아직 없다(동작 변화 없음).
--
-- - 이름이 비슷한 `agent_wake`(040)는 **예약** 깨움(시각이 되면 inbox 에 한 줄 넣는 것)이다. 이 표는 깨움 그 자체다.
-- - `account_id` 는 깨워지는 에이전트, `message_id` 는 깨운 글. 계정·글이 지워지면(hard delete) 깨움도 같이 지운다.
-- - `channel_id`·`thread_root_id` 는 글에서 베낀 값이다(뿌리 글이면 자기 id). 베낀 값이라 FK 를 걸지 않는다 — 글이 지워지면
--   `message_id` 의 cascade 로 행이 같이 사라진다.
-- - `work_id` 는 작업 판(177)의 작업. 이 단계에서는 항상 빈다. 작업이 지워지면 이 칸만 빈다.
-- - `inbox_id` 는 베낀 inbox 행(`inbox.id`, bigint). unique 라 한 inbox 행은 한 번만 들어온다. FK 를 걸지 않는다 —
--   inbox 행이 지워져도 깨움 기록은 남고, 이 표가 inbox 지우기를 막거나 늦추지 않는다.
-- - `state`: `pending`(대기) → `delivered`(러너가 집음, 뒤 단계) → `done`(처리됨) / `canceled`. 닫히면 `closed_at`.
-- - 쓰기 역할 GRANT: `wake` select·insert·update. (거울 sweep 은 `inbox`·`account`·`message` select 도 쓴다 — 이미 있는 권한이다.)
--   없으면 Rust 는 거울 루프(`wake.mirror`)를 띄우지 않는다(나머지는 그대로 돈다).
create table if not exists wake (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references account(id) on delete cascade,
  message_id uuid not null references message(id) on delete cascade,
  channel_id uuid,
  thread_root_id uuid,
  work_id uuid references work(id) on delete set null,
  reason text not null,
  inbox_id bigint unique,
  state text not null default 'pending' check (state in ('pending', 'delivered', 'done', 'canceled')),
  created_at timestamptz not null default now(),
  closed_at timestamptz
);

create index if not exists wake_account_state_idx on wake (account_id, state);
create index if not exists wake_message_idx on wake (message_id);
create index if not exists wake_work_idx on wake (work_id) where work_id is not null;
