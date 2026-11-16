//! 답 없는 요청 통지 sweep(`loops::stale`)을 실제 Postgres 로 본다. `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛴다.
use harkroom_server::core::msg_post::PostState;
use harkroom_server::loops::stale::{Opts, STALE_BODY, sweep};
use harkroom_server::proxy::Upstream;
use sqlx::PgPool;
use std::time::Duration;

async fn id(admin: &PgPool, sql: &'static str, bind: &str) -> String {
    sqlx::query_scalar(sql)
        .bind(bind)
        .fetch_one(admin)
        .await
        .unwrap()
}

async fn agent(admin: &PgPool, handle: &str) -> String {
    let a = id(admin, "insert into account(handle, display_name, kind) values ($1, $1, 'agent') returning id::text", handle).await;
    sqlx::query("insert into agent_config(account_id) values ($1::uuid)")
        .bind(&a)
        .execute(admin)
        .await
        .unwrap();
    a
}

/// 사람이 부른 미읽음 하나 — `age` 만큼 지났다.
async fn request(admin: &PgPool, ch: &str, human: &str, to: &str, age: &str) -> String {
    let m: String = sqlx::query_scalar("insert into message(channel_id, author_id, body, kind, meta) values ($1::uuid, $2::uuid, 'hi', 'user', '{}') returning id::text")
        .bind(ch).bind(human).fetch_one(admin).await.unwrap();
    sqlx::query("insert into inbox(account_id, message_id, reason, created_at) values ($1::uuid, $2::uuid, 'mention', now() - $3::interval)")
        .bind(to).bind(&m).bind(age).execute(admin).await.unwrap();
    m
}

async fn notices(admin: &PgPool, root: &str) -> i64 {
    sqlx::query_scalar("select count(*) from message where thread_root_id = $1::uuid and body = $2 and meta->>'kind' = 'failure'")
        .bind(root).bind(STALE_BODY).fetch_one(admin).await.unwrap()
}

async fn marked(admin: &PgPool, root: &str) -> bool {
    sqlx::query_scalar(
        "select stale_notified_at is not null from inbox where message_id = $1::uuid",
    )
    .bind(root)
    .fetch_one(admin)
    .await
    .unwrap()
}

#[tokio::test]
async fn stale_sweep_like_ts() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let admin = PgPool::connect(&url).await.unwrap();
    let st = PostState {
        read: admin.clone(),
        write: admin.clone(),
        up: Upstream::new("http://127.0.0.1:1"),
        implicit_ok: false,
    };
    let opts = Opts {
        stale_after: Duration::from_secs(120),
        offline_grace: Duration::from_secs(90),
    };
    let human = id(&admin, "insert into account(handle, display_name, kind, login_id) values ($1, $1, 'human', $1) returning id::text", "st_human").await;
    let dead = agent(&admin, "st_dead").await;
    let live = agent(&admin, "st_live").await;
    let swap = agent(&admin, "st_swap").await;
    let ch = id(
        &admin,
        "insert into channel(name, kind) values ($1, 'standard') returning id::text",
        "stale-rs",
    )
    .await;
    // 줄 없음(한 번도 못 봄) → 말한다. 온라인 → 말하지 않는다. 방금 오프라인(교대 중) → 기다린다.
    sqlx::query("insert into agent_presence(account_id, expires_at) values ($1::uuid, now() + interval '30 seconds'), ($2::uuid, now() - interval '10 seconds')")
        .bind(&live).bind(&swap).execute(&admin).await.unwrap();
    let stale = request(&admin, &ch, &human, &dead, "5 minutes").await;
    let fresh = request(&admin, &ch, &human, &dead, "10 seconds").await;
    let online = request(&admin, &ch, &human, &live, "5 minutes").await;
    let swapping = request(&admin, &ch, &human, &swap, "5 minutes").await;

    // 겹친 tick 둘 — 한 묶음은 한 번만 말한다.
    let (a, b) = tokio::join!(sweep(&st, opts), sweep(&st, opts));
    assert_eq!(a.unwrap() + b.unwrap(), 1);
    assert_eq!(notices(&admin, &stale).await, 1);
    assert!(marked(&admin, &stale).await);
    let author: String =
        sqlx::query_scalar("select author_id::text from message where thread_root_id = $1::uuid")
            .bind(&stale)
            .fetch_one(&admin)
            .await
            .unwrap();
    assert_eq!(author, dead, "저자는 그 에이전트다");
    for m in [&fresh, &online, &swapping] {
        assert_eq!(notices(&admin, m).await, 0);
        assert!(!marked(&admin, m).await);
    }
    // 다시 돌아도 같다.
    assert_eq!(sweep(&st, opts).await.unwrap(), 0);
    assert_eq!(notices(&admin, &stale).await, 1);
    // 교대 유예가 지나면 말한다.
    sqlx::query("update agent_presence set expires_at = now() - interval '2 minutes' where account_id = $1::uuid").bind(&swap).execute(&admin).await.unwrap();
    assert_eq!(sweep(&st, opts).await.unwrap(), 1);
    assert_eq!(notices(&admin, &swapping).await, 1);
}
