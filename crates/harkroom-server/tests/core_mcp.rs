//! C4a-1 `POST /mcp` — 게이트(401/403 `agent_only`) · 본문 한도(413) · 투명 전달(바이트·헤더) · SSE 가 버퍼 없이 흐르는지.
//! 인증 판정(DB)은 `tests/auth.rs` 몫이라 여기서는 판정 결과(`Auth`)를 시험 층이 넣는다.
mod common;

use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode};
use harkroom_server::auth::{Account, Auth};
use harkroom_server::core::mcp::route::{AnswerFut, BODY_LIMIT, McpState, handle};
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
        .with_state(McpState {
            writes: Default::default(),
            up: upstream,
            // 이 시험들의 요청은 Rust 가 답하는 도구에 닿지 않는다(닿아도 입장 확인이 TS 흉내에서 끝난다) — 연결하지 않는 풀.
            pool: sqlx::postgres::PgPoolOptions::new()
                .connect_lazy("postgres://nobody@127.0.0.1:1/none")
                .unwrap(),
        });
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

// ── C4a-2 `serve` — 갈림 → 전송 조건 → 입장 확인(TS `/mcp/admit`) → 도구 답(SSE) ──

/// `/mcp/admit` 를 흉내 낸다 — 답 모양은 `mode` 로 고른다. 받은 헤더·본문은 `seen` 에 남긴다.
async fn admit_upstream(
    mode: &'static str,
    seen: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
) -> Upstream {
    let app = axum::Router::new().route(
        "/mcp/admit",
        axum::routing::post(move |req: Request<Body>| {
            let seen = seen.clone();
            async move {
                let (parts, body) = req.into_parts();
                let body = to_bytes(body, 1 << 20).await.unwrap();
                let mut s = seen.lock().unwrap();
                for (k, v) in &parts.headers {
                    s.push(format!("{k}={}", v.to_str().unwrap_or("?")));
                }
                s.push(format!("body={}", String::from_utf8_lossy(&body)));
                drop(s);
                let (status, text) = match mode {
                    "yes" => (200, r#"{"admitted":true}"#),
                    "no" => (
                        200,
                        r#"{"admitted":false,"result":{"content":[{"type":"text","text":"{\"error\":\"not_admissible\"}"}]}}"#,
                    ),
                    "bad_shape" => (200, r#"{"admitted":false,"result":{}}"#),
                    "not_json" => (200, "nope"),
                    _ => (500, r#"{"error":"boom"}"#),
                };
                axum::response::Response::builder()
                    .status(status)
                    .header("content-type", "application/json")
                    .body(Body::from(text))
                    .unwrap()
            }
        }),
    );
    Upstream::new(&format!("http://{}", common::serve(app).await))
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

fn none(_: &'static str, _: serde_json::Value) -> AnswerFut {
    Box::pin(async { None })
}

async fn sse_text(r: axum::response::Response) -> (String, String) {
    assert_eq!(r.status(), StatusCode::OK);
    let ct = r.headers()["content-type"].to_str().unwrap().to_string();
    assert_eq!(r.headers()["cache-control"], "no-cache, no-transform");
    let b = to_bytes(r.into_body(), 1 << 20).await.unwrap();
    (ct, String::from_utf8(b.to_vec()).unwrap())
}

#[tokio::test]
async fn serve_answers_after_admit_yes_in_sdk_sse_shape() {
    use harkroom_server::core::mcp::route::serve;
    let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let up = admit_upstream("yes", seen.clone()).await;
    let r = serve(
        &up,
        ci(),
        &mcp_headers(&[]),
        CALL.as_bytes(),
        &["channel.list"],
        &stub,
    )
    .await
    .expect("rust answers");
    let (ct, text) = sse_text(r).await;
    assert_eq!(ct, "text/event-stream");
    let data = text
        .strip_prefix("event: message\ndata: ")
        .and_then(|s| s.strip_suffix("\n\n"))
        .unwrap_or_else(|| panic!("{text}"));
    let v: serde_json::Value = serde_json::from_str(data).unwrap();
    assert_eq!(v["jsonrpc"], "2.0");
    assert_eq!(v["id"], 7);
    assert_eq!(v["result"]["content"][0]["text"], r#"channel.list:{"q":1}"#);
    // 입장 확인에는 자격·회차 표지만 실리고 본문은 도구 이름·인자다.
    let seen = seen.lock().unwrap().join("\n");
    assert!(seen.contains("authorization=Bearer t"), "{seen}");
    assert!(seen.contains("x-harkroom-turn-id=turn-1"), "{seen}");
    assert!(!seen.contains("x-not-forwarded"), "{seen}");
    assert!(
        seen.contains(r#"body={"arguments":{"q":1},"tool":"channel.list"}"#),
        "{seen}"
    );
}

#[tokio::test]
async fn serve_returns_admit_refusal_as_tool_answer_without_calling_tool() {
    use harkroom_server::core::mcp::route::serve;
    let up = admit_upstream("no", Default::default()).await;
    let r = serve(
        &up,
        ci(),
        &mcp_headers(&[]),
        CALL.as_bytes(),
        &["channel.list"],
        &|_, _| panic!("tool must not run after refusal"),
    )
    .await
    .expect("refusal is answered by rust");
    let (_, text) = sse_text(r).await;
    assert!(text.contains(r#"not_admissible"#), "{text}");
    assert!(text.contains(r#""id":7"#), "{text}");
}

#[tokio::test]
async fn serve_hands_to_ts_when_admit_is_unknown() {
    use harkroom_server::core::mcp::route::serve;
    for mode in ["error", "bad_shape", "not_json"] {
        let up = admit_upstream(mode, Default::default()).await;
        let r = serve(
            &up,
            ci(),
            &mcp_headers(&[]),
            CALL.as_bytes(),
            &["channel.list"],
            &move |_, _| panic!("tool must not run when admit is unknown ({mode})"),
        )
        .await;
        assert!(r.is_none(), "{mode}");
    }
}

#[tokio::test]
async fn serve_hands_to_ts_before_admit_when_not_ours() {
    use harkroom_server::core::mcp::route::serve;
    let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let up = admit_upstream("yes", seen.clone()).await;
    let h = mcp_headers(&[]);
    // 갈림 밖 · 빈 목록 · 전송 조건 실패 · 알림(id 없음) · 깨진 JSON — 모두 입장 확인 전에 TS 로.
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
    assert!(seen.lock().unwrap().is_empty(), "admit must not be asked");
    // 입장 확인은 통과했지만 도구가 답하지 않으면(None) 역시 TS 로.
    assert!(
        serve(&up, ci(), &h, CALL.as_bytes(), &["channel.list"], &none)
            .await
            .is_none()
    );
}

/// 읽기 풀이 막혔을 때 `message.read` 는 TS 로 넘기지 않고 다시 부른 뒤 `temporarily_unavailable` 로 답한다([`db_retry`]).
/// 이 갈래 밖의 도구는 예전처럼 TS 로 넘긴다.
#[tokio::test]
async fn serve_pre_retries_covered_reads_on_a_dead_pool() {
    use harkroom_server::core::mcp::route::{Pre, serve_pre};
    let dead = sqlx::postgres::PgPoolOptions::new()
        .acquire_timeout(Duration::from_millis(100))
        .connect_lazy("postgres://nobody@127.0.0.1:1/none")
        .unwrap();
    let pre = Pre {
        read_pool: Some(&dead),
        ..Pre::NONE
    };
    let up = admit_upstream("yes", Default::default()).await;
    // 인자는 zod 를 지나는 꼴이어야 한다 — 빈 `{}` 는 앞단 공통 검증(`zod_gate`)이 처리기보다 먼저 답한다.
    let read = r#"{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"message.read","arguments":{"channelId":"11111111-1111-4111-8111-111111111111"}}}"#;
    let hits = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let h = hits.clone();
    let counting = move |_: &'static str, _: serde_json::Value| -> AnswerFut {
        h.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Box::pin(async { None })
    };
    let r = serve_pre(
        &up,
        ci(),
        &mcp_headers(&[]),
        read.as_bytes(),
        &["message.read"],
        &counting,
        &pre,
    )
    .await
    .expect("answered by rust, not handed to TS");
    let (_, text) = sse_text(r).await;
    assert!(text.contains("temporarily_unavailable"), "{text}");
    assert_eq!(
        hits.load(std::sync::atomic::Ordering::SeqCst),
        harkroom_server::core::mcp::db_retry::ATTEMPTS
    );
    let other = serve_pre(
        &up,
        ci(),
        &mcp_headers(&[]),
        CALL.as_bytes(),
        &["channel.list"],
        &none,
        &pre,
    )
    .await;
    assert!(other.is_none(), "uncovered tool still goes to TS");
}
