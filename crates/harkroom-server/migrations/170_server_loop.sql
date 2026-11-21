-- 서버 루프 주인(S5.3 C5, Rust 전환). sweep 루프(예약 wake·자동화·만료 쓸기 등)를 Rust 로 하나씩 옮기는 동안
-- 한 루프가 TS 와 Rust 에서 **둘 다 도는 일**(같은 wake 가 두 번 깨우는 운영 사고)을 막는다.
--
-- 두 겹이다:
-- 1. 이 표 — 루프 이름마다 주인(`ts`|`rust`)을 하나 적는다. 줄이 없으면 `ts` 다(지금 동작 그대로). 옮길 때는 줄 하나를 바꾼다.
-- 2. advisory lock — 양쪽이 tick 마다 `pg_try_advisory_lock(LOOP_LOCK_CLASS, hashtext(name))` 를 잡은 동안에만 돈다.
--    주인을 바꾸는 순간 앞 주인의 tick 이 아직 돌고 있어도 새 주인은 잠금을 못 잡아 그 tick 을 건너뛴다 — 겹침 0.
create table if not exists server_loop (
  name text primary key check (name ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  owner text not null default 'ts' check (owner in ('ts', 'rust')),
  updated_at timestamptz not null default now()
);
