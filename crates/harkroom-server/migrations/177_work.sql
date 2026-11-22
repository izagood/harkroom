-- 작업 판(B1). 일의 단위를 「작업 행」 하나로 적는다 — 상태의 정본은 `work` 행이고, `work_event` 는 이력(추가만)이다.
-- 이 마이그레이션은 표만 만든다: 아직 어떤 운영 경로도 쓰지 않는다(동작 변화 없음).
--
-- - 뿌리 작업은 `parent_id` 가 비고 `root_id = id` 다. 하위 작업(위임·쪼갠 조각)은 부모 행의 `root_id`·`thread_root_id`·
--   `channel_id`·원장 칸(`mandate_id`·`cause_account_id`)을 같은 트랜잭션에서 복사한다.
-- - `assignee_account_id` 가 비면 「판에 올린 열린 과제」다(누가 잡기 전).
-- - 원장 칸: `created_by_work_id`(만든 작업)·`pool`·`body`·`paths`·`after_work_id`(앞 작업)·`due_at`·`mandate_id`(위임장)·
--   `cause_account_id`(원인 사람). 위임장이 지워지면 `mandate_id` 만 빈다(작업 이력은 남는다).
-- - 쓰기 역할 GRANT: `work` select·insert·update, `work_event` select·insert, `work_event_id_seq` usage.
create table if not exists work (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references channel(id) on delete cascade,
  -- 이 작업이 붙은 스레드의 뿌리 글. 글이 지워지면(hard delete) 작업도 같이 지운다.
  thread_root_id uuid not null references message(id) on delete cascade,
  parent_id uuid references work(id) on delete cascade,
  root_id uuid not null references work(id) on delete cascade,
  created_by_work_id uuid references work(id) on delete set null,
  -- 이 작업을 낳은 글(사람 글·호출 글). 없을 수 있다(계획 단계에서 생긴 작업).
  source_message_id uuid references message(id) on delete set null,
  assignee_account_id uuid references account(id) on delete set null,
  requester_account_id uuid references account(id) on delete set null,
  cause_account_id uuid references account(id) on delete set null,
  mandate_id uuid references mandate(id) on delete set null,
  pool text check (pool is null or length(pool) between 1 and 128),
  title text not null default '' check (length(title) <= 200),
  body text not null default '',
  paths text[] not null default '{}',
  after_work_id uuid references work(id) on delete set null,
  due_at timestamptz,
  state text not null default 'open' check (state in ('open', 'running', 'waiting', 'done', 'failed', 'canceled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz,
  check (parent_id is null or parent_id <> id),
  check ((parent_id is null) = (root_id = id))
);

create index if not exists work_thread_idx on work (thread_root_id, created_at);
create index if not exists work_channel_idx on work (channel_id);
create index if not exists work_root_idx on work (root_id);
create index if not exists work_parent_idx on work (parent_id) where parent_id is not null;
create index if not exists work_created_by_idx on work (created_by_work_id) where created_by_work_id is not null;
create index if not exists work_after_idx on work (after_work_id) where after_work_id is not null;
create index if not exists work_source_message_idx on work (source_message_id) where source_message_id is not null;
create index if not exists work_assignee_open_idx on work (assignee_account_id, state) where closed_at is null;
create index if not exists work_requester_idx on work (requester_account_id) where requester_account_id is not null;
create index if not exists work_mandate_idx on work (mandate_id) where mandate_id is not null;
create index if not exists work_cause_idx on work (cause_account_id) where cause_account_id is not null;

-- 사건 이력. 추가만 한다(update·delete 권한을 주지 않는다). 작업이 지워지면 같이 지워진다.
create table if not exists work_event (
  id bigint generated always as identity primary key,
  work_id uuid not null references work(id) on delete cascade,
  kind text not null check (length(kind) between 1 and 64),
  actor_account_id uuid references account(id) on delete set null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists work_event_work_idx on work_event (work_id, id);
create index if not exists work_event_actor_idx on work_event (actor_account_id) where actor_account_id is not null;
