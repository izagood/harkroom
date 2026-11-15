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

/// JSON-RPC `id` 를 SDK(`JSON.stringify`)와 같은 글자로 — 문자열과 정수만. 소수·그 밖은 `None`(→ TS).
pub fn id_text(id: &Value) -> Option<String> {
    match id {
        Value::String(_) => Some(id.to_string()),
        Value::Number(n) if n.is_i64() || n.is_u64() => Some(n.to_string()),
        _ => None,
    }
}

/// TS `jsonResult` 의 글자 그대로 — `{"content":[{"type":"text","text":<inner 를 JSON 문자열로>}]}`.
/// serde 의 문자열 이스케이프는 `JSON.stringify` 와 같다(`"`·`\\`·제어 문자, 소문자 `\u00xx`, 비 ASCII 는 그대로).
pub fn text_result(inner: &str) -> String {
    format!(
        "{{\"content\":[{{\"type\":\"text\",\"text\":{}}}]}}",
        Value::String(inner.to_owned())
    )
}

/// JSON 글자에서 문자열 밖 공백만 지운다 — 키 순서를 그대로 둔 채 `JSON.stringify` 꼴(공백 없음)로. Postgres 의 `json` 출력
/// (`json_build_object` 의 `" : "`, `json_agg` 의 `", \n "`)을 TS 가 node-pg 로 읽어 다시 쓴 글자와 맞춘다.
pub fn minify(json: &str) -> String {
    let mut out = String::with_capacity(json.len());
    let (mut in_str, mut esc) = (false, false);
    for c in json.chars() {
        if in_str {
            out.push(c);
            if esc {
                esc = false;
            } else if c == '\\' {
                esc = true;
            } else if c == '"' {
                in_str = false;
            }
        } else if c == '"' {
            in_str = true;
            out.push(c);
        } else if !c.is_ascii_whitespace() {
            out.push(c);
        }
    }
    out
}

/// `tools/call` 하나의 답 — SDK 의 SSE 모양(무상태라 `mcp-session-id`·이벤트 id 없음). 바깥 키 순서도 SDK 와 같다
/// (`{ result, jsonrpc, id }` — Protocol 이 답을 그 순서로 짓는다).
pub fn sse(id: &str, result: &str) -> Response<Body> {
    let body = format!(
        "event: message\ndata: {{\"result\":{result},\"jsonrpc\":\"2.0\",\"id\":{id}}}\n\n"
    );
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
    // 누가 답했는지 — 대조 시험이 「Rust 가 정말 답했나」를 이것으로 본다(같은 글자면 넘긴 것과 구별이 안 된다). 값은 고정이다.
    h.insert("x-harkroom-core", HeaderValue::from_static("mcp"));
    r
}

#[derive(Debug, PartialEq)]
pub enum Admit {
    /// 받음. `bg_enabled` 는 TS 가 `bg.claim` 에 한해 실어 주는 `backgroundEnabled()` 값 — 글자 그대로 `true` 일 때만 참이다
    /// (없음·다른 꼴은 거짓 → `bg.claim` 은 TS 가 답한다). 켜짐의 출처를 TS 하나로 둔다(security 02:21 KST #1).
    /// `registered` 는 TS 답의 `registered`(이 요청 시점에 TS 가 그 도구를 싣는가) — 옛 TS 는 칸이 없다(`None`).
    Yes {
        bg_enabled: bool,
        registered: Option<bool>,
    },
    /// 거절 — 도구 답의 `content[0].text`(TS 가 지은 `{"error":…}` 글자). 답은 [`text_result`] 로 다시 감싼다.
    No(String),
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
        Some(true) => Admit::Yes {
            bg_enabled: v.get("bgEnabled").and_then(Value::as_bool) == Some(true),
            registered: v.get("registered").and_then(Value::as_bool),
        },
        Some(false) => match v.get("result") {
            Some(r) => match r.pointer("/content/0/text").and_then(Value::as_str) {
                Some(t) => Admit::No(t.to_owned()),
                None => Admit::Unknown,
            },
            None => Admit::Unknown,
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
        assert!(!transport_ok(&h(&[("accept", "text/event-stream"), ok[1]])));
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
