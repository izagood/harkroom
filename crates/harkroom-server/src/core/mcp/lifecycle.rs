//! P2b — 도구 부르기가 아닌 MCP 메시지(`initialize`·`ping`·`tools/list`·알림, 그리고 그것들만 담은 배치)를 Rust 가 답한다.
//!
//! TS 는 SDK(`@modelcontextprotocol/sdk` 1.30, 무상태 streamable HTTP)가 이것들을 답한다. 그 글자를 그대로 낸다:
//! - `initialize`: `{"protocolVersion":<청한 판이 지원 목록에 있으면 그것, 아니면 최신>,"capabilities":{"tools":{"listChanged":true}},
//!   "serverInfo":{"name":"harkroom","version":"0.1.0"}}` (Server `_oninitialize` · McpServer 가 도구를 실으며 세우는 능력).
//! - `ping`: `{}`.
//! - 알림·답만 담은 본문: 본문 없는 202.
//! - 배치: 메시지마다 SSE 한 조각씩, 배치 순서대로(SDK 의 처리기가 모두 동기라 순서가 같다).
//!
//! 조금이라도 모양이 다르면(필드 꼴·모르는 메서드·`tools/call` 이 섞인 배치·`initialize` 가 든 배치·`cursor`) **답하지 않고** TS 로 넘긴다 —
//! 거절 글자(400·-32600 등)의 정본은 SDK 하나로 둔다.
use serde_json::Value;

/// SDK `LATEST_PROTOCOL_VERSION`.
pub const LATEST_PROTOCOL_VERSION: &str = "2025-11-25";

/// Rust 가 지을 답.
#[derive(Debug, PartialEq, Eq)]
pub enum Reply {
    /// 알림·답뿐 — 본문 없는 202.
    Accepted,
    /// SSE 조각들(`event: message\ndata: …\n\n` 이어 붙인 것).
    Sse(String),
}

/// 한 메시지의 결과 글자(`result` 칸) — 요청이면 `Some((id, result))`, 알림이면 `None`. 답할 수 없으면 `Err`.
fn one(m: &Value, single: bool, tools_list: Option<&str>) -> Result<Option<(String, String)>, ()> {
    let o = m.as_object().ok_or(())?;
    if o.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return Err(());
    }
    let method = o.get("method").and_then(Value::as_str).ok_or(())?;
    let params = o.get("params");
    if params.is_some_and(|p| !p.is_object()) {
        return Err(());
    }
    let Some(id) = o.get("id") else {
        // 알림. SDK 는 무상태 서버에서 아무것도 남기지 않는다(`notifications/initialized`·`cancelled` 등).
        return if method.starts_with("notifications/") {
            Ok(None)
        } else {
            Err(())
        };
    };
    let id = super::respond::id_text(id).ok_or(())?;
    let result = match method {
        "initialize" if single => initialize(params.ok_or(())?)?,
        "ping" => "{}".to_owned(),
        "tools/list" => {
            // 쪽 넘기기(cursor)는 SDK 가 무시하지만, 꼴 검사(문자열)를 TS 에 맡긴다.
            if params.is_some_and(|p| p.get("cursor").is_some()) {
                return Err(());
            }
            tools_list.ok_or(())?.to_owned()
        }
        _ => return Err(()),
    };
    Ok(Some((id, result)))
}

/// SDK `InitializeRequestSchema` 가 받는 꼴만 — `protocolVersion` 문자열 · `capabilities` 객체 · `clientInfo.name`·`version` 문자열.
fn initialize(p: &Value) -> Result<String, ()> {
    let v = p.get("protocolVersion").and_then(Value::as_str).ok_or(())?;
    if !p.get("capabilities").is_some_and(Value::is_object) {
        return Err(());
    }
    let ci = p.get("clientInfo").ok_or(())?;
    if !(ci.get("name").is_some_and(Value::is_string)
        && ci.get("version").is_some_and(Value::is_string))
    {
        return Err(());
    }
    let pv = if super::respond::PROTOCOL_VERSIONS.contains(&v) {
        v
    } else {
        LATEST_PROTOCOL_VERSION
    };
    Ok(format!(
        "{{\"protocolVersion\":\"{pv}\",\"capabilities\":{{\"tools\":{{\"listChanged\":true}}}},\"serverInfo\":{{\"name\":\"harkroom\",\"version\":\"0.1.0\"}}}}"
    ))
}

/// 본문 하나(단일 또는 배치)를 Rust 가 다 답할 수 있으면 그 답. 하나라도 못 하면 `None`(→ 통째로 TS).
/// `tools_list` 는 지금 실리는 도구 목록의 `result` 글자 — 없으면 `tools/list` 는 TS 가 답한다.
pub fn answer(body: &Value, tools_list: Option<&str>) -> Option<Reply> {
    let msgs: Vec<&Value> = match body {
        Value::Array(a) if !a.is_empty() => a.iter().collect(),
        Value::Array(_) => return None,
        v => vec![v],
    };
    let single = msgs.len() == 1 && !body.is_array();
    let mut out = String::new();
    for m in msgs {
        if let Some((id, result)) = one(m, single, tools_list).ok()? {
            out.push_str(&format!(
                "event: message\ndata: {{\"result\":{result},\"jsonrpc\":\"2.0\",\"id\":{id}}}\n\n"
            ));
        }
    }
    Some(if out.is_empty() {
        Reply::Accepted
    } else {
        Reply::Sse(out)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn init(v: &str) -> Value {
        json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize",
                "params": { "protocolVersion": v, "capabilities": {}, "clientInfo": { "name": "c", "version": "1" } } })
    }

    /// SDK 1.30 이 낸 글자(같은 요청을 McpServer + 무상태 전송에 넣어 받은 것)와 같다.
    #[test]
    fn initialize_matches_sdk_bytes() {
        assert_eq!(
            answer(&init("2025-06-18"), None),
            Some(Reply::Sse("event: message\ndata: {\"result\":{\"protocolVersion\":\"2025-06-18\",\"capabilities\":{\"tools\":{\"listChanged\":true}},\"serverInfo\":{\"name\":\"harkroom\",\"version\":\"0.1.0\"}},\"jsonrpc\":\"2.0\",\"id\":1}\n\n".into()))
        );
        let Some(Reply::Sse(s)) = answer(&init("1999-01-01"), None) else {
            panic!()
        };
        assert!(s.contains("\"protocolVersion\":\"2025-11-25\""));
    }

    #[test]
    fn initialize_shape_and_batch_go_to_ts() {
        let mut bad = init("2025-06-18");
        bad["params"]["clientInfo"] = json!({ "name": "c" });
        assert_eq!(answer(&bad, None), None);
        assert_eq!(answer(&json!([init("2025-06-18")]), None), None);
    }

    #[test]
    fn notifications_are_202() {
        let n = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
        assert_eq!(answer(&n, None), Some(Reply::Accepted));
        assert_eq!(answer(&json!([n, n]), None), Some(Reply::Accepted));
        assert_eq!(
            answer(&json!({ "jsonrpc": "2.0", "method": "tools/list" }), None),
            None
        );
        assert_eq!(answer(&json!([]), None), None);
    }

    #[test]
    fn batch_in_order_and_calls_go_to_ts() {
        let b = json!([
            { "jsonrpc": "2.0", "method": "notifications/initialized" },
            { "jsonrpc": "2.0", "id": 2, "method": "tools/list" },
            { "jsonrpc": "2.0", "id": 3, "method": "ping" }
        ]);
        assert_eq!(
            answer(&b, Some("{\"tools\":[]}")),
            Some(Reply::Sse("event: message\ndata: {\"result\":{\"tools\":[]},\"jsonrpc\":\"2.0\",\"id\":2}\n\nevent: message\ndata: {\"result\":{},\"jsonrpc\":\"2.0\",\"id\":3}\n\n".into()))
        );
        // 목록 스냅숏이 없으면 TS.
        assert_eq!(answer(&b, None), None);
        let call = json!([{ "jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": { "name": "account.me" } }]);
        assert_eq!(answer(&call, Some("{}")), None);
        let cursor = json!({ "jsonrpc": "2.0", "id": 5, "method": "tools/list", "params": { "cursor": "x" } });
        assert_eq!(answer(&cursor, Some("{}")), None);
    }
}
