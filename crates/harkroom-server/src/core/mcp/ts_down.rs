//! 앞단이 답하지 않는 `/mcp` 요청의 답과, DB 재시도가 다 실패했을 때의 도구 오류 코드.
//!
//! 예전에는 Rust 가 맡지 않는 꼴(zod 가 받지 않을 인자·쓰기 전 DB 오류·배치 등)을 TS 로 넘겼고, TS 가 꺼져 있으면 이 모듈이
//! `temporarily_unavailable` 로 답했다. TS 서버를 지우면서(11-21) 넘김을 닫았다 — 이제 그 꼴은 [`unsupported`] 가 **고정 코드**로 답한다:
//!
//! - `tools/call` → 도구 오류(성공 결과 안의 `error`, [`super::tool_error`] 와 같은 꼴) `unsupported_call` — 글에 도구 이름을 싣는다
//! - 그 밖의 요청(`initialize`·`tools/list` 의 이상한 꼴·배치 등) → JSON-RPC 오류 `-32600`
//! - 알림(id 없음)만 든 본문 → 202
//!
//! 본문이 JSON 이 아니거나 id 꼴이 이상하면 `None` — 부르는 쪽이 404(`proxy::closed`)로 답한다.
//! [`CODE`](`temporarily_unavailable`)는 이제 DB 재시도 소진([`super::db_retry`])에만 쓴다 — 다시 부르면 될 수 있는 경우다.
use axum::body::Body;
use axum::http::Response;
use serde_json::Value;

pub const CODE: &str = "temporarily_unavailable";
pub const MESSAGE: &str = "this request cannot be handled right now — try again shortly";
/// Rust 가 맡지 않는 도구 부르기 꼴 — 다시 불러도 같다(인자나 꼴을 바꿔야 한다).
pub const UNSUPPORTED: &str = "unsupported_call";
/// JSON-RPC 「잘못된 요청」.
pub const RPC_INVALID_REQUEST: i64 = -32600;

fn unsupported_message(tool: Option<&str>) -> String {
    match tool {
        Some(t) => format!(
            "the server does not support this call of `{t}` — check the arguments against the tool schema"
        ),
        None => {
            "the server does not support this call — check the arguments against the tool schema"
                .to_string()
        }
    }
}

/// 도구 이름(128자까지·영숫자와 `._-` 만) — 글에 실을 것만.
fn tool_name(req: &Value) -> Option<&str> {
    let n = req.get("params")?.get("name")?.as_str()?;
    (n.len() <= 128
        && n.chars()
            .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c)))
    .then_some(n)
}

/// 한 요청의 답 SSE 조각 — 알림이면 `Ok(None)`, 답할 수 없는 꼴이면 `Err(())`.
fn frame(req: &Value) -> Result<Option<String>, ()> {
    let obj = req.as_object().ok_or(())?;
    let Some(id) = obj.get("id") else {
        return Ok(None);
    };
    let id = super::respond::id_text(id).ok_or(())?;
    let data = if obj.get("method").and_then(Value::as_str) == Some("tools/call") {
        let result = super::tool_error(UNSUPPORTED, &unsupported_message(tool_name(req)));
        format!("{{\"result\":{result},\"jsonrpc\":\"2.0\",\"id\":{id}}}")
    } else {
        let err =
            serde_json::json!({ "code": RPC_INVALID_REQUEST, "message": "request not supported" });
        format!("{{\"jsonrpc\":\"2.0\",\"id\":{id},\"error\":{err}}}")
    };
    Ok(Some(format!("event: message\ndata: {data}\n\n")))
}

/// Rust 가 맡지 않은 `/mcp` 요청의 답. 단건·배치 모두 받는다.
pub fn unsupported(bytes: &[u8]) -> Option<Response<Body>> {
    let v = serde_json::from_slice::<Value>(bytes).ok()?;
    let reqs: Vec<&Value> = match &v {
        Value::Array(a) if !a.is_empty() => a.iter().collect(),
        Value::Object(_) => vec![&v],
        _ => return None,
    };
    let mut body = String::new();
    for r in reqs {
        if let Some(f) = frame(r).ok()? {
            body.push_str(&f);
        }
    }
    Some(if body.is_empty() {
        super::respond::accepted()
    } else {
        super::respond::sse_body(body)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::StatusCode;

    async fn text(r: Response<Body>) -> (StatusCode, String) {
        let s = r.status();
        let b = axum::body::to_bytes(r.into_body(), 1 << 20).await.unwrap();
        (s, String::from_utf8(b.to_vec()).unwrap())
    }

    fn data(body: &str) -> Vec<Value> {
        body.lines()
            .filter_map(|l| l.strip_prefix("data: "))
            .map(|d| serde_json::from_str(d).unwrap())
            .collect()
    }

    #[tokio::test]
    async fn tools_call_becomes_tool_error() {
        let b = br#"{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"message.post","arguments":{}}}"#;
        let r = unsupported(b).unwrap();
        // 옛 대조 시험용 표지(`x-harkroom-closed`)는 TS 와 함께 걷었다(11-21).
        assert!(r.headers().get("x-harkroom-closed").is_none());
        let (s, body) = text(r).await;
        assert_eq!(s, StatusCode::OK);
        let d = data(&body);
        assert_eq!(d.len(), 1);
        assert_eq!(d[0]["id"], 7);
        assert!(d[0].get("error").is_none());
        let inner: Value =
            serde_json::from_str(d[0]["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(inner["error"]["code"], UNSUPPORTED);
        assert!(
            inner["error"]["message"]
                .as_str()
                .unwrap()
                .contains("`message.post`")
        );
    }

    #[tokio::test]
    async fn lifecycle_requests_become_rpc_errors() {
        for m in ["initialize", "tools/list"] {
            let b = format!(r#"{{"jsonrpc":"2.0","id":"a","method":"{m}"}}"#);
            let (s, body) = text(unsupported(b.as_bytes()).unwrap()).await;
            assert_eq!(s, StatusCode::OK);
            let d = data(&body);
            assert_eq!(d[0]["id"], "a");
            assert_eq!(d[0]["error"]["code"], RPC_INVALID_REQUEST);
        }
    }

    #[tokio::test]
    async fn batch_answers_requests_and_skips_notifications() {
        let b = br#"[{"jsonrpc":"2.0","method":"notifications/initialized"},{"jsonrpc":"2.0","id":1,"method":"tools/list"},{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"x"}}]"#;
        let (_, body) = text(unsupported(b).unwrap()).await;
        let d = data(&body);
        assert_eq!(d.len(), 2);
        assert_eq!(d[0]["id"], 1);
        assert_eq!(d[1]["id"], 2);
    }

    #[tokio::test]
    async fn notification_only_is_accepted() {
        let b = br#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#;
        let (s, _) = text(unsupported(b).unwrap()).await;
        assert_eq!(s, StatusCode::ACCEPTED);
    }

    #[test]
    fn odd_bodies_are_left_to_the_404() {
        assert!(unsupported(b"not json").is_none());
        assert!(unsupported(b"[]").is_none());
        assert!(unsupported(br#"{"jsonrpc":"2.0","id":1.5,"method":"tools/list"}"#).is_none());
    }

    #[test]
    fn message_names_no_upstream() {
        let m = MESSAGE.to_ascii_lowercase();
        for w in ["ts", "upstream", "3400", "node", "http"] {
            assert!(
                !m.split(|c: char| !c.is_ascii_alphanumeric())
                    .any(|t| t == w),
                "{w}"
            );
        }
    }
}
