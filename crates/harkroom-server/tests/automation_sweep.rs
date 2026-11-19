//! 자동화 sweep(`loops::automation`)이 TS `automations.ts` 의 `deliverOne`·`fireOneSchedule` 과 같은 일을 하는지 실제 Postgres 로 본다.
//! `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛴다(CI 는 `packages/server/test/rustFrontDb.test.ts` 가 넘긴다).
use harkroom_server::core::msg_post::PostState;
use harkroom_server::loops::automation::{Delivered, Fired, deliver_one, fire_one_schedule, sweep};
use serde_json::Value;
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;

async fn automation(admin: &PgPool, owner: &str, ch: &str, name: &str, body: &str) -> String {
    sqlx::query_scalar(
        "insert into automation(owner_id, channel_id, name, body, trigger) \
         values ($1::uuid, $2::uuid, $3, $4, '{\"kind\":\"webhook\"}'::jsonb) returning id::text",
    )
    .bind(owner)
    .bind(ch)
    .bind(name)
    .bind(body)
    .fetch_one(admin)
    .await
    .unwrap()
}

async fn run(
    admin: &PgPool,
    auto: &str,
    key: &str,
    vars: Value,
    chain_depth: Option<i32>,
    age: &str,
) -> String {
    sqlx::query_scalar(
        "insert into automation_run(automation_id, event_key, trigger_kind, payload, chain_depth, created_at) \
         values ($1::uuid, $2, 'webhook', $3::jsonb, $4, now() - $5::interval) returning id::text",
    )
    .bind(auto)
    .bind(key)
    .bind(serde_json::json!({ "vars": vars }).to_string())
    .bind(chain_depth)
    .bind(age)
    .fetch_one(admin)
    .await
    .unwrap()
}

async fn status(admin: &PgPool, id: &str) -> (String, Option<String>, Option<String>) {
    sqlx::query_as("select status, error, message_id::text from automation_run where id = $1::uuid")
        .bind(id)
        .fetch_one(admin)
        .await
        .unwrap()
}

async fn message(admin: &PgPool, id: &str) -> (String, i32, Value) {
    let (body, depth, meta): (String, i32, String) =
        sqlx::query_as("select body, mention_depth, meta::text from message where id = $1::uuid")
            .bind(id)
            .fetch_one(admin)
            .await
            .unwrap();
    (body, depth, serde_json::from_str(&meta).unwrap())
}

#[tokio::test]
async fn automation_sweep_like_ts() {
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
        "insert into account(handle, display_name, kind, login_id) values ('auto_rs', 'auto_rs', 'human', 'auto_rs') returning id::text",
    )
    .fetch_one(&admin)
    .await
    .unwrap();
    sqlx::query("insert into account(handle, display_name, kind) values ('auto_rs_bot', 'auto_rs_bot', 'agent')")
        .execute(&admin)
        .await
        .unwrap();
    let ch: String = sqlx::query_scalar(
        "insert into channel(name, kind, visibility) values ('auto-rs', 'standard', 'public') returning id::text",
    )
    .fetch_one(&admin)
    .await
    .unwrap();
    let arch: String = sqlx::query_scalar(
        "insert into channel(name, kind, visibility, archived_at) values ('auto-rs-arch', 'standard', 'public', now()) returning id::text",
    )
    .fetch_one(&admin)
    .await
    .unwrap();

    // ② URL·글 승인 낱말이 든 본문 — TS sweeper(서비스 `postMessage`)처럼 그대로 나간다(옛 판은 대기로 남겼다).
    let plain = automation(&admin, &me, &ch, "plain", "승인 대기 PR: {{ pr.url }}").await;
    let r_plain = run(
        &admin,
        &plain,
        "e1",
        serde_json::json!({ "pr.url": "https://example.com/pr/1" }),
        None,
        "0 seconds",
    )
    .await;
    // ① 사슬 깊이가 있는 회차(에이전트가 돌린 회차) — 사람 이름 글이라도 사슬의 고리다.
    let chained = automation(&admin, &me, &ch, "chained", "@auto_rs_bot 봐 줘").await;
    let r_deep = run(
        &admin,
        &chained,
        "e2",
        serde_json::json!({}),
        Some(99),
        "0 seconds",
    )
    .await;
    let r_free = run(
        &admin,
        &chained,
        "e3",
        serde_json::json!({}),
        None,
        "0 seconds",
    )
    .await;
    // 삭제·만료·거절.
    let gone = automation(&admin, &me, &ch, "gone", "x").await;
    let r_gone = run(
        &admin,
        &gone,
        "e4",
        serde_json::json!({}),
        None,
        "0 seconds",
    )
    .await;
    sqlx::query("update automation set deleted_at = now() where id = $1::uuid")
        .bind(&gone)
        .execute(&admin)
        .await
        .unwrap();
    let r_old = run(&admin, &plain, "e5", serde_json::json!({}), None, "2 hours").await;
    let archived = automation(&admin, &me, &arch, "archived", "x").await;
    let r_arch = run(
        &admin,
        &archived,
        "e6",
        serde_json::json!({}),
        None,
        "0 seconds",
    )
    .await;

    // 두 sweep 을 동시에 — 행 락 아래서 같은 회차는 한 번만 나간다.
    let (a, b) = tokio::join!(sweep(&pool, &st), sweep(&pool, &st));
    assert_eq!(a.unwrap() + b.unwrap(), 3, "three runs posted exactly once");

    let (s, e, m) = status(&admin, &r_plain).await;
    assert_eq!((s.as_str(), e), ("sent", None));
    let (body, depth, meta) = message(&admin, &m.unwrap()).await;
    assert_eq!(body, "승인 대기 PR: https://example.com/pr/1");
    assert_eq!(depth, 0);
    assert_eq!(meta["automation"]["id"], Value::String(plain.clone()));
    assert_eq!(meta["automation"]["runId"], Value::String(r_plain.clone()));

    // 사슬 깊이 99 — TS `max(scan, chainDepth)` 를 저장하고, `chainBound` 라 사람 글이라도 상한에 막힌다.
    let (s, _, m) = status(&admin, &r_deep).await;
    assert_eq!(s, "sent");
    let (_, depth, meta) = message(&admin, &m.unwrap()).await;
    assert_eq!(depth, 99);
    assert!(
        meta.get("mentionChainCapped").is_some(),
        "chain-bound post is capped: {meta}"
    );
    // 같은 자동화의 사슬 밖 회차 — 사람 글은 막히지 않는다.
    let (s, _, m) = status(&admin, &r_free).await;
    assert_eq!(s, "sent");
    let (_, depth, meta) = message(&admin, &m.unwrap()).await;
    assert_eq!(depth, 0);
    assert!(meta.get("mentionChainCapped").is_none(), "{meta}");

    assert_eq!(
        status(&admin, &r_gone).await,
        ("skipped".into(), Some("automation_deleted".into()), None)
    );
    assert_eq!(
        status(&admin, &r_old).await,
        ("failed".into(), Some("expired".into()), None)
    );
    assert_eq!(
        status(&admin, &r_arch).await,
        ("failed".into(), Some("channel_archived".into()), None)
    );
    let (enabled, reason, fails): (bool, Option<String>, i32) = sqlx::query_as(
        "select enabled, paused_reason, consecutive_failures from automation where id = $1::uuid",
    )
    .bind(&archived)
    .fetch_one(&admin)
    .await
    .unwrap();
    assert_eq!(
        (enabled, reason.as_deref(), fails),
        (false, Some("post_refused:channel_archived"), 1)
    );

    // 대기에 남은 것이 없다(G4) — 다시 돌아도 잡을 것이 없다.
    let pending: i64 = sqlx::query_scalar(
        "select count(*) from automation_run r join automation a on a.id = r.automation_id \
         where a.owner_id = $1::uuid and r.status = 'pending'",
    )
    .bind(&me)
    .fetch_one(&admin)
    .await
    .unwrap();
    assert_eq!(pending, 0);
    assert_eq!(
        deliver_one(&pool, &st, &mut Vec::new(), now_ms())
            .await
            .unwrap(),
        Delivered::None
    );

    // 일정 회차 — 시각이 된 schedule 이 회차 하나가 되고 다음 시각이 앞으로 간다.
    let sched: String = sqlx::query_scalar(
        "insert into automation(owner_id, channel_id, name, body, trigger, next_at) \
         values ($1::uuid, $2::uuid, 'sched', 'tick', '{\"kind\":\"schedule\",\"freq\":\"daily\",\"time\":\"09:00\",\"tz\":\"Asia/Seoul\"}'::jsonb, \
                 now() - interval '1 minute') returning id::text",
    )
    .bind(&me)
    .bind(&ch)
    .fetch_one(&admin)
    .await
    .unwrap();
    let fired = fire_one_schedule(&pool, &mut Vec::new(), now_ms)
        .await
        .unwrap();
    assert!(matches!(fired, Fired::Done(_)), "{fired:?}");
    let (runs, next_future): (i64, bool) = sqlx::query_as(
        "select (select count(*) from automation_run where automation_id = $1::uuid and trigger_kind = 'schedule'), \
                (select next_at > now() from automation where id = $1::uuid)",
    )
    .bind(&sched)
    .fetch_one(&admin)
    .await
    .unwrap();
    assert_eq!((runs, next_future), (1, true));
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}
