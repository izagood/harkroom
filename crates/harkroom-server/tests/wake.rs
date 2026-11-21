//! 예약 깨움 sweep(`loops::wake`)이 TS `agentWakes.ts::fireOneDue` 와 같은 일을 하는지 실제 Postgres 로 본다.
//! `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛴다(CI 는 `scripts/db-tests.sh` 가 넘긴다).
//! - `HARKROOM_TEST_WRITE_DATABASE_URL` 이 있으면 sweep 은 그 역할(`WAKE_PRIVILEGES` 만 가진 쓰기 역할)로 돈다.
//! - `HARKROOM_WAKE_DUAL=1` 이면 이중 실행 모드 — TS 가 깔아 둔 깨움을 TS sweep 과 **동시에** 쓸어 띄운 수만 찍는다(판정은 TS 쪽).
use harkroom_server::loops::wake::{WAKE_PRIVILEGES, WAKE_SEQUENCE_PRIVILEGES, sweep};
use sqlx::PgPool;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use std::str::FromStr;

async fn due_left(pool: &PgPool) -> i64 {
    sqlx::query_scalar(
        "select count(*) from agent_wake where wake_at <= now() and fired_at is null and canceled_at is null",
    )
    .fetch_one(pool)
    .await
    .unwrap()
}

#[tokio::test]
async fn wake_sweep_like_ts() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let write_url =
        std::env::var("HARKROOM_TEST_WRITE_DATABASE_URL").unwrap_or_else(|_| url.clone());
    let admin = PgPool::connect(&url).await.unwrap();
    let opts = PgConnectOptions::from_str(&write_url)
        .unwrap()
        .application_name("harkroom-wake-dual");
    let w = PgPoolOptions::new()
        .max_connections(3)
        .connect_with(opts)
        .await
        .unwrap();
    let missing = harkroom_server::write::missing_in(&w, WAKE_PRIVILEGES, WAKE_SEQUENCE_PRIVILEGES)
        .await
        .unwrap();
    assert!(missing.is_empty(), "write role lacks {missing:?}");

    if std::env::var("HARKROOM_WAKE_DUAL").is_ok() {
        // TS 가 이 연결(application_name)을 보고 자기 sweep 을 시작한다 — 겹치도록 잠깐 기다린다.
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        let mut fired = 0;
        loop {
            let n = sweep(&w).await.unwrap();
            fired += n;
            if n == 0 && due_left(&admin).await == 0 {
                break;
            }
        }
        println!("wake-dual rust fired {fired}");
        return;
    }

    let agent: String = sqlx::query_scalar(
        "insert into account(handle, display_name, kind) values ('wake_rs', 'wake_rs', 'agent') returning id::text",
    )
    .fetch_one(&admin)
    .await
    .unwrap();
    let channel: String = sqlx::query_scalar(
        "insert into channel(name, kind) values ('wake-rs', 'standard') returning id::text",
    )
    .fetch_one(&admin)
    .await
    .unwrap();
    let report = serde_json::json!({ "channelId": channel, "threadRootId": channel });
    // (사유, 깨울 때(지금부터 초), meta.wake, 취소?) — 둘은 시각이 됐고(하나는 보고처), 하나는 아직, 하나는 취소됨.
    let cases = [
        (
            "due-report",
            -60i32,
            serde_json::json!({ "reportTo": report }),
            false,
        ),
        ("due-plain", -120i32, serde_json::json!({}), false),
        ("future", 3600i32, serde_json::json!({}), false),
        ("canceled", -60i32, serde_json::json!({}), true),
    ];
    let mut ids = vec![];
    for (body, at, meta, canceled) in &cases {
        let m: String = sqlx::query_scalar(
            "insert into message(channel_id, author_id, body, kind, meta) \
             values ($1::uuid, $2::uuid, $3, 'wake', jsonb_build_object('wake', $4::jsonb)) returning id::text",
        )
        .bind(&channel)
        .bind(&agent)
        .bind(body)
        .bind(meta.to_string())
        .fetch_one(&admin)
        .await
        .unwrap();
        sqlx::query(
            "insert into agent_wake(account_id, channel_id, message_id, wake_at, canceled_at) \
             values ($1::uuid, $2::uuid, $3::uuid, now() + make_interval(secs => $5), case when $4 then now() end)",
        )
        .bind(&agent)
        .bind(&channel)
        .bind(&m)
        .bind(canceled)
        .bind(f64::from(*at))
        .execute(&admin)
        .await
        .unwrap();
        ids.push(m);
    }
    let outbox0: i64 = sqlx::query_scalar("select coalesce(max(id), 0) from event_outbox")
        .fetch_one(&admin)
        .await
        .unwrap();

    assert_eq!(sweep(&w).await.unwrap(), 2);
    assert_eq!(sweep(&w).await.unwrap(), 0, "한 깨움은 한 번만");

    let inbox: Vec<(String, String)> = sqlx::query_as(
        "select message_id::text, reason from inbox where account_id = $1::uuid order by id",
    )
    .bind(&agent)
    .fetch_all(&admin)
    .await
    .unwrap();
    // 오래된 것(wake_at 이른 것)부터 뜬다 — TS `order by wake_at`.
    assert_eq!(
        inbox,
        vec![
            (ids[1].clone(), "wake".into()),
            (ids[0].clone(), "wake".into())
        ]
    );
    for (i, m) in ids.iter().enumerate() {
        let (fired, stamp): (bool, Option<String>) = sqlx::query_as(
            "select w.fired_at is not null, m.meta->'wake'->>'firedAt' from agent_wake w join message m on m.id = w.message_id \
              where w.message_id = $1::uuid",
        )
        .bind(m)
        .fetch_one(&admin)
        .await
        .unwrap();
        assert_eq!(fired, i < 2, "case {i}");
        assert_eq!(stamp.is_some(), i < 2, "case {i}");
        if let Some(s) = stamp {
            // TS `new Date().toISOString()` 꼴.
            assert!(s.len() == 24 && s.ends_with('Z'), "{s}");
        }
    }
    let events: Vec<String> =
        sqlx::query_scalar("select event->>'type' from event_outbox where id > $1 order by id")
            .bind(outbox0)
            .fetch_all(&admin)
            .await
            .unwrap();
    assert_eq!(
        events,
        [
            "message.updated",
            "inbox.updated",
            "message.updated",
            "thread.reportWakes.changed",
            "inbox.updated"
        ]
    );
    let signal: String = sqlx::query_scalar(
        "select event::text from event_outbox where id > $1 and event->>'type' = 'thread.reportWakes.changed'",
    )
    .bind(outbox0)
    .fetch_one(&admin)
    .await
    .unwrap();
    let signal: serde_json::Value = serde_json::from_str(&signal).unwrap();
    assert_eq!(signal["channelId"], channel.as_str());
    assert_eq!(signal["rootId"], channel.as_str());
    assert_eq!(signal["audience"], "all");
    assert!(
        signal.get("reason").is_none(),
        "보고처 신호에 값을 싣지 않는다"
    );
    let updated: String = sqlx::query_scalar(
        "select event::text from event_outbox where id > $1 and event->>'type' = 'message.updated' order by id limit 1",
    )
    .bind(outbox0)
    .fetch_one(&admin)
    .await
    .unwrap();
    let updated: serde_json::Value = serde_json::from_str(&updated).unwrap();
    assert_eq!(updated["message"]["id"], ids[1].as_str());
    assert!(updated["message"]["meta"]["wake"]["firedAt"].is_string());
}
