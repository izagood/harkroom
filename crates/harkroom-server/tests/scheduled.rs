//! 예약 글 sweep(`loops::scheduled`)이 TS `scheduledMessages.ts` 의 `sendOneDue` 와 같은 일을 하는지 실제 Postgres 로 본다.
//! `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛴다(CI 는 `scripts/db-tests.sh` 가 넘긴다).
use harkroom_server::core::msg_post::PostState;
use harkroom_server::loops::scheduled::{Sent, send_one_due, sweep};
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;

async fn row(admin: &PgPool, id: &str) -> (Option<String>, Option<String>) {
    sqlx::query_as(
        "select sent_message_id::text, failed_reason from scheduled_message where id = $1::uuid",
    )
    .bind(id)
    .fetch_one(admin)
    .await
    .unwrap()
}

async fn schedule(admin: &PgPool, ch: &str, author: &str, body: &str, at: &str) -> String {
    sqlx::query_scalar(
        "insert into scheduled_message(channel_id, author_id, body, send_at) \
         values ($1::uuid, $2::uuid, $3, now() + $4::interval) returning id::text",
    )
    .bind(ch)
    .bind(author)
    .bind(body)
    .bind(at)
    .fetch_one(admin)
    .await
    .unwrap()
}

#[tokio::test]
async fn scheduled_sweep_like_ts() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let admin = PgPool::connect(&url).await.unwrap();
    let pool = PgPoolOptions::new()
        .max_connections(6)
        .connect(&url)
        .await
        .unwrap();
    let st = PostState {
        read: pool.clone(),
        write: pool.clone(),
        up: harkroom_server::proxy::Upstream::new("http://127.0.0.1:0"),
        implicit_ok: false,
    };
    let me: String = sqlx::query_scalar(
        "insert into account(handle, display_name, kind, login_id) values ('sch_rs', 'sch_rs', 'human', 'sch_rs') returning id::text",
    )
    .fetch_one(&admin)
    .await
    .unwrap();
    let ch: String = sqlx::query_scalar(
        "insert into channel(name, kind, visibility) values ('sch-rs', 'standard', 'public') returning id::text",
    )
    .fetch_one(&admin)
    .await
    .unwrap();
    let arch: String = sqlx::query_scalar(
        "insert into channel(name, kind, visibility, archived_at) values ('sch-rs-arch', 'standard', 'public', now()) returning id::text",
    )
    .fetch_one(&admin)
    .await
    .unwrap();

    let due = schedule(&admin, &ch, &me, "예약 글", "-1 minute").await;
    let later = schedule(&admin, &ch, &me, "나중 글", "1 day").await;
    let archived = schedule(&admin, &arch, &me, "보관 채널", "-1 minute").await;

    // 두 sweep 을 동시에 — 행 락 아래서 같은 행은 한 번만 나간다.
    let (a, b) = tokio::join!(sweep(&pool, &st), sweep(&pool, &st));
    assert_eq!(a.unwrap() + b.unwrap(), 1, "due row posted exactly once");

    let (sent, failed) = row(&admin, &due).await;
    let msg = sent.expect("due row marked sent");
    assert_eq!(failed, None);
    let (body, author, channel): (String, String, String) = sqlx::query_as(
        "select body, author_id::text, channel_id::text from message where id = $1::uuid",
    )
    .bind(&msg)
    .fetch_one(&admin)
    .await
    .unwrap();
    assert_eq!(
        (body.as_str(), author.as_str(), channel.as_str()),
        ("예약 글", me.as_str(), ch.as_str())
    );
    let posts: i64 = sqlx::query_scalar(
        "select count(*) from message where channel_id = $1::uuid and body = '예약 글'",
    )
    .bind(&ch)
    .fetch_one(&admin)
    .await
    .unwrap();
    assert_eq!(posts, 1);
    // `message.created` 가 outbox 로 나갔다.
    let events: i64 = sqlx::query_scalar(
        "select count(*) from event_outbox where event->>'type' = 'message.created' and event->'message'->>'id' = $1",
    )
    .bind(&msg)
    .fetch_one(&admin)
    .await
    .unwrap();
    assert_eq!(events, 1);

    // 아직 때가 아닌 것은 그대로, 보관 채널은 TS 와 같은 사유로 실패.
    assert_eq!(row(&admin, &later).await, (None, None));
    assert_eq!(
        row(&admin, &archived).await,
        (None, Some("channel_archived".into()))
    );

    // 다시 돌아도 더 나가지 않는다.
    assert_eq!(
        send_one_due(&pool, &st, &mut Vec::new()).await.unwrap(),
        Sent::None
    );
}
