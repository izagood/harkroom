-- 잡은 기록(I2a). 작업 판(177)의 작업 하나를 「어느 오퍼레이터가 어느 에이전트로 지금 쥐고 있나」를 한 줄로 적는다.
-- 이 마이그레이션은 표만 만든다: 잡는 문장은 스위치(기본 꺼짐) 뒤에 있고 아직 어떤 운영 경로도 부르지 않는다(동작 변화 없음).
--
-- - 작업마다 한 줄이다(기본키 = `work_id`). 그래서 한 작업을 동시에 쥔 쪽은 많아야 하나다 — 제약이 지킨다.
-- - 「살아 있는 줄」은 `released_at` 이 비고 `lease_expires_at` 이 아직 안 지난 줄이다. 놓았거나 임대가 끝난 줄은 다음에 잡는 쪽이
--   같은 줄을 덮어쓰고 `attempts` 를 하나 올린다(임대 만료 = 판으로 돌아감. 따로 치우는 일꾼이 없다).
-- - `agent_id` 는 그 작업을 돌리는 에이전트(자격 단위), `operator_id` 는 임대를 쥐고 갱신하는 기기, `slot_generation` 은 그 기기의
--   러너 칸 세대(어느 칸인지 — 오퍼레이터가 주는 값을 그대로 적는다), `turn_id` 는 기록용이다.
-- - `mode`: `pull`(오퍼레이터가 판에서 잡음) · `assigned`(서버가 지명해 미리 적음 — 뒤 단계).
-- - `release_reason`: `done`·`failed`·`released`(스스로 놓음). 임대 만료는 따로 적지 않는다(시각으로 안다).
-- - 작업·에이전트·오퍼레이터가 지워지면(hard delete) 줄도 같이 지워진다.
-- - 쓰기 역할 GRANT: `work_claim` select·insert·update, `work` select·update(후보 행 잠금), `agent_operator_allow` select,
--   `operator` select, `account` select, `agent_config` select. 읽기 역할에는 줄 것이 없다.
create table if not exists work_claim (
  work_id uuid primary key references work(id) on delete cascade,
  agent_id uuid not null references account(id) on delete cascade,
  operator_id uuid not null references operator(id) on delete cascade,
  slot_generation bigint not null default 0 check (slot_generation >= 0),
  turn_id uuid,
  mode text not null default 'pull' check (mode in ('pull', 'assigned')),
  attempts integer not null default 1 check (attempts >= 1),
  claimed_at timestamptz not null default now(),
  renewed_at timestamptz not null default now(),
  lease_expires_at timestamptz not null,
  released_at timestamptz,
  release_reason text check (release_reason is null or release_reason in ('done', 'failed', 'released')),
  check ((released_at is null) = (release_reason is null))
);

create index if not exists work_claim_operator_live_idx on work_claim (operator_id, lease_expires_at) where released_at is null;
create index if not exists work_claim_agent_idx on work_claim (agent_id);
