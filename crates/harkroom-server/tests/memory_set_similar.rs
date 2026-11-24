//! 새 slug 로 쓸 때의 비슷한 기억 검사: 많이 겹치면 `confirmNew` 없이 거절, 조금 겹치면 알림만, 있던 것을 고칠 때는 보지 않는다.
//! `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛴다(CI 는 `db-tests` 잡이 넘긴다).
use harkroom_server::auth::Account;
use harkroom_server::core::mcp::mem_body;
use serde_json::{Value, json};
use sqlx::PgPool;

async fn agent(pool: &PgPool, handle: &str) -> Account {
    let id: String = sqlx::query_scalar(
        "insert into account(handle, display_name, kind) values ($1, $1, 'agent') returning id::text",
    )
    .bind(handle)
    .fetch_one(pool)
    .await
    .unwrap();
    Account {
        id,
        handle: handle.into(),
        display_name: handle.into(),
        kind: "agent".into(),
        is_admin: false,
        role: "member".into(),
        status: "online".into(),
        status_text: None,
        avatar_attachment_id: None,
    }
}

/// 도구 답의 본문(JSON).
fn body(r: Option<Option<String>>) -> Value {
    let t: Value = serde_json::from_str(&r.unwrap().unwrap()).unwrap();
    serde_json::from_str(t["content"][0]["text"].as_str().unwrap()).unwrap()
}

async fn set(pool: &PgPool, me: &Account, args: Value) -> Value {
    body(mem_body::answer(pool, Some(pool), me, None.into(), "memory.set", &args).await)
}

#[tokio::test]
async fn new_slug_is_checked_against_existing() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let pool = PgPool::connect(&url).await.unwrap();
    let me = agent(&pool, "mss").await;
    let put = |slug: &str, d: &str, confirm: bool| {
        let mut v = json!({ "slug": slug, "value": "v", "kind": "topic", "description": d });
        if confirm {
            v["confirmNew"] = true.into();
        }
        v
    };
    let r = set(
        &pool,
        &me,
        put(
            "mem/deploy/rollback-steps",
            "배포 되돌리기 절차 순서",
            false,
        ),
    )
    .await;
    assert_eq!(r["ok"], true);
    assert!(r.get("similar").is_none());
    // 이름이 거의 같다 — 거절하고 아무것도 쓰지 않는다.
    let r = set(
        &pool,
        &me,
        put("mem/deploy/rollback-steps-2", "다른 글", false),
    )
    .await;
    assert_eq!(r["error"]["code"], "similar_exists");
    assert_eq!(
        r["error"]["similar"][0]["slug"],
        "mem/deploy/rollback-steps"
    );
    assert_eq!(r["error"]["similar"][0]["archived"], false);
    let n: i64 =
        sqlx::query_scalar("select count(*) from agent_memory where account_id = $1::uuid")
            .bind(&me.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(n, 1);
    // 보관된 것도 본다.
    sqlx::query("update agent_memory set archived_at = now() where account_id = $1::uuid")
        .bind(&me.id)
        .execute(&pool)
        .await
        .unwrap();
    // 이름은 달라도 요약이 겹치면 거절한다.
    let r = set(
        &pool,
        &me,
        put("mem/zzz", "배포 되돌리기 절차 순서 모음", false),
    )
    .await;
    assert_eq!(r["error"]["code"], "similar_exists");
    assert_eq!(r["error"]["similar"][0]["archived"], true);
    // confirmNew 면 쓰고 알린다.
    let r = set(
        &pool,
        &me,
        put("mem/zzz", "배포 되돌리기 절차 순서 모음", true),
    )
    .await;
    assert_eq!(r["ok"], true);
    assert_eq!(r["similar"][0]["slug"], "mem/deploy/rollback-steps");
    // 있는 것(보관된 것 포함)을 고칠 때는 보지 않는다.
    for slug in ["mem/zzz", "mem/deploy/rollback-steps"] {
        let r = set(&pool, &me, put(slug, "배포 되돌리기 절차 순서 모음", false)).await;
        assert_eq!(r["ok"], true, "{slug}: {r}");
        assert!(r.get("similar").is_none());
    }
    // 이름 조각 하나만 같으면 알림만 한다.
    let r = set(&pool, &me, put("mem/deploy/canary", "카나리", false)).await;
    assert_eq!(r["ok"], true, "{r}");
    // 걸린 판의 요약은 견주지도 싣지도 않는다.
    sqlx::query(
        "update agent_memory set flagged_at = now(), flag_reason = 'x' where account_id = $1::uuid",
    )
    .bind(&me.id)
    .execute(&pool)
    .await
    .unwrap();
    let r = set(
        &pool,
        &me,
        put("mem/yyy", "배포 되돌리기 절차 순서 모음", false),
    )
    .await;
    assert_eq!(r["ok"], true, "{r}");
    assert!(r.get("similar").is_none());
    // 남의 기억은 보지 않는다.
    let other = agent(&pool, "mss2").await;
    let r = set(
        &pool,
        &other,
        put(
            "mem/deploy/rollback-steps",
            "배포 되돌리기 절차 순서",
            false,
        ),
    )
    .await;
    assert!(r.get("similar").is_none());
}
