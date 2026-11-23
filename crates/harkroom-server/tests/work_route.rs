//! 글 → 작업 라우팅(`core::work_route`, B2 그림자)을 실제 Postgres 로 본다 — 새 작업 → 기존 작업 → 되풀이해도 그대로.
//! 쓰기는 `WORK_GRANTS` 만 가진 역할로 한다(`scripts/db-tests.sh` 가 넘긴다 — 없으면 관리 연결).
//! `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛴다.
use harkroom_server::core::work::set_state;
use harkroom_server::core::work_route::{Decision, EVENT_ROUTED, route_with};
use sqlx::PgPool;

async fn id(admin: &PgPool, sql: &'static str, binds: &[&str]) -> String {
    let mut q = sqlx::query_scalar::<_, String>(sql);
    for b in binds {
        q = q.bind(*b);
    }
    q.fetch_one(admin).await.unwrap()
}

/// (작업 수, 라우팅 사건 수) — 그 스레드 전체.
async fn counts(admin: &PgPool, thread: &str) -> (i64, i64) {
    sqlx::query_as(
        "select (select count(*) from work where thread_root_id = $1::uuid), \
                (select count(*) from work_event e join work w on w.id = e.work_id \
                  where w.thread_root_id = $1::uuid and e.kind = $2)",
    )
    .bind(thread)
    .bind(EVENT_ROUTED)
    .fetch_one(admin)
    .await
    .unwrap()
}

#[tokio::test]
async fn routes_new_then_existing_and_is_idempotent() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let admin = PgPool::connect(&url).await.unwrap();
    let w = match std::env::var("HARKROOM_TEST_WRITE_DATABASE_URL") {
        Ok(u) => PgPool::connect(&u).await.unwrap(),
        Err(_) => admin.clone(),
    };
    let human = id(&admin, "insert into account(handle, display_name, kind, login_id) values ($1, $1, 'human', $1) returning id::text", &["route_rs_human"]).await;
    const AGENT: &str = "insert into account(handle, display_name, kind) values ($1, $1, 'agent') returning id::text";
    let agent = id(&admin, AGENT, &["route_rs_agent"]).await;
    let other = id(&admin, AGENT, &["route_rs_other"]).await;
    let ch = id(
        &admin,
        "insert into channel(name, kind, visibility, created_by) values ($1, 'standard', 'private', $2::uuid) returning id::text",
        &["route-rs", &human],
    )
    .await;
    const ROOT: &str = "insert into message(channel_id, author_id, body, kind, meta) \
         values ($1::uuid, $2::uuid, 'secret body text', 'user', $3::jsonb) returning id::text";
    const REPLY: &str = "insert into message(channel_id, author_id, body, kind, meta, thread_root_id) \
         values ($1::uuid, $2::uuid, 'secret body text', 'user', '{}', $3::uuid) returning id::text";
    let root_msg = id(&admin, ROOT, &[&ch, &human, "{}"]).await;
    // 받은 계정에 사람이 섞여 있어도 에이전트만 라우팅한다.
    let both = vec![human.clone(), agent.clone()];

    // 1. 뿌리 글 — 열린 작업이 없어 새 뿌리 작업. 뿌리 글은 자기 자신이 스레드 뿌리다.
    let made = route_with(&w, &root_msg, &both).await.unwrap();
    assert_eq!(made.len(), 1);
    assert_eq!(made[0].1, Decision::New);
    let first = made[0].0.clone();
    type Row = (
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        String,
        String,
        String,
        String,
        bool,
    );
    let row: Row = sqlx::query_as(
        "select thread_root_id::text, source_message_id::text, assignee_account_id::text, requester_account_id::text, \
                state, title, body, channel_id::text, parent_id is null and root_id = id from work where id = $1::uuid",
    )
    .bind(&first)
    .fetch_one(&admin)
    .await
    .unwrap();
    assert_eq!(row.0, root_msg);
    assert_eq!(row.1.as_deref(), Some(root_msg.as_str()));
    assert_eq!(row.2.as_deref(), Some(agent.as_str()));
    assert_eq!(row.3.as_deref(), Some(human.as_str()));
    assert_eq!(row.4, "open");
    // 본문을 작업 행에 베끼지 않는다.
    assert_eq!((row.5.as_str(), row.6.as_str()), ("", ""));
    assert_eq!(row.7, ch);
    assert!(row.8);
    let (actor, payload): (Option<String>, String) = sqlx::query_as(
        "select actor_account_id::text, payload::text from work_event where work_id = $1::uuid and kind = $2",
    )
    .bind(&first)
    .bind(EVENT_ROUTED)
    .fetch_one(&admin)
    .await
    .unwrap();
    assert_eq!(actor.as_deref(), Some(human.as_str()));
    let payload: serde_json::Value = serde_json::from_str(&payload).unwrap();
    assert_eq!(
        payload,
        serde_json::json!({ "messageId": root_msg, "decision": "new" })
    );
    assert_eq!(counts(&admin, &root_msg).await, (1, 1));

    // 2. 같은 글로 다시 — 아무것도 늘지 않는다.
    assert!(route_with(&w, &root_msg, &both).await.unwrap().is_empty());
    assert_eq!(counts(&admin, &root_msg).await, (1, 1));

    // 3. 답글 — 열린 작업으로 간다. 그 작업의 상태·고친 때는 그대로다.
    let before: (String, String) =
        sqlx::query_as("select state, updated_at::text from work where id = $1::uuid")
            .bind(&first)
            .fetch_one(&admin)
            .await
            .unwrap();
    let reply = id(&admin, REPLY, &[&ch, &human, &root_msg]).await;
    let made = route_with(&w, &reply, &both).await.unwrap();
    assert_eq!(
        made,
        vec![(first.clone(), Decision::Existing(first.clone()))]
    );
    assert_eq!(counts(&admin, &root_msg).await, (1, 2));
    let after: (String, String) =
        sqlx::query_as("select state, updated_at::text from work where id = $1::uuid")
            .bind(&first)
            .fetch_one(&admin)
            .await
            .unwrap();
    assert_eq!(before, after);

    // 4. 되풀이 — 그대로.
    assert!(route_with(&w, &reply, &both).await.unwrap().is_empty());
    assert_eq!(counts(&admin, &root_msg).await, (1, 2));

    // 5. 다른 에이전트는 자기 작업이 따로 생긴다(같은 스레드여도 남의 작업으로 가지 않는다).
    let made = route_with(&w, &reply, std::slice::from_ref(&other))
        .await
        .unwrap();
    assert_eq!(made.len(), 1);
    assert_eq!(made[0].1, Decision::New);
    assert_ne!(made[0].0, first);
    assert_eq!(counts(&admin, &root_msg).await, (2, 3));

    // 6. 작업이 끝난 뒤의 글은 새 작업이다.
    assert!(set_state(&w, &first, "done", None).await.unwrap());
    let reply2 = id(&admin, REPLY, &[&ch, &human, &root_msg]).await;
    let made = route_with(&w, &reply2, &both).await.unwrap();
    assert_eq!(made.len(), 1);
    assert_eq!(made[0].1, Decision::New);
    assert_ne!(made[0].0, first);
    assert_eq!(counts(&admin, &root_msg).await, (3, 4));

    // 7. 위임 글·사람만 받은 글·없는 글은 건너뛴다.
    let deleg = id(&admin, ROOT, &[&ch, &human, r#"{"kind":"delegation"}"#]).await;
    assert!(route_with(&w, &deleg, &both).await.unwrap().is_empty());
    assert_eq!(counts(&admin, &deleg).await, (0, 0));
    let reply3 = id(&admin, REPLY, &[&ch, &human, &root_msg]).await;
    assert!(
        route_with(&w, &reply3, std::slice::from_ref(&human))
            .await
            .unwrap()
            .is_empty()
    );
    assert!(route_with(&w, &reply3, &[]).await.unwrap().is_empty());
    let gone = "00000000-0000-4000-8000-0000000000ff";
    assert!(route_with(&w, gone, &both).await.unwrap().is_empty());
    assert_eq!(counts(&admin, &root_msg).await, (3, 4));
}
