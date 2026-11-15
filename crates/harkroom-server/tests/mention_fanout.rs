//! 호출함 쓰기(`core::mention_fanout::fan_out_calls`)가 TS `fanOutCalls` 와 같은 줄을 남기는지 — 실제 스키마에서.
//! 픽스처와 사례는 CI `bus-e2e` 의 `packages/server/test/rustFrontDb.test.ts` 가 넣고 `HARKROOM_FANOUT_CASES`(JSON 파일 경로)로 넘긴다.
//! 사례마다 트랜잭션 안에서 글 행을 넣고 「누구를 부르나」→ 팬아웃을 돌린 뒤 inbox·push_job·숨김 해제를 읽고 롤백한다.
//! 결과는 `FANOUT_JSON` 한 줄로 찍고, 같은지는 TS 쪽이 맞춰 본다. env 가 없으면 건너뛴다.
use harkroom_server::core::mention_calls::{Input, Principal, resolve};
use harkroom_server::core::mention_fanout::{Post, fan_out_calls};
use serde_json::{Value, json};
use sqlx::PgConnection;
use std::collections::HashSet;

fn env() -> Option<(String, String)> {
    match (
        std::env::var("HARKROOM_TEST_DATABASE_URL"),
        std::env::var("HARKROOM_FANOUT_CASES"),
    ) {
        (Ok(u), Ok(p)) => Some((u, p)),
        _ => None,
    }
}

/// 사례 하나를 연결 위에서 돌린다 — 글 행을 넣고 판정·팬아웃. 팬아웃 오류는 그대로 돌려준다.
async fn run(conn: &mut PgConnection, c: &Value) -> Result<String, sqlx::Error> {
    let s = |k: &str| c[k].as_str().map(str::to_string);
    let body = s("body").unwrap();
    let channel = s("channelId").unwrap();
    let author = s("authorId").unwrap();
    let principal = s("principalId");
    let thread = s("threadRootId");
    let message_id: String = sqlx::query_scalar(
        "insert into message (channel_id, author_id, body, kind, thread_root_id) values ($1::uuid, $2::uuid, $3, 'user', $4::uuid) returning id::text",
    )
    .bind(&channel)
    .bind(&author)
    .bind(&body)
    .bind(thread.as_deref())
    .fetch_one(&mut *conn)
    .await
    .unwrap();
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    let input = Input {
        body: &body,
        channel_id: &channel,
        author_id: &author,
        author_is_agent: c["authorIsAgent"].as_bool().unwrap(),
        mention_depth: 0,
        chain_bound: false,
        chain_started_at_ms: None,
        reply_grant_thread_id: None,
        principal: principal.as_deref().map(|id| Principal { id }),
        now_ms,
        principal_invoke_enabled: true,
    };
    let r = resolve(&mut *conn, &input).await.unwrap();
    let mut notified: HashSet<String> = HashSet::new();
    let post = Post {
        channel_id: &channel,
        author_id: &author,
        message_id: &message_id,
    };
    fan_out_calls(&mut *conn, &post, &r, &mut notified).await?;
    Ok(message_id)
}

#[tokio::test]
async fn fan_out_matches_ts() {
    let Some((url, path)) = env() else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let pool = sqlx::PgPool::connect(&url).await.unwrap();
    let cases: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let mut out = vec![];
    for c in &cases {
        let mut tx = pool.begin().await.unwrap();
        let mid = run(&mut tx, c).await.unwrap();
        let inbox: Vec<(String, String, Option<String>)> = sqlx::query_as(
            "select account_id::text, reason, team_id::text from inbox where message_id = $1::uuid order by id",
        )
        .bind(&mid)
        .fetch_all(&mut *tx)
        .await
        .unwrap();
        let push: Vec<(String, String)> = sqlx::query_as(
            "select account_id::text, reason from push_job where message_id = $1::uuid order by inbox_id",
        )
        .bind(&mid)
        .fetch_all(&mut *tx)
        .await
        .unwrap();
        let revealed: Vec<String> = sqlx::query_scalar(
            "select account_id::text from channel_pref where channel_id = $1::uuid and hidden_at is null order by account_id",
        )
        .bind(c["channelId"].as_str().unwrap())
        .fetch_all(&mut *tx)
        .await
        .unwrap();
        tx.rollback().await.unwrap();
        out.push(json!({
            "inbox": inbox.iter().map(|(a, r, t)| format!("{a}:{r}:{}", t.as_deref().unwrap_or("-"))).collect::<Vec<_>>(),
            "push": push.iter().map(|(a, r)| format!("{a}:{r}")).collect::<Vec<_>>(),
            "revealed": revealed,
        }));
    }
    println!("FANOUT_JSON {}", Value::Array(out));
}

/// inbox 에 넣을 권한이 없으면 팬아웃은 **오류를 돌려준다** — 삼키고 「아무도 안 부름」으로 넘어가지 않는다.
/// 호출부(글 쓰기)는 이 오류로 트랜잭션 전체를 버린다.
#[tokio::test]
async fn fan_out_returns_err_without_inbox_insert() {
    let Some((url, path)) = env() else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let pool = sqlx::PgPool::connect(&url).await.unwrap();
    let cases: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let c = &cases[0];
    let mut tx = pool.begin().await.unwrap();
    for q in [
        "create role mc_no_inbox nologin",
        "grant usage on schema public to mc_no_inbox",
        "grant select on all tables in schema public to mc_no_inbox",
        "grant insert on message to mc_no_inbox",
        "grant usage on all sequences in schema public to mc_no_inbox",
        "set local role mc_no_inbox",
    ] {
        sqlx::query(q).execute(&mut *tx).await.unwrap();
    }
    let r = run(&mut tx, c).await;
    let err = r.expect_err("팬아웃이 inbox 권한 오류를 돌려줘야 한다");
    assert!(err.to_string().contains("inbox"), "{err}");
    tx.rollback().await.unwrap();
    println!("FANOUT_ERR_OK");
}
