//! 코어 `/ws` 의 C6 전 조건(security, #2118 판정) — DB 없이 돈다(풀은 연결하지 않는 lazy 풀, 재검증은 길게).
//! - C6-1: 읽지 않는 클라이언트는 나가는 줄 상한(`SEND_QUEUE`)을 넘기면 1013 으로 닫힌다(메모리가 끝없이 늘지 않는다).
//! - C6-2: 받는 프레임 크기 상한(`MAX_INBOUND_BYTES`)을 넘는 프레임은 받지 않고 연결을 끝낸다.
mod common;

use futures_util::{SinkExt, StreamExt};
use harkroom_server::core::events::Hub;
use harkroom_server::core::tickets::Claim;
use harkroom_server::core::ws::{self, Core, MAX_INBOUND_BYTES, SEND_QUEUE, Timing};
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;

fn lazy_pool() -> sqlx::PgPool {
    sqlx::postgres::PgPoolOptions::new()
        .connect_lazy("postgres://nobody@127.0.0.1:1/none")
        .unwrap()
}

async fn core_front() -> (String, Arc<Core>, Hub) {
    let hub = Hub::new();
    let timing = Timing {
        heartbeat: Duration::from_secs(3600),
        app_heartbeat: Duration::from_secs(3600),
        revalidate: Duration::from_secs(3600),
    };
    let core = Core::new(lazy_pool(), hub.clone(), None, timing);
    let auth = harkroom_server::auth::AuthPools {
        read: lazy_pool(),
        write: None,
    };
    let app = ws::router(core.clone(), auth);
    let addr = common::serve(app).await;
    (format!("ws://{addr}"), core, hub)
}

fn ticket(core: &Core) -> String {
    core.tickets.issue(Claim {
        account_id: "acct-1".into(),
        credential_hash: "h".into(),
    })
}

#[tokio::test]
async fn a_client_that_does_not_read_is_closed_with_1013() {
    let (base, core, hub) = core_front().await;
    let (mut client, _) =
        tokio_tungstenite::connect_async(format!("{base}/ws?ticket={}", ticket(&core)))
            .await
            .unwrap();
    // 스냅숏을 받아 구독이 선 것을 확인한 뒤로는 읽지 않는다.
    // (자기 `presence.changed` 가 스냅숏보다 먼저 올 수 있다.)
    loop {
        let m = client.next().await.unwrap().unwrap();
        if m.to_text().unwrap().contains("presence.snapshot") {
            break;
        }
    }
    // 상한보다 훨씬 많이, 크게 — TCP 버퍼가 차서 쓰는 일꾼이 멈추면 줄이 넘친다.
    let big = "x".repeat(64 * 1024);
    for i in 0..(SEND_QUEUE * 8) {
        hub.emit(json!({ "type": "presence.changed", "accountId": format!("a{i}"), "online": true, "pad": big }));
        if i % 64 == 0 {
            tokio::task::yield_now().await;
        }
    }
    // 이제 읽는다 — 쌓인 프레임 뒤에(또는 먼저) 1013 닫기가 와야 한다.
    let code = tokio::time::timeout(Duration::from_secs(20), async {
        while let Some(m) = client.next().await {
            match m {
                Ok(Message::Close(Some(f))) => return Some(f.code),
                Ok(Message::Close(None)) => return None,
                Ok(_) => {}
                Err(_) => return None,
            }
        }
        None
    })
    .await
    .expect("닫히지 않았다(나가는 줄에 상한이 없다)");
    assert_eq!(code, Some(CloseCode::Again), "1013 Try Again Later");
}

#[tokio::test]
async fn an_oversized_inbound_frame_ends_the_connection() {
    let (base, core, _hub) = core_front().await;
    let (mut client, _) =
        tokio_tungstenite::connect_async(format!("{base}/ws?ticket={}", ticket(&core)))
            .await
            .unwrap();
    let _ = client.next().await; // 스냅숏
    // 상한 이하는 받아 준다(연결 유지).
    client
        .send(Message::Text("x".repeat(MAX_INBOUND_BYTES - 16).into()))
        .await
        .unwrap();
    // 상한을 넘으면 서버가 연결을 끝낸다.
    let _ = client
        .send(Message::Text("y".repeat(MAX_INBOUND_BYTES * 4).into()))
        .await;
    let ended = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match client.next().await {
                None | Some(Err(_)) | Some(Ok(Message::Close(_))) => return true,
                Some(Ok(_)) => {}
            }
        }
    })
    .await
    .unwrap_or(false);
    assert!(ended, "상한 넘는 프레임 뒤에도 연결이 살아 있다");
}
