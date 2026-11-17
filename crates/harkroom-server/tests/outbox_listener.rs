//! outbox 리스너는 읽기 풀의 연결을 쥐지 않는다(전용 연결) — 풀이 연결 1개뿐이어도 요청이 그 연결을 쓰고, 리스너는 이벤트를 받는다.
//! `HARKROOM_TEST_DATABASE_URL`(TS 마이그레이션이 적용된 DB)이 없으면 건너뛴다(CI 는 bus-e2e 의 `rustFrontDb.test.ts` 가 넘긴다).
use harkroom_server::core::events::{Hub, spawn_outbox_listener};
use serde_json::json;
use std::time::Duration;

#[tokio::test]
async fn listener_does_not_hold_a_pool_connection() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(Duration::from_secs(2))
        .connect(&url)
        .await
        .unwrap();
    let hub = Hub::new();
    let mut rx = hub.subscribe();
    spawn_outbox_listener(pool.clone(), url.clone(), hub.clone());
    let account = "00000000-0000-4000-8000-0000000000aa";
    // 리스너가 붙을 때까지 몇 번 보낸다 — 매번 풀의 하나뿐인 연결을 빌려 넣고 돌려준다(리스너가 쥐고 있으면 여기서 시한 초과).
    let got = tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            {
                let mut conn = pool
                    .acquire()
                    .await
                    .expect("풀의 연결을 리스너가 쥐고 있다");
                harkroom_server::write::emit_event(
                    &mut conn,
                    &json!({ "type": "inbox.updated", "accountId": account }),
                )
                .await
                .unwrap();
            }
            if let Ok(Ok(e)) = tokio::time::timeout(Duration::from_millis(500), rx.recv()).await {
                return e;
            }
        }
    })
    .await
    .expect("리스너가 이벤트를 받지 못했다");
    assert_eq!(got["type"], "inbox.updated");
    // 리스너가 붙은 뒤에도 풀의 연결은 요청 몫이다.
    let held = pool.acquire().await;
    assert!(held.is_ok(), "리스너가 풀의 연결을 쥐고 있다");
}

/// TS 발행(C6-α, `eventBus.ts::PUBLISH_SQL` 과 같은 문장) — insert 와 NOTIFY 를 한 문장으로, TS 채널로.
async fn ts_publish(pool: &sqlx::PgPool, e: &serde_json::Value) {
    sqlx::query(
        "with r as (insert into event_outbox (event) values ($1) returning id) \
         select pg_notify('harkroom_event_outbox_ts', id::text) from r",
    )
    .bind(sqlx::types::Json(e))
    .execute(pool)
    .await
    .unwrap();
}

/// C6-α — TS 가 낸 이벤트(TS 채널)가 Rust 허브로 **낸 순서대로** 나오고, Rust 쓰기(옛 채널)와 섞여도 커밋 순서를 지킨다.
/// 받는 사람 판정은 TS 와 같다 — 쓰는 쪽이 계산한 audience 그대로(`visible_to`), 비멤버는 못 받는다.
#[tokio::test]
async fn ts_origin_events_reach_rust_in_order_with_same_audience() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(2)
        .connect(&url)
        .await
        .unwrap();
    let hub = Hub::new();
    let mut rx = hub.subscribe();
    spawn_outbox_listener(pool.clone(), url.clone(), hub.clone());
    // 리스너가 붙을 때까지 표지 하나를 TS 채널로 되풀이한다.
    let probe = json!({ "type": "inbox.updated", "accountId": "c6a-probe" });
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            ts_publish(&pool, &probe).await;
            if let Ok(Ok(_)) = tokio::time::timeout(Duration::from_millis(500), rx.recv()).await {
                return;
            }
        }
    })
    .await
    .expect("리스너가 TS 채널을 듣지 않는다");
    // 붙기 전에 보낸 표지가 늦게 도착할 수 있다 — 비운다.
    tokio::time::sleep(Duration::from_millis(300)).await;
    while rx.try_recv().is_ok() {}

    let (member, outsider) = (
        "00000000-0000-4000-8000-0000000000c1",
        "00000000-0000-4000-8000-0000000000c2",
    );
    // TS·Rust 출처를 번갈아 — 커밋 순서가 곧 받는 순서다.
    for i in 0..6 {
        let e = json!({ "type": "message.deleted", "channelId": "c", "messageId": format!("m{i}"), "audience": [member] });
        if i % 2 == 0 {
            ts_publish(&pool, &e).await;
        } else {
            let mut conn = pool.acquire().await.unwrap();
            harkroom_server::write::emit_event(&mut conn, &e)
                .await
                .unwrap();
        }
    }
    let mut ids = Vec::new();
    for _ in 0..6 {
        let e = tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("이벤트가 오지 않았다")
            .unwrap();
        assert!(harkroom_server::core::events::visible_to(&e, member));
        assert!(
            !harkroom_server::core::events::visible_to(&e, outsider),
            "비멤버가 TS 발행 이벤트를 받는다"
        );
        ids.push(e["messageId"].as_str().unwrap().to_owned());
    }
    assert_eq!(ids, ["m0", "m1", "m2", "m3", "m4", "m5"]);
    let s = harkroom_server::core::events::listener_stats();
    assert!(s.received >= 7, "{s:?}");
    assert!(s.last_lag_ms.is_some(), "{s:?}");
}
