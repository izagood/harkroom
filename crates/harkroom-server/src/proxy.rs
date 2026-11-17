//! 받은 HTTP 요청을 TS 서버(상류)로 넘기고 답을 그대로 돌려준다.
use axum::body::Body;
use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, Request, Response, StatusCode, Uri, header};
use hyper_util::client::legacy::{Client, connect::HttpConnector};
use hyper_util::rt::{TokioExecutor, TokioIo};
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

/// 상류로 보낼 요청으로 고친다 — 주소를 상류로, 홉 헤더를 빼고, `X-Forwarded-For` 끝에 클라이언트 주소를 덧붙인다.
/// HTTP 와 웹소켓이 **같은 함수**를 거친다 — 두 길이 TS 에 다른 헤더를 보내면 `TRUST_PROXY` 홉 수가 길마다 달라진다.
fn prepare_upstream(
    up: &Upstream,
    peer: SocketAddr,
    req: &mut Request<Body>,
) -> Result<(), &'static str> {
    let pq = req
        .uri()
        .path_and_query()
        .map(|p| p.as_str())
        .unwrap_or("/");
    let Ok(uri) = format!("{}{}", up.base, pq).parse::<Uri>() else {
        return Err("bad request target");
    };
    *req.uri_mut() = uri;
    let h = req.headers_mut();
    strip_hop_by_hop(h);
    // 앞단 하나가 늘었다 — 클라이언트 주소를 X-Forwarded-For 끝에 덧붙인다(TS 의 TRUST_PROXY 가 한 홉을 더 믿어야 한다).
    // 클라이언트가 보낸 앞쪽 값은 지우지 않는다: TS 는 오른쪽부터 믿는 홉 수만큼만 읽으므로 왼쪽 값은 주소로 쓰이지 않는다.
    let ip = peer.ip().to_string();
    let xff = match h.get("x-forwarded-for").and_then(|v| v.to_str().ok()) {
        Some(prev) if !prev.is_empty() => format!("{prev}, {ip}"),
        _ => ip,
    };
    if let Ok(v) = HeaderValue::from_str(&xff) {
        h.insert("x-forwarded-for", v);
    }
    Ok(())
}

/// `GET` + `Upgrade: websocket` 인지. 그 밖의 업그레이드는 넘기지 않는다.
fn is_websocket_upgrade(req: &Request<Body>) -> bool {
    req.method() == axum::http::Method::GET
        && req
            .headers()
            .get_all(header::UPGRADE)
            .iter()
            .filter_map(|v| v.to_str().ok())
            .flat_map(|v| v.split(','))
            .any(|t| t.trim().eq_ignore_ascii_case("websocket"))
}

/// 웹소켓 업그레이드를 TS 로 그대로 잇는다(C6-β). 코어가 받지 않는 소켓 경로(코어가 꺼졌거나, 권한이 모자라 그 묶음이 안 섰을 때)가
/// 여기로 온다 — 앞단은 인증·Origin 판정을 하지 않고 TS 가 직접 받을 때처럼 한 번만 하게 둔다.
/// 상류가 101 이 아니면(401·403 등) 그 답을 그대로 돌려준다. 101 이면 양쪽 연결을 업그레이드해 바이트를 그대로 잇는다.
async fn forward_websocket(
    up: Upstream,
    peer: SocketAddr,
    mut req: Request<Body>,
) -> Response<Body> {
    let Some(client_side) = req.extensions_mut().remove::<hyper::upgrade::OnUpgrade>() else {
        return plain(
            StatusCode::BAD_REQUEST,
            "upgrade not available on this connection",
        );
    };
    // 홉 헤더(Upgrade·Connection)는 이 홉 것이라 빼고, 상류 홉에 맞게 다시 단다. Sec-WebSocket-* 은 끝단 헤더라 그대로 간다.
    if let Err(msg) = prepare_upstream(&up, peer, &mut req) {
        return plain(StatusCode::BAD_REQUEST, msg);
    }
    let h = req.headers_mut();
    h.insert(header::CONNECTION, HeaderValue::from_static("upgrade"));
    h.insert(header::UPGRADE, HeaderValue::from_static("websocket"));
    let mut res = match up.client.request(req).await {
        Ok(res) => res,
        Err(_) => return plain(StatusCode::BAD_GATEWAY, "upstream unavailable"),
    };
    if res.status() != StatusCode::SWITCHING_PROTOCOLS {
        let (mut parts, body) = res.into_parts();
        strip_hop_by_hop(&mut parts.headers);
        return Response::from_parts(parts, Body::new(body));
    }
    let upstream_side = hyper::upgrade::on(&mut res);
    let mut headers = res.headers().clone();
    strip_hop_by_hop(&mut headers);
    headers.insert(header::CONNECTION, HeaderValue::from_static("upgrade"));
    headers.insert(header::UPGRADE, HeaderValue::from_static("websocket"));
    tokio::spawn(async move {
        // 클라이언트 쪽 업그레이드는 아래 101 답이 나간 뒤에 풀린다 — 둘을 함께 기다린다.
        let (Ok(c), Ok(u)) = tokio::join!(client_side, upstream_side) else {
            return;
        };
        let mut c = TokioIo::new(c);
        let mut u = TokioIo::new(u);
        let _ = tokio::io::copy_bidirectional(&mut c, &mut u).await;
    });
    let mut out = Response::new(Body::empty());
    *out.status_mut() = StatusCode::SWITCHING_PROTOCOLS;
    *out.headers_mut() = headers;
    out
}

pub async fn forward(
    State(up): State<Upstream>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    mut req: Request<Body>,
) -> Response<Body> {
    if req.headers().contains_key(header::UPGRADE) {
        if is_websocket_upgrade(&req) {
            return forward_websocket(up, peer, req).await;
        }
        // 웹소켓이 아닌 업그레이드(h2c 등)는 TS 도 받지 않는다 — 넘기지 않는다.
        return plain(
            StatusCode::NOT_IMPLEMENTED,
            "only websocket upgrades are proxied",
        );
    }
    if let Err(msg) = prepare_upstream(&up, peer, &mut req) {
        return plain(StatusCode::BAD_REQUEST, msg);
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
