//! 받은 HTTP 요청을 TS 서버(상류)로 넘기고 답을 그대로 돌려준다.
use axum::body::Body;
use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, Request, Response, StatusCode, Uri, header};
use hyper_util::client::legacy::{Client, connect::HttpConnector};
use hyper_util::rt::TokioExecutor;
use std::net::SocketAddr;

#[derive(Clone)]
pub struct Upstream {
    /// `http://host:port` (끝 `/` 없음). TLS 는 쓰지 않는다 — 같은 클러스터 안 서비스로만 간다.
    pub base: String,
    pub client: Client<HttpConnector, Body>,
}

impl Upstream {
    pub fn new(base: &str) -> Self {
        Self {
            base: base.trim_end_matches('/').to_string(),
            client: Client::builder(TokioExecutor::new()).build_http(),
        }
    }
}

/// 홉마다 끝나는 헤더(RFC 9110 §7.6.1) — 넘기지 않는다.
const HOP_BY_HOP: [&str; 8] = [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];

fn strip_hop_by_hop(h: &mut HeaderMap) {
    // `Connection` 이 이름 붙인 헤더도 이 홉 것이다.
    let named: Vec<HeaderName> = h
        .get_all(header::CONNECTION)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .filter_map(|n| HeaderName::from_bytes(n.trim().as_bytes()).ok())
        .collect();
    for n in named {
        h.remove(n);
    }
    for n in HOP_BY_HOP {
        h.remove(n);
    }
}

fn plain(status: StatusCode, msg: &'static str) -> Response<Body> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(format!(
            "{{\"error\":{{\"code\":\"front\",\"message\":\"{msg}\"}}}}"
        )))
        .expect("고정 응답")
}

pub async fn forward(
    State(up): State<Upstream>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    mut req: Request<Body>,
) -> Response<Body> {
    if req.headers().contains_key(header::UPGRADE) {
        return plain(
            StatusCode::NOT_IMPLEMENTED,
            "websocket paths are served by the TS server",
        );
    }
    let pq = req
        .uri()
        .path_and_query()
        .map(|p| p.as_str())
        .unwrap_or("/");
    let Ok(uri) = format!("{}{}", up.base, pq).parse::<Uri>() else {
        return plain(StatusCode::BAD_REQUEST, "bad request target");
    };
    *req.uri_mut() = uri;
    let h = req.headers_mut();
    strip_hop_by_hop(h);
    // 앞단 하나가 늘었다 — 클라이언트 주소를 X-Forwarded-For 끝에 덧붙인다(TS 의 TRUST_PROXY 가 한 홉을 더 믿어야 한다).
    let ip = peer.ip().to_string();
    let xff = match h.get("x-forwarded-for").and_then(|v| v.to_str().ok()) {
        Some(prev) if !prev.is_empty() => format!("{prev}, {ip}"),
        _ => ip,
    };
    if let Ok(v) = HeaderValue::from_str(&xff) {
        h.insert("x-forwarded-for", v);
    }
    match up.client.request(req).await {
        Ok(res) => {
            let (mut parts, body) = res.into_parts();
            strip_hop_by_hop(&mut parts.headers);
            Response::from_parts(parts, Body::new(body))
        }
        Err(_) => plain(StatusCode::BAD_GATEWAY, "upstream unavailable"),
    }
}

/// 앞단 자신의 상태. 상류로 넘기지 않는다.
pub async fn front_health() -> Response<Body> {
    Response::builder()
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(format!(
            "{{\"ok\":true,\"front\":\"rust\",\"version\":\"{}\"}}",
            env!("CARGO_PKG_VERSION")
        )))
        .expect("고정 응답")
}

pub fn router(up: Upstream) -> axum::Router {
    axum::Router::new()
        .route("/front/healthz", axum::routing::get(front_health))
        .fallback(forward)
        .with_state(up)
}
