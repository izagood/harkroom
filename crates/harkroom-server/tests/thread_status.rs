//! 스레드 상태 이모지 감시(`loops::thread_status`, P5)를 실제 Postgres 로 본다 — TS `refreshThreadStatus` 와 같은 행·이벤트인지.
//! `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛴다.
use harkroom_server::loops::thread_status::refresh;
use sqlx::PgPool;

async fn id(admin: &PgPool, sql: &'static str, bind: &str) -> String {
    sqlx::query_scalar(sql)
        .bind(bind)
        .fetch_one(admin)
        .await
        .unwrap()
}

async fn say(admin: &PgPool, ch: &str, root: Option<&str>, author: &str, kind: &str) -> String {
    sqlx::query_scalar(
        "insert into message(channel_id, thread_root_id, author_id, body, kind, meta) \
         values ($1::uuid, $2::uuid, $3::uuid, 'x', $4, '{}') returning id::text",
    )
    .bind(ch)
    .bind(root)
    .bind(author)
    .bind(kind)
    .fetch_one(admin)
    .await
    .unwrap()
}

async fn row(admin: &PgPool, root: &str) -> Option<(String, String, Option<String>)> {
    sqlx::query_as(
        "select status, emoji, account_id::text from thread_status where root_id = $1::uuid",
    )
    .bind(root)
    .fetch_optional(admin)
    .await
    .unwrap()
}

async fn status_reactions(admin: &PgPool, root: &str) -> Vec<(String, String)> {
    sqlx::query_as(
        "select account_id::text, emoji from message_reaction where message_id = $1::uuid and source = 'status' order by emoji",
    )
    .bind(root)
    .fetch_all(admin)
    .await
    .unwrap()
}

async fn status_events(admin: &PgPool, root: &str) -> i64 {
    sqlx::query_scalar(
        "select count(*) from event_outbox where event->>'type' = 'thread.status' and event->>'rootId' = $1",
    )
    .bind(root)
    .fetch_one(admin)
    .await
    .unwrap()
}

#[tokio::test]
async fn thread_status_like_ts() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let admin = PgPool::connect(&url).await.unwrap();
    // 감시는 `THREAD_STATUS_PRIVILEGES` 만 가진 역할로 쓴다(rustFrontDb.test.ts 가 넘긴다 — 없으면 관리 연결).
    let w = match std::env::var("HARKROOM_TEST_WRITE_DATABASE_URL") {
        Ok(u) => PgPool::connect(&u).await.unwrap(),
        Err(_) => admin.clone(),
    };
    let human = id(&admin, "insert into account(handle, display_name, kind, login_id) values ($1, $1, 'human', $1) returning id::text", "ts_rs_human").await;
    let agent = id(&admin, "insert into account(handle, display_name, kind) values ($1, $1, 'agent') returning id::text", "ts_rs_agent").await;
    let ch = id(
        &admin,
        "insert into channel(name, kind) values ($1, 'standard') returning id::text",
        "thread-status-rs",
    )
    .await;

    // 에이전트가 끼지 않은 스레드 — 상태가 없다(행·리액션·이벤트 없음).
    let quiet = say(&admin, &ch, None, &human, "user").await;
    assert_eq!(refresh(&w, &quiet).await.unwrap(), None);
    assert_eq!(row(&admin, &quiet).await, None);

    // 사람이 에이전트를 불렀다 → 👀(그 에이전트 이름).
    let root = say(&admin, &ch, None, &human, "user").await;
    sqlx::query(
        "insert into inbox(account_id, message_id, reason) values ($1::uuid, $2::uuid, 'mention')",
    )
    .bind(&agent)
    .bind(&root)
    .execute(&admin)
    .await
    .unwrap();
    let got = refresh(&w, &root)
        .await
        .unwrap()
        .expect("changed")
        .expect("set");
    assert_eq!(got["status"], "received");
    assert_eq!(got["emoji"], "👀");
    assert!(got["updatedAt"].as_str().unwrap().ends_with('Z'));
    assert_eq!(
        row(&admin, &root).await,
        Some(("received".into(), "👀".into(), Some(agent.clone())))
    );
    assert_eq!(
        status_reactions(&admin, &root).await,
        vec![(agent.clone(), "👀".to_string())]
    );
    assert_eq!(status_events(&admin, &root).await, 1);

    // 같은 사실로 다시 → 안 바뀜, 이벤트도 없다.
    assert_eq!(refresh(&w, &root).await.unwrap(), None);
    assert_eq!(status_events(&admin, &root).await, 1);

    // 살아 있는 에이전트의 진행 → 💬, 리액션은 갈아 끼운다.
    sqlx::query("insert into agent_presence(account_id, expires_at) values ($1::uuid, now() + interval '30 seconds')")
        .bind(&agent).execute(&admin).await.unwrap();
    say(&admin, &ch, Some(&root), &agent, "progress").await;
    refresh(&w, &root).await.unwrap().expect("changed");
    assert_eq!(row(&admin, &root).await.unwrap().0, "running");
    assert_eq!(
        status_reactions(&admin, &root).await,
        vec![(agent.clone(), "💬".to_string())]
    );

    // 러너가 죽었다(presence 만료) → 🚨.
    sqlx::query("update agent_presence set expires_at = now() - interval '1 second' where account_id = $1::uuid")
        .bind(&agent).execute(&admin).await.unwrap();
    refresh(&w, &root).await.unwrap().expect("changed");
    assert_eq!(row(&admin, &root).await.unwrap().0, "stuck");

    // 사람이 손으로 ✅ 를 먼저 달아 둔 뒤 에이전트가 답했다 → ✅ 상태, 손 리액션은 그대로 두고 상태 행은 새로 생기지 않는다(on conflict).
    sqlx::query("insert into message_reaction(message_id, account_id, emoji, source) values ($1::uuid, $2::uuid, '✅', 'user')")
        .bind(&root).bind(&agent).execute(&admin).await.unwrap();
    say(&admin, &ch, Some(&root), &agent, "user").await;
    refresh(&w, &root).await.unwrap().expect("changed");
    assert_eq!(row(&admin, &root).await.unwrap().0, "done");
    assert!(status_reactions(&admin, &root).await.is_empty());
    let user_rx: i64 = sqlx::query_scalar(
        "select count(*) from message_reaction where message_id = $1::uuid and source = 'user'",
    )
    .bind(&root)
    .fetch_one(&admin)
    .await
    .unwrap();
    assert_eq!(user_rx, 1);
}
