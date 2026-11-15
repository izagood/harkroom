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
