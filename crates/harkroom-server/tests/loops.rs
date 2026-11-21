//! 서버 루프 문지기(`loops::run_gated`)가 옛 TS `loopGate.ts` 와 같은 잠금 class·키를 쓰는지, 주인 판정이 맞는지 실제 Postgres 로 본다.
//! `HARKROOM_TEST_DATABASE_URL`(마이그레이션이 전부 적용된 DB)이 없으면 건너뛴다(CI 는 `scripts/db-tests.sh` 가 넘긴다).
use harkroom_server::loops::{GateResult, LOOP_LOCK_CLASS, Side, run_gated};
use sqlx::PgPool;

#[tokio::test]
async fn gate_shares_lock_and_owner_with_ts() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let pool = PgPool::connect(&url).await.unwrap();
    let ts = PgPool::connect(&url).await.unwrap();

    // 1) 주인 줄이 없으면 rust 가 주인(TS 서버를 지운 뒤, 11-21) — Rust 가 돈다.
    let r = run_gated(&pool, "retention", Side::Rust, || async {
        Ok::<(), ()>(())
    })
    .await;
    assert!(matches!(r, GateResult::Ran), "{r:?}");
    // 1b) 줄이 `ts` 로 남아 있으면 그 루프는 멈춘다 — Rust 는 돌지 않는다.
    sqlx::query("insert into server_loop (name, owner) values ('retention', 'ts')")
        .execute(&pool)
        .await
        .unwrap();
    let r = run_gated(&pool, "retention", Side::Rust, || async {
        Ok::<(), ()>(())
    })
    .await;
    assert!(matches!(r, GateResult::NotOwner), "{r:?}");
    sqlx::query("delete from server_loop where name = 'retention'")
        .execute(&pool)
        .await
        .unwrap();

    // 2) TS 가 쓰는 것과 같은 키(class + hashtext(name))를 다른 세션이 쥐고 있으면 Rust 는 locked.
    let mut held = ts.acquire().await.unwrap();
    let got: bool = sqlx::query_scalar("select pg_try_advisory_lock($1, hashtext('wake'))")
        .bind(LOOP_LOCK_CLASS)
        .fetch_one(&mut *held)
        .await
        .unwrap();
    assert!(got);
    sqlx::query("insert into server_loop (name, owner) values ('wake', 'rust')")
        .execute(&pool)
        .await
        .unwrap();
    let r = run_gated(&pool, "wake", Side::Rust, || async { Ok::<(), ()>(()) }).await;
    assert!(matches!(r, GateResult::Locked), "{r:?}");
    sqlx::query("select pg_advisory_unlock($1, hashtext('wake'))")
        .bind(LOOP_LOCK_CLASS)
        .execute(&mut *held)
        .await
        .unwrap();
    drop(held);

    // 3) 풀리고 주인이 rust 면 돈다. 실패해도 잠금은 남지 않는다.
    let r = run_gated(&pool, "wake", Side::Rust, || async { Ok::<(), ()>(()) }).await;
    assert!(matches!(r, GateResult::Ran), "{r:?}");
    let r = run_gated(&pool, "wake", Side::Rust, || async { Err::<(), _>("boom") }).await;
    assert!(matches!(r, GateResult::Sweep("boom")), "{r:?}");
    let n: i64 = sqlx::query_scalar(
        "select count(*) from pg_locks where locktype = 'advisory' and classid = $1::bigint::oid",
    )
    .bind(i64::from(LOOP_LOCK_CLASS))
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(n, 0);

    sqlx::query("delete from server_loop where name = 'wake'")
        .execute(&pool)
        .await
        .unwrap();
}
