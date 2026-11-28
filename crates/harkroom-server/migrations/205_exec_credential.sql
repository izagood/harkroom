-- 실행 자격 줄(CR1). 「조합」에서 자격을 떼어 따로 세운다 — 자격 줄 3종(API 키 연결·구독 풀·기기 로컬)과
-- 에이전트마다의 허용 목록 + 기본 하나.
--
-- - **이 마이그레이션은 표만 만든다.** 턴 길은 여전히 조합(185)·스레드 지정(203)을 읽는다 — 이 표를 읽어 자격을 고르는
--   경로는 아직 없다(동작 변화 없음). 쓰는 곳은 `core/exec_credential.rs` 하나다.
-- - `exec_credential`: 자격 줄. 종류마다 채우는 칸이 정해져 있다(아래 check).
--   - `key`: 키 연결(`key_link_id`) 하나 + 그 키를 쓸 하네스 목록(`harnesses`, 하나 이상). 키 값·주소는 여기 없다.
--     자격 줄이 쓰는 키 연결은 지울 수 없다(restrict) — 조합(185)과 같다.
--   - `pool`: **(오퍼레이터, 하네스, 풀 이름)**. 이름만으로 묶지 않는다 — 같은 이름의 풀이 다른 기기에도 있을 수 있다.
--     오퍼레이터 줄이 지워지면 같이 지운다(cascade). `harnesses` 는 그 하네스 하나다.
--   - `local`: 이 기기 로컬 설정. 워크스페이스에 한 줄뿐이고 여기서 심는다. `harnesses` 가 비면 하네스를 가리지 않는다.
-- - `agent_exec_credential`: 에이전트가 쓸 수 있는 자격(허용 목록). `is_default` 는 에이전트당 많아야 한 줄이다.
-- - `agent_exec_credential_set`: 「설정함」 표지. 허용 목록에 처음 넣을 때 선다. 허용 줄이 cascade 로 다 지워져도 이 줄은
--   남는다 — 「한 번도 설정 안 함」(로컬로 돎)과 「설정했는데 비었음」(막음)을 가른다.
-- - 쓰기 역할 GRANT: `exec_credential` select·insert·delete, `agent_exec_credential` select·insert·update·delete,
--   `agent_exec_credential_set` select·insert, `operator`(id·owner_account_id·revoked_at) select.
--   (`exec_key_link`·`secret`·`agent_config` select 와 `audit_log` insert 도 쓴다 — 이미 있는 권한이다.)
--   없으면 Rust 는 이 기능만 켜지 않는다(나머지는 그대로 돈다).
create table if not exists exec_credential (
  id           uuid primary key default gen_random_uuid(),
  name         text not null unique check (char_length(name) between 1 and 64),
  kind         text not null check (kind in ('key', 'pool', 'local')),
  harnesses    text[] not null default '{}' check (cardinality(harnesses) <= 16),
  key_link_id  uuid references exec_key_link(id) on delete restrict,
  operator_id  uuid references operator(id) on delete cascade,
  pool_harness text check (pool_harness is null or char_length(pool_harness) between 1 and 64),
  pool_name    text check (pool_name is null or pool_name ~ '^[a-z0-9-]{1,32}$'),
  created_by   uuid references account(id) on delete set null,
  created_at   timestamptz not null default now(),
  check (
    (kind = 'key' and key_link_id is not null and cardinality(harnesses) >= 1
       and operator_id is null and pool_harness is null and pool_name is null)
    or (kind = 'pool' and operator_id is not null and pool_harness is not null and pool_name is not null
       and key_link_id is null and harnesses = array[pool_harness])
    or (kind = 'local' and key_link_id is null and operator_id is null
       and pool_harness is null and pool_name is null)
  )
);
create unique index if not exists exec_credential_key_uniq on exec_credential (key_link_id) where kind = 'key';
create unique index if not exists exec_credential_pool_uniq
  on exec_credential (operator_id, pool_harness, pool_name) where kind = 'pool';
create unique index if not exists exec_credential_local_uniq on exec_credential (kind) where kind = 'local';

insert into exec_credential (name, kind) values ('local', 'local') on conflict do nothing;

create table if not exists agent_exec_credential (
  agent_id      uuid not null references account(id) on delete cascade,
  credential_id uuid not null references exec_credential(id) on delete cascade,
  is_default    boolean not null default false,
  added_by      uuid references account(id) on delete set null,
  added_at      timestamptz not null default now(),
  primary key (agent_id, credential_id)
);
create index if not exists agent_exec_credential_cred_idx on agent_exec_credential (credential_id);
create unique index if not exists agent_exec_credential_default_uniq
  on agent_exec_credential (agent_id) where is_default;

create table if not exists agent_exec_credential_set (
  agent_id uuid primary key references account(id) on delete cascade,
  set_by   uuid references account(id) on delete set null,
  set_at   timestamptz not null default now()
);
