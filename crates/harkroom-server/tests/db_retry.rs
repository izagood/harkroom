//! 읽기 풀이 잠깐 막혔을 때 `message.read`·`inbox.poll` 이 TS 로 넘기지 않고 다시 부르는지([`db_retry`]) — 실제 스키마의 DB 로.
//! 풀을 연결 하나로 줄이고 그 연결을 쥐고 있어 「풀이 연결을 내주지 못한다」를 만든다. `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛴다.
use harkroom_server::auth::Account;
use harkroom_server::core::mcp::db_retry;
use harkroom_server::core::mcp::route::AnswerFut;
use harkroom_server::core::mcp::tools;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

fn me() -> Account {
    Account {
        id: "00000000-0000-0000-0000-00000000d6e1".into(),
        handle: "retry_me".into(),
        display_name: "retry_me".into(),
        kind: "agent".into(),
        is_admin: false,
        role: "member".into(),
        status: "active".into(),
        status_text: None,
        avatar_attachment_id: None,
    }
}

/// 연결 하나짜리 풀 — 앞단 읽기 풀과 같이 연결을 기다리다 시간이 끝나면 오류(운영 3s, 시험은 짧게).
async fn one_conn_pool() -> Option<sqlx::PgPool> {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return None;
    };
    Some(
        sqlx::postgres::PgPoolOptions::new()
            .max_connections(1)
            .acquire_timeout(Duration::from_millis(300))
            .connect(&url)
            .await
            .unwrap(),
    )
}

/// 진짜 도구 답([`tools::answer`])을 부르고 횟수를 센다.
fn real(
    pool: &sqlx::PgPool,
    tool: &'static str,
    args: serde_json::Value,
    hits: &Arc<AtomicUsize>,
) -> impl FnMut() -> AnswerFut {
    let (pool, hits) = (pool.clone(), hits.clone());
    move || {
        hits.fetch_add(1, Ordering::SeqCst);
        let (pool, args) = (pool.clone(), args.clone());
        Box::pin(async move { tools::answer(&pool, &me(), tool, &args, None, None).await })
    }
}

fn cases() -> [(&'static str, serde_json::Value); 2] {
    [
        (
            "message.read",
            serde_json::json!({ "channelId": "00000000-0000-0000-0000-00000000d6e2" }),
        ),
        ("inbox.poll", serde_json::json!({ "timeoutMs": 0 })),
    ]
}

#[tokio::test]
async fn healthy_pool_answers_once() {
    let Some(pool) = one_conn_pool().await else {
        return;
    };
    for (tool, args) in cases() {
        let hits = Arc::new(AtomicUsize::new(0));
        let r = db_retry::run(&pool, tool, real(&pool, tool, args, &hits)).await;
        let r = r.unwrap_or_else(|| panic!("{tool}: rust answers"));
        assert!(!r.contains("temporarily_unavailable"), "{tool}: {r}");
        assert_eq!(hits.load(Ordering::SeqCst), 1, "{tool}");
    }
}

#[tokio::test]
async fn stuck_pool_that_frees_is_answered_by_a_retry() {
    let Some(pool) = one_conn_pool().await else {
        return;
    };
    for (tool, args) in cases() {
        let held = pool.acquire().await.unwrap();
        // 첫 부르기(300ms 기다림) + 탐침 동안 막혀 있다가 풀린다 — 운영의 「몇 초 막힘」.
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(500)).await;
            drop(held);
        });
        let hits = Arc::new(AtomicUsize::new(0));
        let r = db_retry::run(&pool, tool, real(&pool, tool, args, &hits)).await;
        let r = r.unwrap_or_else(|| panic!("{tool}: answered, not handed to TS"));
        assert!(!r.contains("temporarily_unavailable"), "{tool}: {r}");
        assert!(hits.load(Ordering::SeqCst) >= 2, "{tool}: retried");
    }
}

#[tokio::test]
async fn pool_that_stays_stuck_fails_without_ts() {
    let Some(pool) = one_conn_pool().await else {
        return;
    };
    let held = pool.acquire().await.unwrap();
    for (tool, args) in cases() {
        let hits = Arc::new(AtomicUsize::new(0));
        let r = db_retry::run(&pool, tool, real(&pool, tool, args, &hits)).await;
        let r = r.unwrap_or_else(|| panic!("{tool}: must not hand to TS"));
        assert!(r.contains("temporarily_unavailable"), "{tool}: {r}");
        assert_eq!(hits.load(Ordering::SeqCst), db_retry::ATTEMPTS, "{tool}");
    }
    drop(held);
}
