//! 실제 Postgres 에 대고 쓰는 쪽 계약을 확인한다. `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛴다(CI 에는 DB 가 없다).
//! 시험마다 임시 schema 를 만들어 그 안에 마이그레이션 168 과 같은 표를 둔다 — 운영 표를 건드리지 않는다.

use sqlx::postgres::{PgListener, PgPoolOptions};
use sqlx::{AssertSqlSafe, Executor, PgPool, raw_sql};
use std::time::Duration;

const MIGRATION_168: &str =
    include_str!("../../../packages/server/src/db/migrations/168_event_outbox.sql");

// NOTIFY 채널은 DB 전체에 하나라 시험끼리 서로의 알림을 듣는다 — DB 를 쓰는 시험은 하나씩 돈다.
static DB: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn pool(schema: &str) -> Option<PgPool> {
    let url = std::env::var("HARKROOM_TEST_DATABASE_URL").ok()?;
    let admin = PgPool::connect(&url).await.expect("connect");
    admin
        .execute(raw_sql(AssertSqlSafe(format!(
            "drop schema if exists {schema} cascade; create schema {schema}"
        ))))
        .await
        .unwrap();
    let s = schema.to_string();
    let pool = PgPoolOptions::new()
        .max_connections(2)
        .after_connect(move |c, _| {
            let s = s.clone();
            Box::pin(async move {
                c.execute(raw_sql(AssertSqlSafe(format!("set search_path to {s}"))))
                    .await?;
                Ok(())
            })
        })
        .connect(&url)
        .await
        .unwrap();
    pool.execute(raw_sql(MIGRATION_168)).await.unwrap();
    Some(pool)
}

#[tokio::test]
async fn channel_name_matches_ts_receiver() {
    let ts = include_str!("../../../packages/server/src/eventBus.ts");
    assert!(ts.contains(&format!(
        "EVENT_OUTBOX_CHANNEL = '{}'",
        harkroom_bus::EVENT_OUTBOX_CHANNEL
    )));
}

#[tokio::test]
async fn commit_writes_row_and_notifies_id_only() {
    let _g = DB.lock().await;
    let Some(pool) = pool("bus_t_commit").await else {
        return;
    };
    let mut l = PgListener::connect_with(&pool).await.unwrap();
    l.listen(harkroom_bus::EVENT_OUTBOX_CHANNEL).await.unwrap();

    let ev = serde_json::json!({"type": "inbox.updated", "accountId": "a"});
    let mut tx = pool.begin().await.unwrap();
    let id = harkroom_bus::publish(&mut tx, &ev).await.unwrap();
    tx.commit().await.unwrap();

    let n = tokio::time::timeout(Duration::from_secs(5), l.recv())
        .await
        .expect("notify")
        .unwrap();
    assert_eq!(n.payload(), id.to_string());
    let (got,): (serde_json::Value,) =
        sqlx::query_as("select event from event_outbox where id = $1")
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(got, ev);
}

#[tokio::test]
async fn rollback_leaves_no_row_and_no_notify() {
    let _g = DB.lock().await;
    let Some(pool) = pool("bus_t_rollback").await else {
        return;
    };
    let mut l = PgListener::connect_with(&pool).await.unwrap();
    l.listen(harkroom_bus::EVENT_OUTBOX_CHANNEL).await.unwrap();

    let mut tx = pool.begin().await.unwrap();
    harkroom_bus::publish(
        &mut tx,
        &serde_json::json!({"type": "inbox.updated", "accountId": "a"}),
    )
    .await
    .unwrap();
    tx.rollback().await.unwrap();

    assert!(
        tokio::time::timeout(Duration::from_millis(500), l.recv())
            .await
            .is_err()
    );
    let (n,): (i64,) = sqlx::query_as("select count(*) from event_outbox")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(n, 0);
}

#[tokio::test]
async fn body_larger_than_notify_limit_is_carried_in_row() {
    let _g = DB.lock().await;
    let Some(pool) = pool("bus_t_large").await else {
        return;
    };
    let big = "가".repeat(8000);
    let ev = serde_json::json!({"type": "message.created", "audience": "all", "body": big});
    let mut c = pool.acquire().await.unwrap();
    let id = harkroom_bus::publish_on(&mut c, &ev).await.unwrap();
    let (got,): (serde_json::Value,) =
        sqlx::query_as("select event from event_outbox where id = $1")
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(got, ev);
}
