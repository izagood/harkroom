//! 카드 사본 닫기(`core::card_state::close_card_copy`)를 실제 Postgres 로 본다. `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛴다
//! (CI `db-tests` 의 `scripts/db-tests.sh` 가 마이그레이션을 다 적용한 DB 를 넘긴다).
//!
//! 사본은 열린 상태에서만 끝난 상태로 간다 — 먼저 쓴 쪽이 남고, 두 번째 호출은 아무것도 바꾸지 않는다.
use harkroom_server::core::card_state::{CardClose, CardClosed, close_card_copy};
use serde_json::{Value, json};
use sqlx::PgPool;

const AT1: &str = "2026-01-01T00:00:00.000Z";
const AT2: &str = "2026-01-02T00:00:00.000Z";

async fn pool() -> Option<PgPool> {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return None;
    };
    Some(PgPool::connect(&url).await.unwrap())
}

/// 채널·작성자를 하나 만들고 그 `meta` 를 단 글 id 를 돌려준다.
async fn card(pool: &PgPool, tag: &str, meta: Value) -> String {
    let author: String = sqlx::query_scalar(
        "insert into account(handle, display_name, kind) values ($1, $1, 'agent') returning id::text",
    )
    .bind(format!("cs_{tag}"))
    .fetch_one(pool)
    .await
    .unwrap();
    let ch: String = sqlx::query_scalar(
        "insert into channel(name, kind) values ($1, 'standard') returning id::text",
    )
    .bind(format!("cs-{tag}"))
    .fetch_one(pool)
    .await
    .unwrap();
    sqlx::query_scalar(
        "insert into message(channel_id, author_id, body, kind, meta) values ($1::uuid, $2::uuid, 'm', 'user', $3) returning id::text",
    )
    .bind(ch)
    .bind(author)
    .bind(meta)
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn meta(pool: &PgPool, id: &str) -> Value {
    sqlx::query_scalar("select meta from message where id = $1::uuid")
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn close(pool: &PgPool, id: &str, c: CardClose<'_>, at: &str) -> CardClosed {
    let mut tx = pool.begin().await.unwrap();
    let r = close_card_copy(&mut tx, id, c, at, true).await.unwrap();
    tx.commit().await.unwrap();
    r
}

fn open_card() -> Value {
    json!({
        "permissionRequest": { "requestId": "r0", "status": "pending" },
        "ask": { "question": "q", "options": ["ok"] }
    })
}

const SUPERSEDED: CardClose<'static> = CardClose::Superseded {
    new_request: "00000000-0000-0000-0000-000000000001",
    new_card: "00000000-0000-0000-0000-000000000002",
};

/// 만료가 먼저 — 뒤의 대체는 아무것도 바꾸지 않는다.
#[tokio::test]
async fn expire_then_supersede_keeps_expired() {
    let Some(pool) = pool().await else { return };
    let id = card(&pool, "exp_sup", open_card()).await;

    let first = close(&pool, &id, CardClose::Expired, AT1).await;
    assert!(first.status_written && first.ask_closed && first.changed());
    let after_first = meta(&pool, &id).await;
    assert_eq!(after_first["permissionRequest"]["status"], "expired");
    assert_eq!(after_first["permissionRequest"]["decidedAt"], AT1);
    assert_eq!(after_first["permissionRequest"]["requestId"], "r0");
    assert_eq!(after_first["ask"]["closedReason"], "expired");
    assert_eq!(after_first["ask"]["closedAt"], AT1);

    let second = close(&pool, &id, SUPERSEDED, AT2).await;
    assert_eq!(second, CardClosed::default());
    assert!(!second.changed());
    assert_eq!(meta(&pool, &id).await, after_first);

    // 같은 닫기를 다시 불러도 그대로다.
    let again = close(&pool, &id, CardClose::Expired, AT2).await;
    assert!(!again.changed());
    assert_eq!(meta(&pool, &id).await, after_first);
}

/// 대체가 먼저 — 뒤의 만료는 아무것도 바꾸지 않는다.
#[tokio::test]
async fn supersede_then_expire_keeps_superseded() {
    let Some(pool) = pool().await else { return };
    let id = card(&pool, "sup_exp", open_card()).await;

    let first = close(&pool, &id, SUPERSEDED, AT1).await;
    assert!(first.status_written && first.ask_closed);
    let after_first = meta(&pool, &id).await;
    assert_eq!(after_first["permissionRequest"]["status"], "superseded");
    assert_eq!(
        after_first["permissionRequest"]["supersededBy"],
        "00000000-0000-0000-0000-000000000001"
    );
    assert_eq!(after_first["ask"]["closedReason"], "superseded");
    assert_eq!(
        after_first["ask"]["supersededBy"],
        "00000000-0000-0000-0000-000000000002"
    );

    let second = close(&pool, &id, CardClose::Expired, AT2).await;
    assert_eq!(second, CardClosed::default());
    assert_eq!(meta(&pool, &id).await, after_first);

    let obsolete = close(
        &pool,
        &id,
        CardClose::Obsolete {
            reason: "merged",
            actor: "someone",
        },
        AT2,
    )
    .await;
    assert!(!obsolete.changed());
    assert_eq!(meta(&pool, &id).await, after_first);
}

/// 답이 달린 카드·상태 칸을 적지 않는 호출.
#[tokio::test]
async fn answered_card_and_ask_only_close() {
    let Some(pool) = pool().await else { return };
    // 이미 정해진 사본(답 있음)은 어느 닫기도 건드리지 않는다.
    let decided = json!({
        "permissionRequest": { "requestId": "r0", "status": "granted" },
        "ask": { "question": "q", "options": ["ok"], "answeredWith": "ok" }
    });
    let id = card(&pool, "answered", decided.clone()).await;
    assert!(!close(&pool, &id, CardClose::Expired, AT1).await.changed());
    assert!(!close(&pool, &id, SUPERSEDED, AT1).await.changed());
    assert_eq!(meta(&pool, &id).await, decided);

    // `copy_status = false` 면 선택 카드만 닫고 상태 칸은 그대로다.
    let id = card(&pool, "ask_only", open_card()).await;
    let mut tx = pool.begin().await.unwrap();
    let r = close_card_copy(&mut tx, &id, SUPERSEDED, AT1, false)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert!(!r.status_written && r.ask_closed);
    let m = meta(&pool, &id).await;
    assert_eq!(m["permissionRequest"]["status"], "pending");
    assert_eq!(m["ask"]["closedReason"], "superseded");

    // 상태 칸이 없는 사본은 열린 것으로 본다.
    let id = card(
        &pool,
        "no_status",
        json!({ "permissionRequest": { "requestId": "r0" } }),
    )
    .await;
    let r = close(&pool, &id, CardClose::Expired, AT1).await;
    assert!(r.status_written && !r.ask_closed);
    assert_eq!(
        meta(&pool, &id).await["permissionRequest"]["status"],
        "expired"
    );
}
