-- AC6 — 오퍼레이터 능력 스냅숏. 오퍼레이터 코어가 Rust(`HARKROOM_CORE=rust`)에 있으면 TS 허브는 비어 있어
-- `hub.capabilities()` 가 늘 null 이다. Rust 가 받은 능력(hello·capabilities 프레임)을 여기 적고 TS 가 읽는다.
--
-- - 붙어 있는 동안만 줄이 있다: 새 연결·끊김이면 Rust 가 지운다(`core/operator_capability.rs`).
-- - Rust 는 기동 때 표를 비우지 않는다(서버가 여럿이면 남의 줄을 지운다). 대신 붙어 있는 오퍼레이터의 `seen_at` 을 주기마다
--   고치고, TS 는 `seen_at` 이 낡은 줄을 「모른다」로 읽는다 — 프로세스가 죽어 지우지 못한 줄도 그렇게 걸러진다.
-- - 쓰기 역할 GRANT: select, insert, update, delete. 없으면 Rust 는 스냅숏만 끄고 오퍼레이터 코어는 그대로 선다.
create table if not exists operator_capability (
  operator_id uuid primary key references operator(id) on delete cascade,
  body jsonb not null,
  updated_at timestamptz not null default now(),
  seen_at timestamptz not null default now()
);
