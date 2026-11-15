//! 백그라운드 회차 생산(`loops::bg_produce`)이 TS `bgJobs.ts` 의 `enqueueBgJob`·`produceDistillJobs` 와 같은 일을 하는지 실제 Postgres 로 본다.
//! `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛴다(CI 는 `packages/server/test/rustFrontDb.test.ts` 가 넘긴다).
//! - `HARKROOM_TEST_WRITE_DATABASE_URL` 이 있으면 넣기는 그 역할(`BG_PRODUCE_PRIVILEGES` 만 가진 쓰기 역할)로 돈다.
//! - `HARKROOM_BG_PRODUCE_ONLY` 가 있으면 대조 모드 — TS 가 깔아 둔 시드에 증류 생산만 한 번 돌리고 끝난다(판정은 TS 쪽).
use harkroom_server::loops::bg_produce::{
    BG_PRODUCE_PRIVILEGES, Enqueue, Producer, Tick, enqueue, produce_distill,
};
use serde_json::json;
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;

/// 창 안(KST 4시)으로 고정한 이번 tick — 날짜·「24시간 전」은 DB `now()` 그대로다.
async fn tick_in_window(pool: &PgPool) -> Tick {
    let mut t = Tick::read(pool).await.unwrap();
    t.kst_hour = 4;
    t
}

async fn agent(admin: &PgPool, handle: &str, config: bool) -> String {
    let id: String = sqlx::query_scalar(
        "insert into account(handle, display_name, kind) values ($1, $1, 'agent') returning id::text",
    )
    .bind(handle)
    .fetch_one(admin)
    .await
    .unwrap();
    if config {
        sqlx::query(
            "insert into agent_config (account_id, bg_enabled, harness) values ($1::uuid, true, 'claude-code') \
             on conflict (account_id) do update set bg_enabled = true, harness = 'claude-code'",
        )
        .bind(&id)
        .execute(admin)
        .await
        .unwrap();
    } else {
        sqlx::query("delete from agent_config where account_id = $1::uuid")
            .bind(&id)
            .execute(admin)
            .await
            .unwrap();
    }
    id
}

/// 공개 채널에 그 에이전트의 루트 글 + 메모 + done(25시간 전).
async fn done_thread_with_note(admin: &PgPool, account: &str) -> String {
    let ch: String = sqlx::query_scalar(
        "insert into channel(name, kind, visibility) values ('bgp-' || gen_random_uuid(), 'standard', 'public') returning id::text",
    )
    .fetch_one(admin)
    .await
    .unwrap();
    let root: String = sqlx::query_scalar(
        "insert into message(channel_id, author_id, body, kind) values ($1::uuid, $2::uuid, '보고', 'user') returning id::text",
    )
    .bind(&ch)
    .bind(account)
    .fetch_one(admin)
    .await
    .unwrap();
    sqlx::query("insert into thread_note (account_id, thread_root_id, body) values ($1::uuid, $2::uuid, '메모')")
        .bind(account)
        .bind(&root)
        .execute(admin)
        .await
        .unwrap();
    sqlx::query(
        "insert into thread_status (root_id, status, emoji, account_id, updated_at) \
         values ($1::uuid, 'done', '✅', $2::uuid, now() - interval '25 hours')",
    )
    .bind(&root)
    .bind(account)
    .execute(admin)
    .await
    .unwrap();
    root
}

async fn jobs(admin: &PgPool, account: &str) -> Vec<(String, String, serde_json::Value)> {
    sqlx::query_as(
        "select kind, day::text, input from bg_job where account_id = $1::uuid order by kind, day",
    )
    .bind(account)
    .fetch_all(admin)
    .await
    .unwrap()
}

#[tokio::test]
async fn bg_produce_like_ts() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let write_url =
        std::env::var("HARKROOM_TEST_WRITE_DATABASE_URL").unwrap_or_else(|_| url.clone());
    let admin = PgPool::connect(&url).await.unwrap();
    let w = PgPoolOptions::new()
        .max_connections(3)
        .connect(&write_url)
        .await
        .unwrap();
    let missing = harkroom_server::write::missing_in(&w, BG_PRODUCE_PRIVILEGES, &[])
        .await
        .unwrap();
    assert!(missing.is_empty(), "write role lacks {missing:?}");

    if std::env::var("HARKROOM_BG_PRODUCE_ONLY").is_ok() {
        let tick = tick_in_window(&w).await;
        let r = produce_distill(&w, &tick, true, 50).await.unwrap();
        println!("bg-produce rust queued {} day {}", r.queued, tick.day);
        return;
    }

    // 넣기 — 메모 있는 done 25시간 스레드 하나가 그날 증류 회차 하나가 된다.
    let a = agent(&admin, "bgp_a", true).await;
    let root = done_thread_with_note(&admin, &a).await;
    let tick = tick_in_window(&w).await;
    let first = produce_distill(&w, &tick, true, 50).await.unwrap();
    assert_eq!(first.queued, 1, "{first:?}");
    let rows = jobs(&admin, &a).await;
    assert_eq!(
        rows,
        vec![(
            "distill".to_string(),
            tick.day.clone(),
            json!({ "threadIds": [root] })
        )]
    );

    // 재기동·주인 교체 — 새 프로세스의 생산자는 첫 tick 에 바로 돈다. 같은 날 두 번째 생산은 `exists` 로 돌아가고 줄 수는 같다.
    let mut fresh = Producer::default();
    assert!(fresh.due(&tick));
    let second = produce_distill(&w, &tick, true, 50).await.unwrap();
    assert_eq!(second.queued, 0, "{second:?}");
    assert_eq!(second.refused.get("exists"), Some(&1), "{second:?}");
    assert_eq!(jobs(&admin, &a).await, rows);

    // 창 — KST 7시부터는 넣지 않는다(질의도 안 한다).
    let b = agent(&admin, "bgp_b", true).await;
    done_thread_with_note(&admin, &b).await;
    let mut late = tick.clone();
    late.kst_hour = 7;
    assert_eq!(
        produce_distill(&w, &late, true, 50).await.unwrap().queued,
        0
    );
    // 스위치 꺼짐도 넣지 않는다.
    assert_eq!(
        produce_distill(&w, &tick, false, 50).await.unwrap().queued,
        0
    );
    assert!(jobs(&admin, &b).await.is_empty());

    // 하루 상한 — 오늘 이미 있는 줄 수가 상한이면 daily_cap.
    let used: i64 = sqlx::query_scalar("select count(*) from bg_job where day = $1::date")
        .bind(&tick.day)
        .fetch_one(&admin)
        .await
        .unwrap();
    assert_eq!(
        enqueue(&w, &b, "cleanup", &json!({}), &tick.day, used)
            .await
            .unwrap(),
        Enqueue::Refused("daily_cap")
    );
    assert!(matches!(
        enqueue(&w, &b, "cleanup", &json!({}), &tick.day, used + 1)
            .await
            .unwrap(),
        Enqueue::Queued(_)
    ));

    // 멈춤 — 최근 결말 3개가 모두 failed.
    let c = agent(&admin, "bgp_c", true).await;
    sqlx::query(
        "insert into bg_job (account_id, kind, day, status, created_at) \
         select $1::uuid, 'organize', current_date - g, 'failed', now() - g * interval '1 day' from generate_series(1, 3) g",
    )
    .bind(&c)
    .execute(&admin)
    .await
    .unwrap();
    assert_eq!(
        enqueue(&w, &c, "organize", &json!({}), &tick.day, 1000)
            .await
            .unwrap(),
        Enqueue::Refused("paused")
    );
    // 가장 최근 하나가 done 이면 다시 넣는다.
    sqlx::query(
        "update bg_job set status = 'done' where id = (select id from bg_job where account_id = $1::uuid order by created_at desc limit 1)",
    )
    .bind(&c)
    .execute(&admin)
    .await
    .unwrap();
    assert!(matches!(
        enqueue(&w, &c, "organize", &json!({}), &tick.day, 1000)
            .await
            .unwrap(),
        Enqueue::Queued(_)
    ));

    // 토글 — agent_config 줄이 없거나 bg_enabled 가 꺼져 있으면 agent_off.
    let d = agent(&admin, "bgp_d", false).await;
    assert_eq!(
        enqueue(&w, &d, "cleanup", &json!({}), &tick.day, 1000)
            .await
            .unwrap(),
        Enqueue::Refused("agent_off")
    );
    sqlx::query("insert into agent_config (account_id, bg_enabled) values ($1::uuid, false)")
        .bind(&d)
        .execute(&admin)
        .await
        .unwrap();
    assert_eq!(
        enqueue(&w, &d, "cleanup", &json!({}), &tick.day, 1000)
            .await
            .unwrap(),
        Enqueue::Refused("agent_off")
    );
}
