//! C4a-1 `POST /mcp` — 게이트(401/403 `agent_only`) · 본문 한도(413) · 투명 전달(바이트·헤더) · SSE 가 버퍼 없이 흐르는지.
//! 인증 판정(DB)은 `tests/auth.rs` 몫이라 여기서는 판정 결과(`Auth`)를 시험 층이 넣는다.
mod common;

use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode};
use harkroom_server::auth::{Account, Auth};
use harkroom_server::core::mcp::route::{BODY_LIMIT, handle};
use harkroom_server::proxy::Upstream;
use http_body_util::BodyExt;
use std::time::Duration;

/// 받은 것을 돌려준다. `/mcp` 에 `accept: text/event-stream` 이면 SSE 한 조각을 곧바로 내고 다음 조각은 30초 뒤에 낸다.
async fn upstream(req: Request<Body>) -> axum::response::Response {
    let sse = req
        .headers()
        .get("accept")
        .is_some_and(|v| v == "text/event-stream");
    if sse {
        let s = futures_util::stream::unfold(0u8, |n| async move {
            match n {
                0 => Some((Ok::<_, std::io::Error>("data: one\n\n"), 1)),
                1 => {
                    tokio::time::sleep(Duration::from_secs(30)).await;
                    Some((Ok("data: two\n\n"), 2))
                }
                _ => None,
            }
        });
        return axum::response::Response::builder()
            .header("content-type", "text/event-stream")
            .body(Body::from_stream(s))
            .unwrap();
    }
    let (parts, body) = req.into_parts();
    let body = to_bytes(body, 1 << 24).await.unwrap();
    let mut headers: Vec<String> = parts
        .headers
        .iter()
        .map(|(k, v)| format!("{k}={}", v.to_str().unwrap_or("?")))
        .collect();
    headers.sort();
    let text = format!(
        "{} {}\n{}\n{}",
        parts.method,
        parts.uri,
        headers.join("\n"),
        String::from_utf8_lossy(&body)
    );
    axum::response::Response::builder()
        .header("content-type", "application/json")
        .body(Body::from(text))
        .unwrap()
}

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
    let up = common::serve(axum::Router::new().fallback(upstream)).await;
    let upstream = Upstream::new(&format!("http://{up}"));
    let app = axum::Router::new()
        .route("/mcp", axum::routing::post(handle))
        .route_layer(axum::middleware::from_fn(fake_auth))
        .with_state(upstream);
    format!("http://{}", common::serve(app).await)
}

#[tokio::test]
async fn non_agents_are_stopped_before_upstream() {
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

#[tokio::test]
async fn agent_request_is_forwarded_byte_for_byte_with_headers() {
    let f = front().await;
    let rpc = r#"{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"channel.list","arguments":{}}}"#;
    let (s, _, body) = common::send(
        &f,
        Method::POST,
        "/mcp?x=1",
        &[
            ("x-test-kind", "agent"),
            ("authorization", "Bearer pat-1"),
            ("x-harkroom-agent", "00000000-0000-0000-0000-000000000002"),
            ("x-harkroom-cause", "00000000-0000-0000-0000-000000000003"),
            ("x-harkroom-turn-id", "00000000-0000-0000-0000-000000000004"),
            ("x-harkroom-command-files", "a.md"),
            ("accept", "application/json, text/event-stream"),
            ("content-type", "application/json"),
        ],
        rpc,
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert!(body.starts_with("POST /mcp?x=1\n"), "{body}");
    for h in [
        "authorization=Bearer pat-1",
        "x-harkroom-agent=00000000-0000-0000-0000-000000000002",
        "x-harkroom-cause=00000000-0000-0000-0000-000000000003",
        "x-harkroom-turn-id=00000000-0000-0000-0000-000000000004",
        "x-harkroom-command-files=a.md",
        "accept=application/json, text/event-stream",
        "content-type=application/json",
        &format!("content-length={}", rpc.len()),
    ] {
        assert!(body.lines().any(|l| l == h), "missing {h}: {body}");
    }
    assert!(body.ends_with(rpc), "{body}");
}

#[tokio::test]
async fn body_over_ts_limit_is_413() {
    let f = front().await;
    // 한도 정확히는 통과한다.
    let at = "x".repeat(BODY_LIMIT);
    let (s, _, _) = common::send(&f, Method::POST, "/mcp", &[("x-test-kind", "agent")], &at).await;
    assert_eq!(s, StatusCode::OK);
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

#[tokio::test]
async fn sse_streams_without_buffering() {
    let f = front().await;
    let client = hyper_util::client::legacy::Client::builder(hyper_util::rt::TokioExecutor::new())
        .build_http::<Body>();
    let req = Request::post(format!("{f}/mcp"))
        .header("x-test-kind", "agent")
        .header("accept", "text/event-stream")
        .body(Body::from("{}"))
        .unwrap();
    let res = tokio::time::timeout(Duration::from_secs(5), client.request(req))
        .await
        .expect("headers arrive before the stream ends")
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(res.headers()["content-type"], "text/event-stream");
    let mut body = res.into_body();
    // 상류는 둘째 조각을 30초 뒤에 낸다 — 첫 조각이 5초 안에 오면 앞단이 모으지 않고 흘린 것이다.
    let frame = tokio::time::timeout(Duration::from_secs(5), body.frame())
        .await
        .expect("first SSE event is not held back")
        .unwrap()
        .unwrap();
    assert_eq!(frame.into_data().unwrap(), "data: one\n\n");
}
