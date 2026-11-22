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

/// 만료가 먼저 — 뒤의 대체가 사본을 덮는다(다시 청하면 옛 카드는 새 카드를 가리킨다). 그 뒤로는 바뀌지 않는다.
#[tokio::test]
async fn expire_then_supersede_ends_superseded() {
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
    assert!(second.status_written && second.ask_closed);
    let after_second = meta(&pool, &id).await;
    assert_eq!(after_second["permissionRequest"]["status"], "superseded");
    assert_eq!(after_second["permissionRequest"]["requestId"], "r0");
    assert_eq!(
        after_second["permissionRequest"]["supersededBy"],
        "00000000-0000-0000-0000-000000000001"
    );
    assert_eq!(after_second["ask"]["closedReason"], "superseded");
    assert_eq!(
        after_second["ask"]["supersededBy"],
        "00000000-0000-0000-0000-000000000002"
    );
    assert_eq!(after_second["ask"]["question"], "q");

    // 대체된 뒤에는 만료도, 또 한 번의 대체도 아무것도 바꾸지 않는다.
    let again = close(&pool, &id, CardClose::Expired, AT2).await;
    assert!(!again.changed());
    let again = close(&pool, &id, SUPERSEDED, AT2).await;
    assert!(!again.changed());
    assert_eq!(meta(&pool, &id).await, after_second);
}

/// 대체는 만료된 사본만 덮는다 — 사람이 닫았거나 다른 끝난 상태인 사본은 그대로다.
#[tokio::test]
async fn supersede_leaves_other_closed_copies() {
    let Some(pool) = pool().await else { return };
    for (tag, m) in [
        (
            "sup_denied",
            json!({
                "permissionRequest": { "requestId": "r0", "status": "denied" },
                "ask": { "question": "q", "options": ["ok"], "closedAt": AT1, "closedBy": "someone" }
            }),
        ),
        (
            "sup_obsolete",
            json!({
                "permissionRequest": { "requestId": "r0", "status": "obsolete" },
                "ask": { "question": "q", "options": ["ok"], "closedAt": AT1, "closedReason": "declined" }
            }),
        ),
    ] {
        let id = card(&pool, tag, m.clone()).await;
        assert!(!close(&pool, &id, SUPERSEDED, AT2).await.changed(), "{tag}");
        assert_eq!(meta(&pool, &id).await, m, "{tag}");
    }
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

/// 다시 청하면 옛 요청 줄은 `superseded` 다 — sweep 이 먼저 `expired` 로 옮긴 줄도, 시한만 지난 `pending` 도 같은 끝.
/// 사람이 정한 줄(granted·denied)과 다른 스레드의 줄은 건드리지 않는다.
#[tokio::test]
async fn asking_again_supersedes_expired_and_lapsed_requests() {
    use harkroom_server::core::permission_card::{NewRequest, Opened, open_request};
    let Some(pool) = pool().await else { return };
    let agent: String = sqlx::query_scalar(
        "insert into account(handle, display_name, kind) values ('cs_again', 'cs_again', 'agent') returning id::text",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let ch: String = sqlx::query_scalar(
        "insert into channel(name, kind) values ('cs-again', 'standard') returning id::text",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    const THREAD: &str = "00000000-0000-0000-0000-0000000000a1";
    const OTHER_THREAD: &str = "00000000-0000-0000-0000-0000000000a2";
    const TARGET: &str = "Bash(cs again:*)";

    // (꼬리표, 상태, 스레드) — 모두 시한이 지난 줄이다.
    let seeds = [
        ("expired", "expired", THREAD),
        ("lapsed", "pending", THREAD),
        ("granted", "granted", THREAD),
        ("denied", "denied", THREAD),
        ("elsewhere", "expired", OTHER_THREAD),
    ];
    let mut ids = Vec::new();
    for (_, status, thread) in seeds {
        let id: String = sqlx::query_scalar(
            "insert into permission_request (agent_id, kind, target, reason, channel_id, thread_root_id, status, created_at, expires_at) \
             values ($1::uuid, 'tool', $2, 'r', $3::uuid, $4::uuid, $5, '2025-12-30T00:00:00Z', '2025-12-31T00:00:00Z') returning id::text",
        )
        .bind(&agent)
        .bind(TARGET)
        .bind(&ch)
        .bind(thread)
        .bind(status)
        .fetch_one(&pool)
        .await
        .unwrap();
        ids.push(id);
    }

    let mut tx = pool.begin().await.unwrap();
    let opened = open_request(
        &mut tx,
        &NewRequest {
            kind: "tool",
            agent: &agent,
            target: TARGET,
            reason: "again",
            warnings: &[],
            channel: &ch,
            thread: THREAD,
            denial: None,
            mandate: None,
            now: AT1,
            expires: AT2,
        },
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let Opened::Created { request_id: new_id } = opened else {
        panic!("request was not created");
    };

    let mut seen = Vec::new();
    for ((tag, _, _), id) in seeds.iter().zip(&ids) {
        let (status, by): (String, Option<String>) = sqlx::query_as(
            "select status, superseded_by::text from permission_request where id = $1::uuid",
        )
        .bind(id)
        .fetch_one(&pool)
        .await
        .unwrap();
        seen.push((*tag, status, by));
    }
    let new = Some(new_id.clone());
    assert_eq!(
        seen,
        vec![
            ("expired", "superseded".to_string(), new.clone()),
            ("lapsed", "superseded".to_string(), new),
            ("granted", "granted".to_string(), None),
            ("denied", "denied".to_string(), None),
            ("elsewhere", "expired".to_string(), None),
        ]
    );
    let status: String =
        sqlx::query_scalar("select status from permission_request where id = $1::uuid")
            .bind(&new_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(status, "pending");
}
