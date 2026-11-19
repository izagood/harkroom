//! TS 가 없을 때의 `/mcp` 답 — 앞단이 넘긴 요청에 상류가 닿지 않으면(`proxy::forward` 의 502) 그 502 를 그대로 돌려주지 않고
//! JSON-RPC 꼴로 답한다. 에이전트의 MCP 클라이언트는 맨 HTTP 502 를 전송 실패로 보고 연결을 다시 맺거나 턴을 깨뜨리지만,
//! 도구 오류는 그 한 번의 부르기만 실패시킨다.
//!
//! - `tools/call` → 도구 오류(성공 결과 안의 `error`, [`super::tool_error`] 와 같은 꼴) `temporarily_unavailable`
//! - 그 밖의 요청(`initialize`·`tools/list` 등) → JSON-RPC 오류 `-32603`
//! - 알림(id 없음)만 든 본문 → 202
//!
//! 오류 글에는 상류가 무엇인지·어디인지를 싣지 않는다. 본문이 JSON 이 아니거나 id 꼴이 이상하면 `None`(원래 502 를 둔다).
use axum::body::Body;
use axum::http::Response;
use serde_json::Value;

pub const CODE: &str = "temporarily_unavailable";
pub const MESSAGE: &str = "this request cannot be handled right now — try again shortly";
/// JSON-RPC 「내부 오류」.
pub const RPC_INTERNAL: i64 = -32603;

/// 한 요청의 답 SSE 조각 — 알림이면 `Ok(None)`, 답할 수 없는 꼴이면 `Err(())`.
fn frame(req: &Value) -> Result<Option<String>, ()> {
    let obj = req.as_object().ok_or(())?;
    let Some(id) = obj.get("id") else {
        return Ok(None);
    };
    let id = super::respond::id_text(id).ok_or(())?;
    let data = if obj.get("method").and_then(Value::as_str) == Some("tools/call") {
        let result = super::tool_error(CODE, MESSAGE);
        format!("{{\"result\":{result},\"jsonrpc\":\"2.0\",\"id\":{id}}}")
    } else {
        let err = serde_json::json!({ "code": RPC_INTERNAL, "message": MESSAGE });
        format!("{{\"jsonrpc\":\"2.0\",\"id\":{id},\"error\":{err}}}")
    };
    Ok(Some(format!("event: message\ndata: {data}\n\n")))
}

/// 상류 없이 낼 답. 단건·배치 모두 받는다.
pub fn reply(bytes: &[u8]) -> Option<Response<Body>> {
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
        let (s, body) = text(reply(b).unwrap()).await;
        assert_eq!(s, StatusCode::OK);
        let d = data(&body);
        assert_eq!(d.len(), 1);
        assert_eq!(d[0]["id"], 7);
        assert!(d[0].get("error").is_none());
        let inner: Value =
            serde_json::from_str(d[0]["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(inner["error"]["code"], CODE);
    }

    #[tokio::test]
    async fn lifecycle_requests_become_rpc_errors() {
        for m in ["initialize", "tools/list"] {
            let b = format!(r#"{{"jsonrpc":"2.0","id":"a","method":"{m}"}}"#);
            let (s, body) = text(reply(b.as_bytes()).unwrap()).await;
            assert_eq!(s, StatusCode::OK);
            let d = data(&body);
            assert_eq!(d[0]["id"], "a");
            assert_eq!(d[0]["error"]["code"], RPC_INTERNAL);
        }
    }

    #[tokio::test]
    async fn batch_answers_requests_and_skips_notifications() {
        let b = br#"[{"jsonrpc":"2.0","method":"notifications/initialized"},{"jsonrpc":"2.0","id":1,"method":"tools/list"},{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"x"}}]"#;
        let (_, body) = text(reply(b).unwrap()).await;
        let d = data(&body);
        assert_eq!(d.len(), 2);
        assert_eq!(d[0]["id"], 1);
        assert_eq!(d[1]["id"], 2);
    }

    #[tokio::test]
    async fn notification_only_is_accepted() {
        let b = br#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#;
        let (s, _) = text(reply(b).unwrap()).await;
        assert_eq!(s, StatusCode::ACCEPTED);
    }

    #[test]
    fn odd_bodies_keep_the_502() {
        assert!(reply(b"not json").is_none());
        assert!(reply(b"[]").is_none());
        assert!(reply(br#"{"jsonrpc":"2.0","id":1.5,"method":"tools/list"}"#).is_none());
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
