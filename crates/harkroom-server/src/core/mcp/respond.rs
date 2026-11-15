//! C4a-2 응답 층 — Rust 가 도구 하나를 답할 때 TS SDK(`@modelcontextprotocol/sdk` 1.30, 무상태 streamable HTTP)와 같은 모양으로 낸다.
//!
//! - 전송 조건: SDK 가 406/415/400 으로 거절하는 요청(Accept 에 `application/json`·`text/event-stream` 둘 다 없음 · Content-Type 이
//!   JSON 아님 · 모르는 `mcp-protocol-version`)은 Rust 가 받지 않고 TS 로 넘긴다 — 거절 문구의 정본을 하나로 둔다([`transport_ok`]).
//! - 답: SSE 한 조각 `event: message\ndata: <JSON-RPC>\n\n` + SDK 와 같은 헤더([`sse`]).
//! - 입장 확인: presence·leakGuard·백그라운드 허용 목록은 TS `/mcp/admit` 에 호출자 자신의 자격으로 묻는다([`admit`]).
//!   그 답을 못 받으면(상류 오류·200 아님·모양 다름) **Rust 는 답하지 않고 원래 요청을 TS 로 넘긴다** — 확인을 건너뛰는 쪽으로 틀리지 않는다.
use crate::proxy::{self, Upstream};
use axum::body::{Body, to_bytes};
use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, HeaderValue, Method, Request, Response, StatusCode, header};
use serde_json::{Value, json};
use std::net::SocketAddr;

/// SDK `SUPPORTED_PROTOCOL_VERSIONS`(types.js). 모르는 판이면 TS 가 400 을 낸다.
pub const PROTOCOL_VERSIONS: &[&str] = &[
    "2025-11-25",
    "2025-06-18",
    "2025-03-26",
    "2024-11-05",
    "2024-10-07",
];

/// SDK 가 이 요청을 받아 도구를 부를 조건과 같은가. 아니면 TS 로.
pub fn transport_ok(h: &HeaderMap) -> bool {
    let accept = h
        .get(header::ACCEPT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !accept.contains("application/json") || !accept.contains("text/event-stream") {
        return false;
    }
    // SDK `isJsonContentType` — 미디어 타입만(매개변수 무시, 대소문자 무시).
    let ct = h
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let media = ct.split(';').next().unwrap_or("").trim();
    if !media.eq_ignore_ascii_case("application/json") {
        return false;
    }
    match h.get("mcp-protocol-version") {
        None => true,
        Some(v) => v.to_str().is_ok_and(|v| PROTOCOL_VERSIONS.contains(&v)),
    }
}

/// `tools/call` 하나의 답 — SDK 의 SSE 모양(무상태라 `mcp-session-id`·이벤트 id 없음).
pub fn sse(id: &Value, result: &Value) -> Response<Body> {
    let msg = json!({ "result": result, "jsonrpc": "2.0", "id": id });
    let body = format!("event: message\ndata: {msg}\n\n");
    let mut r = Response::new(Body::from(body));
    *r.status_mut() = StatusCode::OK;
    let h = r.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/event-stream"),
    );
    h.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-cache, no-transform"),
    );
    h.insert("x-accel-buffering", HeaderValue::from_static("no"));
    r
}

#[derive(Debug, PartialEq)]
pub enum Admit {
    Yes,
    /// 거절 — 도구 답 모양(`content[0].text = {"error":…}`) 그대로.
    No(Value),
    /// 확인을 못 했다 → TS 로 넘긴다.
    Unknown,
}

/// 입장 확인에 실어 보낼 헤더 — 자격과 회차 표지만. 나머지(본문 길이·Accept)는 새 요청 것이다.
const ADMIT_HEADERS: &[&str] = &[
    "authorization",
    "x-harkroom-agent",
    "x-harkroom-cause",
    "x-harkroom-turn-id",
    "x-forwarded-for",
    "user-agent",
];

pub async fn admit(
    up: &Upstream,
    ci: ConnectInfo<SocketAddr>,
    orig: &HeaderMap,
    tool: &str,
    args: &Value,
) -> Admit {
    let body = json!({ "tool": tool, "arguments": args }).to_string();
    let mut req = Request::builder()
        .method(Method::POST)
        .uri("/mcp/admit")
        .header(header::CONTENT_TYPE, "application/json");
    for n in ADMIT_HEADERS {
        for v in orig.get_all(*n) {
            req = req.header(*n, v);
        }
    }
    let Ok(req) = req.body(Body::from(body)) else {
        return Admit::Unknown;
    };
    let res = proxy::forward(State(up.clone()), ci, req).await;
    if res.status() != StatusCode::OK {
        return Admit::Unknown;
    }
    let Ok(bytes) = to_bytes(res.into_body(), 1 << 20).await else {
        return Admit::Unknown;
    };
    let Ok(v) = serde_json::from_slice::<Value>(&bytes) else {
        return Admit::Unknown;
    };
    match v.get("admitted").and_then(Value::as_bool) {
        Some(true) => Admit::Yes,
        Some(false) => match v.get("result") {
            Some(r) if r.pointer("/content/0/text").is_some_and(Value::is_string) => {
                Admit::No(r.clone())
            }
            _ => Admit::Unknown,
        },
        None => Admit::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut m = HeaderMap::new();
        for (k, v) in pairs {
            m.insert(
                axum::http::HeaderName::from_bytes(k.as_bytes()).unwrap(),
                HeaderValue::from_str(v).unwrap(),
            );
        }
        m
    }

    #[test]
    fn transport_matches_sdk_conditions() {
        let ok = [
            ("accept", "application/json, text/event-stream"),
            ("content-type", "application/json; charset=utf-8"),
        ];
        assert!(transport_ok(&h(&ok)));
        assert!(!transport_ok(&h(&[
            ("accept", "text/event-stream"),
            ok[1]
        ])));
        assert!(!transport_ok(&h(&[ok[0], ("content-type", "text/plain")])));
        assert!(!transport_ok(&h(&[
            ok[0],
            ("content-type", "application/jsonx")
        ])));
        assert!(transport_ok(&h(&[
            ok[0],
            ok[1],
            ("mcp-protocol-version", "2025-06-18")
        ])));
        assert!(!transport_ok(&h(&[
            ok[0],
            ok[1],
            ("mcp-protocol-version", "1999-01-01")
        ])));
    }
}
