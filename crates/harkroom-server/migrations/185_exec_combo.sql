-- 실행 조합 표(J1). 「실행 조합」 = 하네스 × 모델 × effort × 자격 + 단가 + 「승격 허용」 표시 + 사람이 붙인 짧은 이름.
--
-- - **이 마이그레이션은 표만 만든다.** 러너·오퍼레이터는 여전히 `agent_config`·스레드별 모델 표를 읽는다 — 이 표들을 읽어
--   턴을 띄우는 경로는 아직 없다(동작 변화 없음). 쓰는 곳은 `core/exec_combo.rs` 하나다.
-- - `exec_key_link`: API 키 연결. 주소(https)와 **비밀 이름**만 둔다 — 키 값은 이 표에 두지 않는다(값은 비밀 보관소 085 에 있다).
--   `secret_name` 은 베낀 이름이라 FK 를 걸지 않는다. 연결을 만드는 사람이 그 비밀의 소유자인지는 쓰는 SQL 이 같은 문장에서 본다.
-- - `exec_combo`: 조합. 자격은 구독 계정 풀 이름(`account_pool`) **또는** 키 연결(`key_link_id`) 중 정확히 하나다.
--   단가는 어림 비용용이고 백만 토큰당 USD 다. 조합이 쓰는 키 연결은 지울 수 없다(restrict).
-- - `agent_exec_combo`: 에이전트가 쓸 수 있는 조합(허용 목록). `is_default` 는 에이전트당 많아야 한 줄이다.
--   계정·조합이 지워지면(hard delete) 같이 지운다.
-- - 쓰기 역할 GRANT: 세 표 모두 select·insert·update·delete. (`secret`·`agent_config` select 도 쓴다 — 이미 있는 권한이다.)
--   없으면 Rust 는 이 기능만 켜지 않는다(나머지는 그대로 돈다).
create table if not exists exec_key_link (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique check (char_length(name) between 1 and 64),
  base_url    text not null check (base_url like 'https://%' and char_length(base_url) <= 500),
  secret_name text not null check (secret_name ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  created_by  uuid references account(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists exec_combo (
  id             uuid primary key default gen_random_uuid(),
  name           text not null unique check (char_length(name) between 1 and 64),
  harness        text not null check (char_length(harness) between 1 and 64),
  model          text not null check (char_length(model) between 1 and 128),
  effort         text check (effort is null or char_length(effort) between 1 and 32),
  account_pool   text check (account_pool is null or char_length(account_pool) between 1 and 64),
  key_link_id    uuid references exec_key_link(id) on delete restrict,
  input_price    double precision not null default 0 check (input_price >= 0),
  output_price   double precision not null default 0 check (output_price >= 0),
  promote_allowed boolean not null default false,
  created_by     uuid references account(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  check ((account_pool is null) <> (key_link_id is null))
);
create index if not exists exec_combo_key_link_idx on exec_combo (key_link_id);

create table if not exists agent_exec_combo (
  agent_id   uuid not null references account(id) on delete cascade,
  combo_id   uuid not null references exec_combo(id) on delete cascade,
  is_default boolean not null default false,
  added_by   uuid references account(id) on delete set null,
  added_at   timestamptz not null default now(),
  primary key (agent_id, combo_id)
);
create index if not exists agent_exec_combo_combo_idx on agent_exec_combo (combo_id);
create unique index if not exists agent_exec_combo_default_uniq on agent_exec_combo (agent_id) where is_default;
