//! 턴 원천 교체(`core::wake_source`, EB)를 실제 Postgres 로 본다 — 깨움 행 갈래가 「안 읽은 inbox 줄 가운데 열린 깨움이 있는 것」만,
//! inbox 줄의 id 그대로 내주는지, 임대 거르기를 따르는지, 읽음이 둘을 같이 닫아 다시 나오지 않는지.
//! `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛴다(CI 는 `scripts/db-tests.sh` 가 넘긴다).
//! - `HARKROOM_TEST_WRITE_DATABASE_URL` 이 있으면 쓰기는 그 역할(같이 쓰기 권한 + inbox 읽음 칸)로 돈다.
use harkroom_server::core::inbox_list::{InboxQuery, list_inbox};
use harkroom_server::core::wake_source::WAKE_SOURCE_PRIVILEGES;
use harkroom_server::core::wake_write::{read_close, write_now};
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

async fn message(admin: &PgPool, ch: &str, author: &str) -> String {
    sqlx::query_scalar(
        "insert into message(channel_id, author_id, body, kind) values ($1::uuid, $2::uuid, 'x', 'user') returning id::text",
    )
    .bind(ch)
    .bind(author)
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

async fn ids(pool: &PgPool, me: &str, q: InboxQuery) -> Vec<i64> {
    list_inbox(pool, me, q, false)
        .await
        .unwrap()
        .into_iter()
        .map(|r| r.id)
        .collect()
}

const WAKE: InboxQuery = InboxQuery::UnreadWake { unleased: false };
const WAKE_UNLEASED: InboxQuery = InboxQuery::UnreadWake { unleased: true };
const INBOX: InboxQuery = InboxQuery::Unread { since: None };

#[tokio::test]
async fn wake_source_serves_only_unread_rows_with_an_open_wake() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let write_url =
        std::env::var("HARKROOM_TEST_WRITE_DATABASE_URL").unwrap_or_else(|_| url.clone());
    let admin = PgPool::connect(&url).await.unwrap();
    let w = PgPool::connect(&write_url).await.unwrap();
    let missing = harkroom_server::write::missing_in(&admin, WAKE_SOURCE_PRIVILEGES, &[])
        .await
        .unwrap();
    assert!(missing.is_empty(), "read role lacks {missing:?}");

    let agent = account(&admin, "ws-agent", "agent").await;
    let other = account(&admin, "ws-other", "agent").await;
    let human = account(&admin, "ws-human", "human").await;
    let ch: String = sqlx::query_scalar(
        "insert into channel(name, kind) values ('ws-rs', 'standard') returning id::text",
    )
    .fetch_one(&admin)
    .await
    .unwrap();
    let mut rows = Vec::new();
    for _ in 0..5 {
        let m = message(&admin, &ch, &human).await;
        rows.push((inbox(&admin, &agent, &m).await, m));
    }
    let theirs_msg = message(&admin, &ch, &human).await;
    let theirs = inbox(&admin, &other, &theirs_msg).await;
    let (open, no_wake, closed, read_only, leased) =
        (rows[0].0, rows[1].0, rows[2].0, rows[3].0, rows[4].0);

    // 깨움 행이 하나도 없으면 깨움 행 갈래는 비어 있다. inbox 갈래는 다섯 줄 그대로다.
    assert!(ids(&admin, &agent, WAKE).await.is_empty());
    assert_eq!(ids(&admin, &agent, INBOX).await.len(), 5);

    // `no_wake` 만 빼고 깨움 행을 쓴다(같이 쓰기와 같은 문장).
    for (id, m) in &rows {
        if *id == no_wake {
            continue;
        }
        let mut tx = w.begin().await.unwrap();
        write_now(&mut tx, m, std::slice::from_ref(&agent)).await;
        tx.commit().await.unwrap();
    }
    let mut tx = w.begin().await.unwrap();
    write_now(&mut tx, &theirs_msg, std::slice::from_ref(&other)).await;
    tx.commit().await.unwrap();

    // 내주는 id 는 inbox 줄의 id 그대로다 — 깨움이 없는 줄만 빠진다. 남의 줄은 섞이지 않는다.
    assert_eq!(
        ids(&admin, &agent, WAKE).await,
        vec![open, closed, read_only, leased]
    );
    assert_eq!(ids(&admin, &other, WAKE).await, vec![theirs]);

    // 닫힌 깨움(done·canceled)은 내주지 않는다.
    sqlx::query("update wake set state = 'canceled', closed_at = now() where inbox_id = $1")
        .bind(closed)
        .execute(&admin)
        .await
        .unwrap();
    assert_eq!(
        ids(&admin, &agent, WAKE).await,
        vec![open, read_only, leased]
    );

    // inbox 줄만 읽힌 줄(옛 읽음 문장)은 깨움이 열려 있어도 다시 내주지 않는다.
    sqlx::query("update inbox set read_at = now() where id = $1")
        .bind(read_only)
        .execute(&admin)
        .await
        .unwrap();
    assert_eq!(ids(&admin, &agent, WAKE).await, vec![open, leased]);

    // `delivered` 도 열린 깨움이다.
    sqlx::query("update wake set state = 'delivered' where inbox_id = $1")
        .bind(open)
        .execute(&admin)
        .await
        .unwrap();
    assert_eq!(ids(&admin, &agent, WAKE).await, vec![open, leased]);

    // 임대 거르기는 inbox 갈래와 같다 — 살아 있는 임대가 걸린 줄을 뺀다.
    sqlx::query("update inbox set claimed_by = 'r1', claimed_until = now() + interval '2 minutes' where id = $1")
        .bind(leased)
        .execute(&admin)
        .await
        .unwrap();
    assert_eq!(ids(&admin, &agent, WAKE_UNLEASED).await, vec![open]);
    assert_eq!(ids(&admin, &agent, WAKE).await, vec![open, leased]);

    // 읽음(`inbox.read` 가 받는 것은 같은 id)은 inbox 줄과 깨움을 같이 닫는다 — 어느 갈래에서도 다시 나오지 않는다.
    assert_eq!(read_close(&w, &agent, &[open]).await.unwrap(), 1);
    assert_eq!(ids(&admin, &agent, WAKE).await, vec![leased]);
    let state: String = sqlx::query_scalar("select state from wake where inbox_id = $1")
        .bind(open)
        .fetch_one(&admin)
        .await
        .unwrap();
    assert_eq!(state, "done");
    // 남의 id 를 읽음으로 넘겨도 아무것도 바뀌지 않는다.
    assert_eq!(read_close(&w, &agent, &[theirs]).await.unwrap(), 0);
    assert_eq!(ids(&admin, &other, WAKE).await, vec![theirs]);
}
