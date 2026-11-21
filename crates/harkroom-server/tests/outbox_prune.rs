//! event_outbox 정리 sweep(`loops::outbox_prune`)이 TS `eventBus.ts::pruneEventOutbox` 와 같은 일을 하는지 실제 Postgres 로 본다.
//! `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛴다(CI 는 `scripts/db-tests.sh` 가 넘긴다).
//! - `HARKROOM_TEST_WRITE_DATABASE_URL` 이 있으면 sweep 은 그 역할(`OUTBOX_PRUNE_PRIVILEGES` 만 가진 쓰기 역할)로 돈다.
//! - `HARKROOM_OUTBOX_PRUNE_DUAL=1` 이면 이중 실행 모드 — TS 가 깔아 둔 줄을 TS sweep 과 **동시에** 지워 지운 수만 찍는다(판정은 TS 쪽).
use harkroom_server::loops::outbox_prune::{OUTBOX_PRUNE_PRIVILEGES, prune};
use harkroom_server::loops::{GateResult, Side, run_gated};
use sqlx::PgPool;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use std::str::FromStr;

/// 시험이 깐 줄(`event->>'t'` 로 고른다) 중 보존(5분)이 지난 것의 수.
async fn old_rows(pool: &PgPool, tag: &str) -> i64 {
    sqlx::query_scalar(
        "select count(*) from event_outbox where event->>'t' = $1 and created_at < now() - interval '5 minutes'",
    )
    .bind(tag)
    .fetch_one(pool)
    .await
    .unwrap()
}

#[tokio::test]
async fn outbox_prune_like_ts() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let write_url =
        std::env::var("HARKROOM_TEST_WRITE_DATABASE_URL").unwrap_or_else(|_| url.clone());
    let admin = PgPool::connect(&url).await.unwrap();
    let opts = PgConnectOptions::from_str(&write_url)
        .unwrap()
        .application_name("harkroom-outbox-prune-dual");
    let w = PgPoolOptions::new()
        .max_connections(3)
        .connect_with(opts)
        .await
        .unwrap();
    let missing = harkroom_server::write::missing_in(&w, OUTBOX_PRUNE_PRIVILEGES, &[])
        .await
        .unwrap();
    assert!(missing.is_empty(), "write role lacks {missing:?}");

    if let Ok(tag) = std::env::var("HARKROOM_OUTBOX_PRUNE_DUAL") {
        // 기다리지 않는다 — TS 가 먼저 다 지우면 겹침을 보이지 못한다(TS 는 이 연결을 보고 시작한다).
        let mut deleted = 0u64;
        let mut overlapped = 0u64;
        loop {
            let before = old_rows(&admin, &tag).await;
            let n = prune(&w).await.unwrap();
            deleted += n;
            if before > 0 {
                overlapped += 1;
            }
            if n == 0 && old_rows(&admin, &tag).await == 0 {
                break;
            }
        }
        println!("outbox-prune-dual rust deleted {deleted} overlapped {overlapped}");
        return;
    }

    // 지울 것: 6분 된 줄 300. 남길 것: 4분 된 줄·방금 쓴 줄(보존 5분).
    sqlx::query(
        "insert into event_outbox(event, created_at) \
         select jsonb_build_object('t', 'op-rs', 'k', 'old-' || g), now() - interval '6 minutes' from generate_series(1, 300) g",
    )
    .execute(&admin)
    .await
    .unwrap();
    sqlx::query(
        "insert into event_outbox(event, created_at) values \
         (jsonb_build_object('t', 'op-rs', 'k', 'keep-4'), now() - interval '4 minutes'), \
         (jsonb_build_object('t', 'op-rs', 'k', 'keep-now'), now())",
    )
    .execute(&admin)
    .await
    .unwrap();

    assert_eq!(prune(&w).await.unwrap(), 300);
    assert_eq!(old_rows(&admin, "op-rs").await, 0);
    // 멱등 — 다시 돌려도 지울 것이 없다.
    assert_eq!(prune(&w).await.unwrap(), 0);
    let kept: Vec<String> = sqlx::query_scalar(
        "select event->>'k' from event_outbox where event->>'t' = 'op-rs' order by 1",
    )
    .fetch_all(&admin)
    .await
    .unwrap();
    assert_eq!(kept, vec!["keep-4", "keep-now"]);

    // C5 조건 — 문지기 풀과 sweep 풀이 각각 연결 하나뿐이어도 sweep 이 돈다. 주인이 아니면 지우지 않는다.
    sqlx::query(
        "insert into event_outbox(event, created_at) \
         select jsonb_build_object('t', 'op-rs', 'k', 'gated-' || g), now() - interval '2 hours' from generate_series(1, 5) g",
    )
    .execute(&admin)
    .await
    .unwrap();
    let one = || {
        PgPoolOptions::new()
            .max_connections(1)
            .acquire_timeout(std::time::Duration::from_secs(3))
            .connect(&write_url)
    };
    let (gate1, work1) = (one().await.unwrap(), one().await.unwrap());
    // 줄이 없으면 주인은 rust — ts 쪽 tick 은 건너뛴다.
    let r = run_gated(&gate1, "outbox.prune", Side::Ts, || async {
        prune(&work1).await.map(|_| ())
    })
    .await;
    assert!(matches!(r, GateResult::NotOwner), "{r:?}");
    assert_eq!(old_rows(&admin, "op-rs").await, 5);
    let r = run_gated(&gate1, "outbox.prune", Side::Rust, || async {
        prune(&work1).await.map(|_| ())
    })
    .await;
    assert!(matches!(r, GateResult::Ran), "{r:?}");
    assert_eq!(old_rows(&admin, "op-rs").await, 0);
}
