//! 앞단이 요청을 상류(TS 서버)로 그대로 넘기는지 — 가짜 상류를 띄워 받은 것을 그대로 되돌려 보게 한다.
use axum::body::{Body, to_bytes};
use axum::http::{HeaderMap, Method, Request, StatusCode};
use harkroom_server::proxy::{Upstream, router};
use harkroom_server::schema::{KNOWN_MIGRATIONS, compare};
use std::net::SocketAddr;

/// 받은 메서드·경로·헤더·본문을 JSON 비슷한 글로 되돌린다.
async fn echo(req: Request<Body>) -> axum::response::Response {
    let (parts, body) = req.into_parts();
    let body = to_bytes(body, 1 << 20).await.unwrap();
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
        .status(if parts.uri.path() == "/missing" {
            404
        } else {
            200
        })
        .header("x-from", "upstream")
        .header("connection", "close, x-secret-hop")
        .header("x-secret-hop", "1")
        .body(Body::from(text))
        .unwrap()
}

async fn serve(app: axum::Router) -> SocketAddr {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let a = l.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(l, app.into_make_service_with_connect_info::<SocketAddr>())
            .await
            .unwrap();
    });
    a
}

async fn front_over(upstream: &str) -> SocketAddr {
    serve(router(Upstream::new(upstream))).await
}

async fn send(
    front: SocketAddr,
    method: Method,
    path: &str,
    headers: &[(&str, &str)],
    body: &str,
) -> (StatusCode, HeaderMap, String) {
    let client = hyper_util::client::legacy::Client::builder(hyper_util::rt::TokioExecutor::new())
        .build_http::<Body>();
    let mut b = Request::builder()
        .method(method)
        .uri(format!("http://{front}{path}"));
    for (k, v) in headers {
        b = b.header(*k, *v);
    }
    let res = client
        .request(b.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = res.status();
    let h = res.headers().clone();
    let bytes = http_body_util::BodyExt::collect(res.into_body())
        .await
        .unwrap()
        .to_bytes();
    (status, h, String::from_utf8_lossy(&bytes).into_owned())
}

#[tokio::test]
async fn forwards_method_path_query_headers_and_body() {
    let up = serve(axum::Router::new().fallback(echo)).await;
    let front = front_over(&format!("http://{up}/")).await;
    let (status, h, text) = send(
        front,
        Method::POST,
        "/channels/c1/messages?limit=5&x=%20",
        &[
            ("authorization", "Bearer t0k"),
            ("content-type", "application/json"),
            ("x-forwarded-for", "203.0.113.9"),
            ("connection", "keep-alive, x-drop-me"),
            ("x-drop-me", "1"),
        ],
        "{\"body\":\"안녕\"}",
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(h.get("x-from").unwrap(), "upstream");
    assert!(
        h.get("x-secret-hop").is_none(),
        "상류 답의 홉 헤더는 넘기지 않는다"
    );
    let first = text.lines().next().unwrap();
    assert!(
        first.starts_with("POST /channels/c1/messages?limit=5&x=%20"),
        "{first}"
    );
    assert!(text.contains("authorization=Bearer t0k"));
    assert!(text.contains("content-type=application/json"));
    assert!(
        text.contains("x-forwarded-for=203.0.113.9, 127.0.0.1"),
        "클라이언트 주소를 끝에 덧붙인다:\n{text}"
    );
    assert!(
        !text.contains("x-drop-me"),
        "Connection 이 이름 붙인 헤더는 넘기지 않는다"
    );
    assert!(text.ends_with("{\"body\":\"안녕\"}"));
}

#[tokio::test]
async fn upstream_status_passes_through() {
    let up = serve(axum::Router::new().fallback(echo)).await;
    let front = front_over(&format!("http://{up}")).await;
    let (status, _, _) = send(front, Method::GET, "/missing", &[], "").await;
    assert_eq!(status, 404);
}

#[tokio::test]
async fn upstream_down_is_502_and_upgrades_are_refused() {
    let dead = {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        l.local_addr().unwrap()
    };
    let front = front_over(&format!("http://{dead}")).await;
    let (status, _, text) = send(front, Method::GET, "/readyz", &[], "").await;
    assert_eq!(status, 502);
    assert!(text.contains("upstream unavailable"));
    let (status, _, _) = send(
        front,
        Method::GET,
        "/ws",
        &[("connection", "upgrade"), ("upgrade", "websocket")],
        "",
    )
    .await;
    assert_eq!(status, 501);
}

#[tokio::test]
async fn front_health_is_answered_here() {
    let dead = {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        l.local_addr().unwrap()
    };
    let front = front_over(&format!("http://{dead}")).await;
    let (status, _, text) = send(front, Method::GET, "/front/healthz", &[], "").await;
    assert_eq!(status, 200);
    assert!(text.contains("\"front\":\"rust\""));
}

#[test]
fn schema_compare_refuses_missing_and_tolerates_newer() {
    assert!(KNOWN_MIGRATIONS.len() > 100 && KNOWN_MIGRATIONS.contains(&"168_event_outbox.sql"));
    let all: Vec<String> = KNOWN_MIGRATIONS.iter().map(|s| s.to_string()).collect();
    let ok = compare(KNOWN_MIGRATIONS, &all);
    assert!(ok.missing.is_empty() && ok.unknown.is_empty());
    let older: Vec<String> = all[..all.len() - 1].to_vec();
    assert_eq!(
        compare(KNOWN_MIGRATIONS, &older).missing,
        vec![all.last().unwrap().clone()]
    );
    let mut newer = all.clone();
    newer.push("999_future.sql".into());
    let c = compare(KNOWN_MIGRATIONS, &newer);
    assert!(c.missing.is_empty());
    assert_eq!(c.unknown, vec!["999_future.sql".to_string()]);
}

/// 코어 줄(`route_table::Table`)과 **같은 경로의 다른 메서드**는 TS 로 간다 — 405 가 아니다(`route_table::ts_fallback`).
/// 코어가 `GET /channels/{id}/messages` 만 붙여도 같은 경로의 `POST`(글 쓰기)는 상류가 답해야 한다.
#[tokio::test]
async fn core_table_sends_other_methods_on_same_path_to_upstream() {
    use harkroom_server::route_table::{Table, ts_fallback};
    let up = serve(axum::Router::new().fallback(echo)).await;
    let upstream = Upstream::new(&format!("http://{up}"));
    let core = || {
        Table::<()>::new()
            .get("/channels/{id}/messages", || async { "rust" })
            .map(|r| {
                r.layer(axum::middleware::from_fn(
                    |req, next: axum::middleware::Next| async move { next.run(req).await },
                ))
            })
            .finish()
            .router
    };

    // 고침 없이 — 같은 경로의 POST 는 코어가 405 로 막는다(이 시험이 무엇을 지키는지).
    let bare = serve(core().merge(router(upstream.clone()))).await;
    let (s, _, _) = send(bare, Method::POST, "/channels/c1/messages", &[], "{}").await;
    assert_eq!(s, StatusCode::METHOD_NOT_ALLOWED);

    let front = serve(ts_fallback(core(), upstream.clone()).merge(router(upstream))).await;
    let (s, _, text) = send(front, Method::GET, "/channels/c1/messages", &[], "").await;
    assert_eq!(
        (s, text.as_str()),
        (StatusCode::OK, "rust"),
        "코어 줄은 Rust 가 답한다"
    );
    for m in [Method::POST, Method::PATCH, Method::PUT, Method::DELETE] {
        let (s, h, text) = send(
            front,
            m.clone(),
            "/channels/c1/messages?x=1",
            &[("authorization", "Bearer t0k")],
            "{\"body\":\"hi\"}",
        )
        .await;
        assert_eq!(s, StatusCode::OK, "{m} 는 405 가 아니라 상류로");
        assert_eq!(h.get("x-from").unwrap(), "upstream");
        let first = text.lines().next().unwrap();
        assert!(
            first.starts_with(&format!("{m} /channels/c1/messages?x=1")),
            "{first}"
        );
        assert!(text.contains("authorization=Bearer t0k") && text.ends_with("{\"body\":\"hi\"}"));
    }
    // 코어에 없는 경로는 지금처럼 앞단 fallback 이 넘긴다.
    let (s, h, _) = send(front, Method::GET, "/elsewhere", &[], "").await;
    assert_eq!(
        (s, h.get("x-from").unwrap().to_str().unwrap()),
        (StatusCode::OK, "upstream")
    );
}
