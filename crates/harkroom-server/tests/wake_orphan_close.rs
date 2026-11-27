//! 옛 열린 깨움 행 일회성 정리(마이그레이션 204)를 실제 Postgres 로 본다 — 대상 줄만 닫히고 나머지는 그대로인지.
//! `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛴다(CI 는 `scripts/db-tests.sh` 가 넘긴다).
//! 틀 DB 에는 204 가 빈 표 위에서 이미 돌았다. 여기서는 줄을 깐 뒤 **구워진 그 파일 본문**을 다시 돌린다.
use harkroom_server::migrate::MIGRATION_FILES;
use sqlx::PgPool;

const NAME: &str = "204_wake_orphan_close.sql";
/// 파일에 적힌 기준 시각 — 이보다 먼저 생긴 줄만 대상이다.
const CUTOFF: &str = "2026-11-27 13:22:38+00";

fn body() -> &'static str {
    MIGRATION_FILES
        .iter()
        .find(|(n, _)| *n == NAME)
        .map(|(_, s)| *s)
        .expect("204 가 구워져 있다")
}

/// 깨움 행 하나를 넣는다. `at` 은 기준 시각에서의 차이(초, 음수면 먼저), `closed` 면 닫힌 시각을 생긴 시각 + 1분으로 적는다.
async fn wake(
    admin: &PgPool,
    who: &str,
    msg: &str,
    inbox_id: Option<i64>,
    state: &str,
    at: i32,
) -> String {
    sqlx::query_scalar(
        "insert into wake (account_id, message_id, reason, inbox_id, state, created_at, closed_at) \
         select $1::uuid, $2::uuid, 'mention', $3, $4, t.at, \
                case when $4 in ('done', 'canceled') then t.at + interval '1 minute' end \
           from (select $5::timestamptz + make_interval(secs => $6) as at) t \
         returning id::text",
    )
    .bind(who)
    .bind(msg)
    .bind(inbox_id)
    .bind(state)
    .bind(CUTOFF)
    .bind(at)
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

/// (상태, 닫힌 시각 글자)
async fn row(admin: &PgPool, id: &str) -> (String, Option<String>) {
    sqlx::query_as("select state, closed_at::text from wake where id = $1::uuid")
        .bind(id)
        .fetch_one(admin)
        .await
        .unwrap()
}

#[tokio::test]
async fn closes_only_old_open_rows_without_an_inbox_row() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let admin = PgPool::connect(&url).await.unwrap();

    let agent: String = sqlx::query_scalar(
        "insert into account(handle, display_name, kind) values ('woc-agent', 'woc-agent', 'agent') returning id::text",
    )
    .fetch_one(&admin)
    .await
    .unwrap();
    let human: String = sqlx::query_scalar(
        "insert into account(handle, display_name, kind, login_id) values ('woc-human', 'woc-human', 'human', 'woc-human') returning id::text",
    )
    .fetch_one(&admin)
    .await
    .unwrap();
    let ch: String = sqlx::query_scalar(
        "insert into channel(name, kind) values ('woc-rs', 'standard') returning id::text",
    )
    .fetch_one(&admin)
    .await
    .unwrap();
    let msg: String = sqlx::query_scalar(
        "insert into message(channel_id, author_id, body, kind) values ($1::uuid, $2::uuid, 'x', 'user') returning id::text",
    )
    .bind(&ch)
    .bind(&human)
    .fetch_one(&admin)
    .await
    .unwrap();

    // 대상: 열림 + inbox 줄 없음 + 기준 시각 이전.
    let gone = inbox(&admin, &agent, &msg).await;
    let dangling = wake(&admin, &agent, &msg, Some(gone), "pending", -3600).await;
    sqlx::query("delete from inbox where id = $1")
        .bind(gone)
        .execute(&admin)
        .await
        .unwrap();
    let no_id = wake(&admin, &agent, &msg, None, "delivered", -1).await;

    // 그대로: inbox 줄이 있는 열린 줄(이전).
    let kept_inbox = inbox(&admin, &agent, &msg).await;
    let with_inbox = wake(&admin, &agent, &msg, Some(kept_inbox), "pending", -3600).await;
    // 그대로: 기준 시각 정각·그 뒤에 생긴 inbox 없는 열린 줄.
    let at_cutoff = wake(&admin, &agent, &msg, None, "pending", 0).await;
    let after = wake(&admin, &agent, &msg, None, "delivered", 3600).await;
    // 그대로: 이미 닫힌 줄(이전, inbox 없음) — 상태도 닫힌 시각도 안 바뀐다.
    let done = wake(&admin, &agent, &msg, None, "done", -3600).await;
    let canceled = wake(&admin, &agent, &msg, None, "canceled", -3600).await;

    let mut before = Vec::new();
    for id in [&with_inbox, &at_cutoff, &after, &done, &canceled] {
        before.push(row(&admin, id).await);
    }
    assert_eq!(row(&admin, &dangling).await, ("pending".into(), None));
    assert_eq!(row(&admin, &no_id).await, ("delivered".into(), None));

    sqlx::raw_sql(sqlx::AssertSqlSafe(body()))
        .execute(&admin)
        .await
        .unwrap();

    for id in [&dangling, &no_id] {
        let (state, closed) = row(&admin, id).await;
        assert_eq!(state, "canceled", "{id}");
        assert!(closed.is_some(), "{id}");
    }
    let mut now = Vec::new();
    for id in [&with_inbox, &at_cutoff, &after, &done, &canceled] {
        now.push(row(&admin, id).await);
    }
    assert_eq!(now, before);
    assert_eq!(
        now.iter().map(|r| r.0.as_str()).collect::<Vec<_>>(),
        ["pending", "pending", "delivered", "done", "canceled"]
    );
    // 줄은 지워지지 않는다.
    let total: i64 = sqlx::query_scalar("select count(*) from wake where account_id = $1::uuid")
        .bind(&agent)
        .fetch_one(&admin)
        .await
        .unwrap();
    assert_eq!(total, 7);

    // 다시 돌려도 바뀌는 것이 없다 — 먼저 닫은 줄의 닫힌 시각도 그대로다.
    let first = [row(&admin, &dangling).await, row(&admin, &no_id).await];
    sqlx::raw_sql(sqlx::AssertSqlSafe(body()))
        .execute(&admin)
        .await
        .unwrap();
    assert_eq!(
        [row(&admin, &dangling).await, row(&admin, &no_id).await],
        first
    );
    for (i, id) in [&with_inbox, &at_cutoff, &after, &done, &canceled]
        .into_iter()
        .enumerate()
    {
        assert_eq!(row(&admin, id).await, before[i]);
    }
}
