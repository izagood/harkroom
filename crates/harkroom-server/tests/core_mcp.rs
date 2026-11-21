//! C4a-1 `POST /mcp` — 게이트(401/403 `agent_only`) · 본문 한도(413) · Rust 가 맡지 않는 꼴의 고정 답(TS 넘김은 11-21 닫음).
//! 인증 판정(DB)은 `tests/auth.rs` 몫이라 여기서는 판정 결과(`Auth`)를 시험 층이 넣는다.
mod common;

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use harkroom_server::auth::{Account, Auth};
use harkroom_server::core::mcp::route::{AnswerFut, BODY_LIMIT, McpState, handle};
use harkroom_server::proxy::Upstream;
use http_body_util::BodyExt;
use std::time::Duration;

fn account(kind: &str) -> Account {
    Account {
        id: "00000000-0000-0000-0000-000000000001".into(),
        handle: "a".into(),
        display_name: "a".into(),
        kind: kind.into(),
        is_admin: false,
        role: "member".into(),
        status: "active".into(),
        status_text: None,
        avatar_attachment_id: None,
    }
}

/// `x-test-kind` 로 판정을 흉내 낸다(없으면 익명).
async fn fake_auth(
    mut req: Request<Body>,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let kind = req
        .headers()
        .get("x-test-kind")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    req.extensions_mut().insert(Auth {
        account: kind.as_deref().map(account),
        ..Auth::default()
    });
    next.run(req).await
}

async fn front() -> String {
    let app = axum::Router::new()
        .route("/mcp", axum::routing::post(handle))
        .route_layer(axum::middleware::from_fn(fake_auth))
        .with_state(McpState {
            writes: Default::default(),
            up: Upstream,
            // 이 시험들의 요청은 Rust 가 답하는 도구에 닿지 않는다(닿아도 입장 확인이 TS 흉내에서 끝난다) — 연결하지 않는 풀.
            pool: sqlx::postgres::PgPoolOptions::new()
                .connect_lazy("postgres://nobody@127.0.0.1:1/none")
                .unwrap(),
        });
    format!("http://{}", common::serve(app).await)
}

#[tokio::test]
async fn non_agents_are_stopped_at_the_gate() {
    let f = front().await;
    let (s, _, body) = common::send(&f, Method::POST, "/mcp", &[], "{}").await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    assert!(body.contains("\"agent_only\""), "{body}");
    let (s, _, body) =
        common::send(&f, Method::POST, "/mcp", &[("x-test-kind", "human")], "{}").await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    assert!(body.contains("\"agent_only\""), "{body}");
    // 익명은 한도를 넘는다고 밝힌 본문이어도 401 이다 — 본문을 읽기 전에 끊는다(TS `onRequest` 와 같다). 본문은 끝내 오지 않는다.
    let client = hyper_util::client::legacy::Client::builder(hyper_util::rt::TokioExecutor::new())
        .build_http::<Body>();
    let pending = futures_util::stream::pending::<Result<String, std::io::Error>>();
    let req = Request::post(format!("{f}/mcp"))
        .header("content-length", (BODY_LIMIT + 1).to_string())
        .body(Body::from_stream(pending))
        .unwrap();
    let res = tokio::time::timeout(Duration::from_secs(5), client.request(req))
        .await
        .expect("answered without reading the body")
        .unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

/// Rust 가 답하지 못한 도구 부르기는 상류로 가지 않고 도구 오류 `unsupported_call`(도구 이름 실림)로 끝난다.
#[tokio::test]
async fn unserved_tool_call_is_unsupported_call_not_forwarded() {
    let f = front().await;
    let rpc = r#"{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"channel.list","arguments":{}}}"#;
    let (s, _, body) = common::send(
        &f,
        Method::POST,
        "/mcp",
        &[
            ("x-test-kind", "agent"),
            ("accept", "application/json, text/event-stream"),
            ("content-type", "application/json"),
        ],
        rpc,
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert!(body.starts_with("event: message\ndata: "), "{body}");
    assert!(body.contains("unsupported_call"), "{body}");
    assert!(body.contains("channel.list"), "{body}");
    assert!(body.contains("\"id\":7"), "{body}");
    assert!(!body.contains("temporarily_unavailable"), "{body}");
}

/// 알림만 든 본문은 202, JSON 이 아닌 본문은 404 `not_found` — 둘 다 상류로 가지 않는다.
#[tokio::test]
async fn non_call_shapes_get_fixed_answers() {
    let f = front().await;
    let agent = [("x-test-kind", "agent")];
    let (s, _, _) = common::send(&f, Method::POST, "/mcp", &agent, "{}").await;
    assert_eq!(s, StatusCode::ACCEPTED);
    let (s, _, body) = common::send(&f, Method::POST, "/mcp", &agent, "not json").await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    assert!(body.contains("\"not_found\""), "{body}");
    let rpc = r#"{"jsonrpc":"2.0","id":"x","method":"no/such"}"#;
    let (s, _, body) = common::send(&f, Method::POST, "/mcp", &agent, rpc).await;
    assert_eq!(s, StatusCode::OK);
    assert!(body.contains("-32600"), "{body}");
}

#[tokio::test]
async fn body_over_ts_limit_is_413() {
    let f = front().await;
    // 한도 정확히는 읽는다(JSON 이 아니라 404 로 끝나지만 413 은 아니다).
    let at = "x".repeat(BODY_LIMIT);
    let (s, _, _) = common::send(&f, Method::POST, "/mcp", &[("x-test-kind", "agent")], &at).await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    // 한도를 넘는다고 밝히면 읽지 않고 413(fastify 와 같다). 본문은 끝내 오지 않는다.
    let client = hyper_util::client::legacy::Client::builder(hyper_util::rt::TokioExecutor::new())
        .build_http::<Body>();
    let pending = futures_util::stream::pending::<Result<String, std::io::Error>>();
    let req = Request::post(format!("{f}/mcp"))
        .header("x-test-kind", "agent")
        .header("content-length", (BODY_LIMIT + 1).to_string())
        .body(Body::from_stream(pending))
        .unwrap();
    let res = tokio::time::timeout(Duration::from_secs(5), client.request(req))
        .await
        .expect("answered without reading the body")
        .unwrap();
    assert_eq!(res.status(), StatusCode::PAYLOAD_TOO_LARGE);
    let body = res.into_body().collect().await.unwrap().to_bytes();
    assert!(
        String::from_utf8_lossy(&body).contains("fst_err_ctp_body_too_large"),
        "{body:?}"
    );

    // 길이를 밝히지 않은(chunked) 본문도 읽으며 센다.
    let chunk = "y".repeat(1 << 20);
    let chunks: Vec<Result<String, std::io::Error>> = (0..5).map(|_| Ok(chunk.clone())).collect();
    let req = Request::post(format!("{f}/mcp"))
        .header("x-test-kind", "agent")
        .body(Body::from_stream(futures_util::stream::iter(chunks)))
        .unwrap();
    let res = client.request(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::PAYLOAD_TOO_LARGE);
}

// ── C4a-2 `serve` — 갈림 → 전송 조건 → 입장 확인(TS `/mcp/admit`) → 도구 답(SSE) ──

/// 예전 상류(TS `/mcp/admit`) 자리 — 이제 아무 데도 잇지 않는다(넘김을 닫아 입장 확인을 물을 곳이 없다).
fn no_upstream() -> Upstream {
    Upstream
}

fn ci() -> axum::extract::ConnectInfo<std::net::SocketAddr> {
    axum::extract::ConnectInfo("127.0.0.1:9".parse().unwrap())
}

fn mcp_headers(extra: &[(&'static str, &'static str)]) -> axum::http::HeaderMap {
    let mut h = axum::http::HeaderMap::new();
    h.insert(
        "accept",
        "application/json, text/event-stream".parse().unwrap(),
    );
    h.insert("content-type", "application/json".parse().unwrap());
    h.insert("authorization", "Bearer t".parse().unwrap());
    h.insert("x-harkroom-turn-id", "turn-1".parse().unwrap());
    h.insert("x-not-forwarded", "1".parse().unwrap());
    for (k, v) in extra {
        h.insert(*k, v.parse().unwrap());
    }
    h
}

const CALL: &str = r#"{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"channel.list","arguments":{"q":1}}}"#;

fn stub(tool: &'static str, args: serde_json::Value) -> AnswerFut {
    Box::pin(async move {
        Some(
            serde_json::json!({"content":[{"type":"text","text":format!("{tool}:{args}")}]})
                .to_string(),
        )
    })
}

/// 입장 확인을 Rust 가 끝까지 못 하면(presence·비밀 값 검사 없음) TS 에 묻지 않고 `None` — 부르는 쪽이 `unsupported_call` 로 답한다.
/// 도구는 불리지 않는다.
#[tokio::test]
async fn serve_without_local_admit_does_not_run_the_tool() {
    use harkroom_server::core::mcp::route::serve;
    let r = serve(
        &no_upstream(),
        ci(),
        &mcp_headers(&[]),
        CALL.as_bytes(),
        &["channel.list"],
        &|_, _| panic!("tool must not run without admission"),
    )
    .await;
    assert!(r.is_none());
}

#[tokio::test]
async fn serve_declines_before_admit_when_not_ours() {
    use harkroom_server::core::mcp::route::serve;
    let up = no_upstream();
    let h = mcp_headers(&[]);
    // 갈림 밖 · 빈 목록 · 전송 조건 실패 · 알림(id 없음) · 깨진 JSON — 모두 입장 확인 전에 `None`(부르는 쪽이 고정 답).
    let notif = r#"{"jsonrpc":"2.0","method":"tools/call","params":{"name":"channel.list"}}"#;
    let cases: [(&axum::http::HeaderMap, &str, &[&str]); 4] = [
        (&h, CALL, &["message.post"]),
        (&h, CALL, &[]),
        (&h, notif, &["channel.list"]),
        (&h, "{", &["channel.list"]),
    ];
    for (hh, body, served) in cases {
        assert!(
            serve(&up, ci(), hh, body.as_bytes(), served, &stub)
                .await
                .is_none(),
            "{body} {served:?}"
        );
    }
    let bad_accept = mcp_headers(&[("accept", "application/json")]);
    assert!(
        serve(
            &up,
            ci(),
            &bad_accept,
            CALL.as_bytes(),
            &["channel.list"],
            &stub
        )
        .await
        .is_none()
    );
    let bad_ver = mcp_headers(&[("mcp-protocol-version", "1999-01-01")]);
    assert!(
        serve(
            &up,
            ci(),
            &bad_ver,
            CALL.as_bytes(),
            &["channel.list"],
            &stub
        )
        .await
        .is_none()
    );
}
