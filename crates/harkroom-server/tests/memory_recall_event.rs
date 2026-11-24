//! 실린 사건 표(191): `memory.recalled` 가 턴 id 를 받으면 턴·기억·계기·순위를 적고, 없으면 수만 센다.
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
async fn recalled_records_events_per_turn() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let pool = PgPool::connect(&url).await.unwrap();
    let me = agent(&pool, "mre").await;
    for s in ["mem/aa", "mem/bb"] {
        let r = set(
            &pool,
            &me,
            json!({ "slug": s, "value": "v", "kind": "topic", "confirmNew": true }),
        )
        .await;
        assert_eq!(r["ok"], true, "{r}");
    }
    let turn = "00000000-0000-4000-8000-0000000000aa";
    // 없는 기억은 사건으로 적지 않고, 되풀이 보고는 한 줄이다. 키의 판(@시각)은 떼고 적는다.
    for _ in 0..2 {
        let r = call(
            &pool,
            &me,
            "memory.recalled",
            json!({ "slugs": ["mem/bb@2026-01-01T00:00:00.000Z", "mem/gone", "mem/aa"], "turnId": turn, "trigger": "turn_start" }),
        )
        .await;
        assert_eq!(r["ok"], true);
    }
    let got: Vec<(String, String, String, i16)> = sqlx::query_as(
        "select turn_id::text, slug, trigger, rank from memory_recall_event where account_id = $1::uuid order by rank",
    )
    .bind(&me.id)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        got,
        vec![
            (turn.into(), "mem/bb".into(), "turn_start".into(), 1),
            (turn.into(), "mem/aa".into(), "turn_start".into(), 3),
        ]
    );
    // 옛 러너(턴 id 없음) — 수만 센다.
    call(
        &pool,
        &me,
        "memory.recalled",
        json!({ "slugs": ["mem/aa"] }),
    )
    .await;
    let n: (i32, i64) = sqlx::query_as(
        "select recall_count, (select count(*) from memory_recall_event where account_id = $1::uuid) \
         from agent_memory where account_id = $1::uuid and slug = 'mem/aa'",
    )
    .bind(&me.id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(n, (3, 2));
    // 90일 지난 사건은 다음에 적을 때 지워지고, 기억을 지우면 그 사건도 지워진다.
    sqlx::query("update memory_recall_event set created_at = now() - interval '91 days' where account_id = $1::uuid and slug = 'mem/bb'")
        .bind(&me.id)
        .execute(&pool)
        .await
        .unwrap();
    call(
        &pool,
        &me,
        "memory.recalled",
        json!({ "slugs": ["mem/aa"], "turnId": "00000000-0000-4000-8000-0000000000ab" }),
    )
    .await;
    set(&pool, &me, json!({ "slug": "mem/aa", "value": null })).await;
    let left: i64 = sqlx::query_scalar("select count(*) from memory_recall_event")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(left, 0);
}
