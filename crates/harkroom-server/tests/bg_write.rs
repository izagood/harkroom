//! 백그라운드 회차의 기억 쓰기(`core::mcp::bg_write`) — 상한 예약·되돌려주기·변경 기록을 실제 Postgres 로 본다.
//! `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛴다(CI 는 `scripts/db-tests.sh` 가 넘긴다).
use harkroom_server::core::mcp::bg_write::{
    BG_WRITE_PRIVILEGES, BG_WRITE_SEQUENCES, MAX_WRITES, answer,
};
use serde_json::{Value, json};
use sqlx::PgPool;

async fn call(p: &PgPool, w: &PgPool, me: &str, job: &str, tool: &str, args: Value) -> Value {
    let acc = harkroom_server::auth::Account {
        id: me.to_owned(),
        handle: "bgw".into(),
        display_name: "bgw".into(),
        kind: "agent".into(),
        is_admin: false,
        role: "member".into(),
        status: "active".into(),
        status_text: None,
        avatar_attachment_id: None,
    };
    let out = answer(p, p, p, w, &acc, job, None, tool, &args)
        .await
        .expect("answered");
    let v: Value = serde_json::from_str(&out).unwrap();
    serde_json::from_str(v["content"][0]["text"].as_str().unwrap()).unwrap()
}

#[tokio::test]
async fn bg_writes_are_counted_and_recorded() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let write_url =
        std::env::var("HARKROOM_TEST_WRITE_DATABASE_URL").unwrap_or_else(|_| url.clone());
    let p = PgPool::connect(&url).await.unwrap();
    let w = PgPool::connect(&write_url).await.unwrap();
    let missing = harkroom_server::write::missing_in(&w, BG_WRITE_PRIVILEGES, BG_WRITE_SEQUENCES)
        .await
        .unwrap();
    assert!(missing.is_empty(), "write role lacks {missing:?}");
    let me: String = sqlx::query_scalar(
        "insert into account(handle, display_name, kind) values ('bgw', 'bgw', 'agent') returning id::text",
    )
    .fetch_one(&p)
    .await
    .unwrap();
    let job: String = sqlx::query_scalar(
        "insert into bg_job (account_id, kind, day, status, claimed_at) values ($1::uuid, 'cleanup', current_date, 'running', now()) returning id::text",
    )
    .bind(&me)
    .fetch_one(&p)
    .await
    .unwrap();
    let set = |slug: &str| json!({"slug": slug, "value": "v", "kind": "topic", "description": "d"});
    for s in ["mem/x/alpha", "mem/y/beta", "mem/z/gamma"] {
        let r = call(&p, &w, &me, &job, "memory.set", set(s)).await;
        assert_eq!(r["ok"], true, "{r}");
    }
    let r = call(
        &p,
        &w,
        &me,
        &job,
        "memory.merge",
        json!({"into":"mem/x/alpha","from":["mem/y/beta"],"value":"merged","kind":"topic"}),
    )
    .await;
    assert_eq!(r["ok"], true, "{r}");
    let r = call(
        &p,
        &w,
        &me,
        &job,
        "memory.archive",
        json!({"slug":"mem/z/gamma"}),
    )
    .await;
    assert_eq!(r["ok"], true, "{r}");
    // 실패한 쓰기는 세지 않는다.
    let r = call(
        &p,
        &w,
        &me,
        &job,
        "memory.archive",
        json!({"slug":"mem/none"}),
    )
    .await;
    assert_eq!(r["error"]["code"], "not_found");
    let writes: i32 = sqlx::query_scalar("select writes from bg_job where id = $1::uuid")
        .bind(&job)
        .fetch_one(&p)
        .await
        .unwrap();
    assert_eq!(writes, 3 + 2 + 1);
    let ops: Vec<(String, String)> =
        sqlx::query_as("select slug, op from bg_job_change where run_id = $1::uuid order by id")
            .bind(&job)
            .fetch_all(&p)
            .await
            .unwrap();
    let want = [
        ("mem/x/alpha", "create"),
        ("mem/y/beta", "create"),
        ("mem/z/gamma", "create"),
        ("mem/x/alpha", "merge"),
        ("mem/y/beta", "archive"),
        ("mem/z/gamma", "archive"),
    ];
    assert_eq!(ops, want.map(|(a, b)| (a.to_owned(), b.to_owned())));
    // 합치기의 이전 판에 회차 id 가 남는다.
    let n: i64 = sqlx::query_scalar("select count(*) from agent_memory_revision where account_id = $1::uuid and run_id = $2::uuid")
        .bind(&me).bind(&job).fetch_one(&p).await.unwrap();
    assert_eq!(n, 1);
    // 상한.
    sqlx::query("update bg_job set writes = $2 where id = $1::uuid")
        .bind(&job)
        .bind(MAX_WRITES)
        .execute(&p)
        .await
        .unwrap();
    let r = call(&p, &w, &me, &job, "memory.set", set("mem/q/delta")).await;
    assert_eq!(r["error"]["code"], "bg_write_limit");
    // 닫힌 회차·남의 회차는 예약하지 못한다.
    sqlx::query("update bg_job set writes = 0, status = 'done' where id = $1::uuid")
        .bind(&job)
        .execute(&p)
        .await
        .unwrap();
    let r = call(&p, &w, &me, &job, "memory.set", set("mem/q/delta")).await;
    assert_eq!(r["error"]["code"], "bg_write_limit");
}
