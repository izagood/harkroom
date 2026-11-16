//! 서버 루프 문지기(S5.3 C5, Rust 전환) — TS `packages/server/src/services/loopGate.ts` 와 같은 장치다.
//!
//! sweep 루프(예약 wake·자동화·만료 쓸기 등)를 Rust 로 하나씩 옮기는 동안 한 루프가 TS 와 Rust 에서 **둘 다** 돌면 같은 wake 가
//! 두 번 깨운다. 그래서 tick 마다:
//! 1. 풀에서 연결 하나를 빌려 `pg_try_advisory_lock(LOOP_LOCK_CLASS, hashtext(name))` — 못 잡으면 이 tick 은 건너뛴다.
//! 2. 잡은 채로 `server_loop` 에서 주인을 읽는다(줄이 없으면 `ts`). 내가 주인이 아니면 건너뛴다.
//! 3. 주인이면 sweep 을 돌리고, 끝나면(실패해도) 같은 연결에서 잠금을 푼다.
//!
//! class·키·순서가 TS 와 같아야 겹침이 0 이다. 옮긴 루프: [`wake`](C5b) · [`retention`](C5c) · [`mandate_idle`](C5c-2a) · [`permission_expire`](C5c-2b) · [`outbox_prune`](C5c-4).
pub mod bg;
pub mod bg_produce;
pub mod mandate_idle;
pub mod outbox_prune;
pub mod permission_expire;
pub mod push;
pub mod retention;
pub mod scheduled;
pub mod stale;
pub mod wake;

use sqlx::PgPool;
use std::future::Future;

/// advisory lock 의 class — 'LOOP'. TS `LOOP_LOCK_CLASS` 와 같아야 한다.
pub const LOOP_LOCK_CLASS: i32 = 0x4c4f_4f50;

/// 루프 이름 — TS `LOOP_NAMES` 와 같아야 한다(`server_loop.name` 의 키).
pub const LOOP_NAMES: [&str; 12] = [
    "wake",
    "delegation.deadline",
    "automation",
    "scheduled",
    "push",
    "permission.expire",
    "mandate.idle",
    "bg",
    "retention",
    "stale",
    "bg.produce",
    "outbox.prune",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    Ts,
    Rust,
}

impl Side {
    fn as_str(self) -> &'static str {
        match self {
            Side::Ts => "ts",
            Side::Rust => "rust",
        }
    }
}

#[derive(Debug)]
pub enum GateResult<E> {
    Ran,
    Locked,
    NotOwner,
    /// 문지기 쿼리(연결·잠금·주인 읽기) 실패.
    Gate(sqlx::Error),
    /// sweep 이 낸 실패 — 잠금은 이미 풀었다.
    Sweep(E),
}

/// `name` 루프의 tick 하나를 문지기 아래서 돌린다. `side` 가 주인이고 잠금을 잡았을 때만 `sweep` 을 부른다.
pub async fn run_gated<F, Fut, E>(pool: &PgPool, name: &str, side: Side, sweep: F) -> GateResult<E>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<(), E>>,
{
    let mut conn = match pool.acquire().await {
        Ok(c) => c,
        Err(e) => return GateResult::Gate(e),
    };
    let locked: bool = match sqlx::query_scalar("select pg_try_advisory_lock($1, hashtext($2))")
        .bind(LOOP_LOCK_CLASS)
        .bind(name)
        .fetch_one(&mut *conn)
        .await
    {
        Ok(v) => v,
        Err(e) => return GateResult::Gate(e),
    };
    if !locked {
        return GateResult::Locked;
    }
    let owner: Result<Option<String>, sqlx::Error> =
        sqlx::query_scalar("select owner from server_loop where name = $1")
            .bind(name)
            .fetch_optional(&mut *conn)
            .await;
    let result = match owner {
        Err(e) => GateResult::Gate(e),
        Ok(o) if o.as_deref().unwrap_or("ts") != side.as_str() => GateResult::NotOwner,
        Ok(_) => match sweep().await {
            Ok(()) => GateResult::Ran,
            Err(e) => GateResult::Sweep(e),
        },
    };
    let unlocked = sqlx::query("select pg_advisory_unlock($1, hashtext($2))")
        .bind(LOOP_LOCK_CLASS)
        .bind(name)
        .execute(&mut *conn)
        .await;
    if unlocked.is_err() {
        // 풀지 못한 연결을 풀로 돌려보내면 잠금이 그 연결에 남는다 — 연결째 버려 서버가 풀게 한다.
        drop(conn.detach());
    }
    result
}
