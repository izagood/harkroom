-- 에이전트×기기 허용 표(H1). 「이 에이전트를 이 오퍼레이터(기기)에서 돌려도 된다」 한 쌍이 한 줄이다.
--
-- - **지금은 기록만 한다.** 배정·러너 등록 판정은 여전히 `agent_assignment` 만 읽는다. 이 표는 배정을 따라 맞춰지는 사본이고
--   (`core/device_allow.rs` 의 `sync`), 여러 기기를 허용하는 관리는 뒤 단계가 더한다.
-- - 개인 자격증명(`agent_config.credential_scope = 'personal'`) 에이전트는 소유자 자신의 기기만 유효하다 — 배정 쓰기가 이미 막고,
--   읽는 쪽도 줄마다 다시 판정한다(소유자·범위가 나중에 바뀌어도 낡은 줄이 유효로 읽히지 않게).
-- - 계정은 지우지 않고 묘비로 남기므로 cascade 에 기대지 않는다 — 배정에 없는 줄은 `sync` 가 지운다.
-- - 쓰기 역할 GRANT: select, insert, delete. 없으면 Rust 는 이 기능만 끈다(오퍼레이터 코어·배정은 그대로 돈다).
create table if not exists agent_operator_allow (
  agent_id    uuid not null references account(id) on delete cascade,
  operator_id uuid not null references operator(id) on delete cascade,
  added_by    uuid references account(id) on delete set null,
  added_at    timestamptz not null default now(),
  primary key (agent_id, operator_id)
);
create index if not exists agent_operator_allow_operator_idx on agent_operator_allow (operator_id);

-- 첫 줄: 지금 배정. 배정은 에이전트당 한 줄이라 작다.
insert into agent_operator_allow (agent_id, operator_id, added_by, added_at)
select agent_id, operator_id, assigned_by, assigned_at from agent_assignment
on conflict do nothing;
