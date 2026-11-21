-- 위임(mandate) W1 — 소유자(사람)가 자기 에이전트를 부르는 **새 스레드 머리**를 쓰면 위임 하나가 생긴다. 같은 스레드의
-- 소유자 답글은 같은 위임을 잇는다. 서버만 키를 적는다 — 에이전트는 이 값을 보지도 보내지도 않는다.
--
-- W1 은 **그림자 기록만** 한다: 머지 판정(`checkMerge`)은 바뀌지 않고, 위임 판정을 옆에서 계산해 감사(`mandate.shadow`)에 남긴다.
-- 전부 새 표·null 허용 컬럼이라 옛 파드에 무해하다(expand).
create table if not exists mandate (
  id uuid primary key default gen_random_uuid(),
  owner_account_id uuid not null references account(id) on delete cascade,
  root_message_id uuid not null unique references message(id) on delete cascade,
  channel_id uuid not null,
  thread_root_id uuid not null,
  created_at timestamptz not null default now(),
  last_activity_at timestamptz not null default now(),
  ended_at timestamptz null,
  end_reason text null
);
create index if not exists mandate_owner_idx on mandate (owner_account_id);

alter table message add column if not exists mandate_id uuid null references mandate(id) on delete set null;
alter table secret_turn_lease add column if not exists mandate_id uuid null references mandate(id) on delete set null;
alter table agent_wake add column if not exists mandate_id uuid null references mandate(id) on delete set null;

-- `on delete set null` 이 참조하는 쪽을 훑지 않게(123 과 같은 이유). 위임이 붙은 행만 담는다.
create index if not exists message_mandate_id_idx on message (mandate_id) where mandate_id is not null;
create index if not exists secret_turn_lease_mandate_id_idx on secret_turn_lease (mandate_id) where mandate_id is not null;
create index if not exists agent_wake_mandate_id_idx on agent_wake (mandate_id) where mandate_id is not null;
