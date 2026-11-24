//! 「언제」 칸(192): memory.set 의 when 저장·유지·지움, memory.get 표시, 안 준 when 도 쓰기 검사를 거친다.
//! `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛴다(CI 는 `db-tests` 잡이 넘긴다).
use harkroom_server::auth::Account;
use harkroom_server::core::mcp::{mem_body, mem_writes};
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

async fn call(pool: &PgPool, me: &Account, tool: &str, args: Value) -> Value {
    body(mem_writes::answer(pool, Some(pool), me, tool, &args).await)
}

#[tokio::test]
async fn when_is_stored_kept_and_cleared() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let pool = PgPool::connect(&url).await.unwrap();
    let me = agent(&pool, "mwh").await;
    let put = |when: Option<&str>| {
        let mut v = json!({ "slug": "mem/report", "value": "v", "kind": "procedure" });
        if let Some(w) = when {
            v["when"] = w.into();
        }
        v
    };
    let get = || call(&pool, &me, "memory.get", json!({ "slug": "mem/report" }));
    assert_eq!(set(&pool, &me, put(None)).await["ok"], true);
    assert!(get().await.get("when").is_none());
    assert_eq!(
        set(&pool, &me, put(Some("완료 보고를 올리기 직전"))).await["ok"],
        true
    );
    assert_eq!(get().await["when"], "완료 보고를 올리기 직전");
    // 안 주면 남고, 빈 글자면 지운다.
    set(&pool, &me, put(None)).await;
    assert_eq!(get().await["when"], "완료 보고를 올리기 직전");
    set(&pool, &me, put(Some(""))).await;
    assert!(get().await.get("when").is_none());
    // 200자를 넘으면 모양 밖이다(입구의 검증이 거절한다).
    let long = "가".repeat(201);
    assert_eq!(
        mem_body::answer(
            &pool,
            Some(&pool),
            &me,
            None.into(),
            "memory.set",
            &put(Some(&long))
        )
        .await,
        Some(None)
    );
    // 판 시각이 안 맞으면 when 도 바뀌지 않는다.
    let mut stale = put(Some("바뀌면 안 된다"));
    stale["ifUpdatedAt"] = "2020-01-01T00:00:00.000Z".into();
    assert_eq!(set(&pool, &me, stale).await["error"]["code"], "conflict");
    assert!(get().await.get("when").is_none());
    // 칸 권한이 없는 쓰기 역할이면 아무것도 쓰지 않고 거절한다.
    let mut tx = pool.begin().await.unwrap();
    for q in [
        "drop role if exists mwh_rw",
        "create role mwh_rw login password 'mwh_rw' in role pg_read_all_data",
        "grant insert, delete, update (value, description, kind, flagged_at, flag_reason, archived_at, updated_at) on agent_memory to mwh_rw",
    ] {
        sqlx::query(q).execute(&mut *tx).await.unwrap();
    }
    tx.commit().await.unwrap();
    let opts = pool
        .connect_options()
        .as_ref()
        .clone()
        .username("mwh_rw")
        .password("mwh_rw");
    let narrow = PgPool::connect_with(opts).await.unwrap();
    let r = body(
        mem_body::answer(
            &pool,
            Some(&narrow),
            &me,
            None.into(),
            "memory.set",
            &json!({ "slug": "mem/none", "value": "v", "kind": "topic", "when": "x" }),
        )
        .await,
    );
    assert_eq!(r["error"]["code"], "when_unavailable");
    let n: i64 = sqlx::query_scalar(
        "select count(*) from agent_memory where account_id = $1::uuid and slug = 'mem/none'",
    )
    .bind(&me.id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(n, 0);
    narrow.close().await;
}
