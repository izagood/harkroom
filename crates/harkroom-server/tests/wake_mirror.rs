//! 깨움 거울 sweep(`loops::wake_mirror`)을 실제 Postgres 로 본다 — 에이전트 inbox 행만 한 번 베끼고, 읽힌 행은 닫는지.
//! `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛴다(CI 는 `scripts/db-tests.sh` 가 넘긴다).
//! - `HARKROOM_TEST_WRITE_DATABASE_URL` 이 있으면 sweep 은 그 역할(`WAKE_MIRROR_PRIVILEGES` 만 가진 쓰기 역할)로 돈다.
use harkroom_server::loops::wake_mirror::{WAKE_MIRROR_PRIVILEGES, sweep};
use harkroom_server::loops::{GateResult, Side, run_gated};
use sqlx::PgPool;

async fn account(admin: &PgPool, handle: &str, kind: &str) -> String {
    sqlx::query_scalar(
        "insert into account(handle, display_name, kind, login_id) values ($1, $1, $2, case when $2 = 'human' then $1 end) returning id::text",
    )
    .bind(handle)
    .bind(kind)
    .fetch_one(admin)
    .await
    .unwrap()
}

async fn message(admin: &PgPool, ch: &str, author: &str, root: Option<&str>) -> String {
    sqlx::query_scalar(
        "insert into message(channel_id, author_id, thread_root_id, body, kind) \
         values ($1::uuid, $2::uuid, $3::uuid, 'x', 'user') returning id::text",
    )
    .bind(ch)
    .bind(author)
    .bind(root)
    .fetch_one(admin)
    .await
    .unwrap()
}

async fn inbox(admin: &PgPool, who: &str, msg: &str) -> i64 {
    sqlx::query_scalar(
        "insert into inbox(account_id, message_id, reason) values ($1::uuid, $2::uuid, 'mention') returning id",
    )
    .bind(who)
    .bind(msg)
    .fetch_one(admin)
    .await
    .unwrap()
}

/// 이 inbox 행을 베낀 깨움들 — (계정, 글, 채널, 스레드 뿌리, 사유, 상태, 닫힘이 inbox 의 read_at 과 같은가, 작업이 비었는가).
type Row = (
    String,
    String,
    Option<String>,
    Option<String>,
    String,
    String,
    bool,
    bool,
);
async fn wakes(admin: &PgPool, inbox_id: i64) -> Vec<Row> {
    sqlx::query_as(
        "select w.account_id::text, w.message_id::text, w.channel_id::text, w.thread_root_id::text, w.reason, w.state, \
                w.closed_at is not distinct from (select read_at from inbox where id = w.inbox_id), w.work_id is null \
           from wake w where w.inbox_id = $1",
    )
    .bind(inbox_id)
    .fetch_all(admin)
    .await
    .unwrap()
}

#[tokio::test]
async fn mirrors_agent_inbox_rows_once_and_closes_read_ones() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let write_url =
        std::env::var("HARKROOM_TEST_WRITE_DATABASE_URL").unwrap_or_else(|_| url.clone());
    let admin = PgPool::connect(&url).await.unwrap();
    let w = PgPool::connect(&write_url).await.unwrap();
    let missing = harkroom_server::write::missing_in(&w, WAKE_MIRROR_PRIVILEGES, &[])
        .await
        .unwrap();
    assert!(missing.is_empty(), "write role lacks {missing:?}");

    let agent = account(&admin, "wm-agent", "agent").await;
    let human = account(&admin, "wm-human", "human").await;
    let ch: String = sqlx::query_scalar(
        "insert into channel(name, kind) values ('wm-rs', 'standard') returning id::text",
    )
    .fetch_one(&admin)
    .await
    .unwrap();
    let root = message(&admin, &ch, &human, None).await;
    let reply = message(&admin, &ch, &human, Some(&root)).await;

    let on_root = inbox(&admin, &agent, &root).await;
    let on_reply = inbox(&admin, &agent, &reply).await;
    let for_human = inbox(&admin, &human, &root).await;

    // 문지기 아래서 돈다(줄이 없으면 주인은 rust).
    let r = run_gated(&w, "wake.mirror", Side::Rust, || async {
        sweep(&w).await.map(|_| ())
    })
    .await;
    assert!(matches!(r, GateResult::Ran), "{r:?}");

    // 에이전트 행은 한 줄씩 — 뿌리 글은 자기 id 가 스레드 뿌리, 답글은 뿌리 글.
    let a = wakes(&admin, on_root).await;
    assert_eq!(a.len(), 1);
    assert_eq!(
        a[0],
        (
            agent.clone(),
            root.clone(),
            Some(ch.clone()),
            Some(root.clone()),
            "mention".to_owned(),
            "pending".to_owned(),
            true,
            true
        )
    );
    let b = wakes(&admin, on_reply).await;
    assert_eq!(b.len(), 1);
    assert_eq!(
        (b[0].1.as_str(), b[0].3.as_deref()),
        (reply.as_str(), Some(root.as_str()))
    );
    // 사람 행은 베끼지 않는다.
    assert!(wakes(&admin, for_human).await.is_empty());

    // 다시 돌아도 늘지 않는다(멱등) — 이 시험의 행은 더 들어오지 않는다.
    sweep(&w).await.unwrap();
    assert_eq!(wakes(&admin, on_root).await.len(), 1);
    assert_eq!(wakes(&admin, on_reply).await.len(), 1);
    assert!(wakes(&admin, for_human).await.is_empty());

    // 읽힌 inbox 행 → done + closed_at(= read_at). 안 읽힌 행은 그대로.
    sqlx::query("update inbox set read_at = now() where id = $1")
        .bind(on_root)
        .execute(&admin)
        .await
        .unwrap();
    let (_, closed) = sweep(&w).await.unwrap();
    assert!(closed >= 1);
    let a = wakes(&admin, on_root).await;
    assert_eq!((a[0].5.as_str(), a[0].6), ("done", true));
    assert_eq!(wakes(&admin, on_reply).await[0].5, "pending");
    // 닫힌 행은 다시 건드리지 않는다.
    let (_, again) = sweep(&w).await.unwrap();
    assert_eq!(again, 0, "closed rows must not be updated again");

    // inbox 행이 지워져도 깨움은 남는다(그대로).
    sqlx::query("delete from inbox where id = $1")
        .bind(on_reply)
        .execute(&admin)
        .await
        .unwrap();
    sweep(&w).await.unwrap();
    let b = wakes(&admin, on_reply).await;
    assert_eq!((b.len(), b[0].5.as_str()), (1, "pending"));
}
