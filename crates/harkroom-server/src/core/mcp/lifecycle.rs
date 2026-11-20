//! P2b — 도구 부르기가 아닌 MCP 메시지(`initialize`·`ping`·`tools/list`·알림, 그리고 그것들만 담은 배치)를 Rust 가 답한다.
//!
//! TS 는 SDK(`@modelcontextprotocol/sdk` 1.30, 무상태 streamable HTTP)가 이것들을 답한다. 그 글자를 그대로 낸다:
//! - `initialize`: `{"protocolVersion":<청한 판이 지원 목록에 있으면 그것, 아니면 최신>,"capabilities":{"tools":{"listChanged":true}},
//!   "serverInfo":{"name":"harkroom","version":"0.1.0"}}` (Server `_oninitialize` · McpServer 가 도구를 실으며 세우는 능력).
//! - `ping`: `{}`.
//! - 알림·답만 담은 본문: 본문 없는 202.
//! - `server/discover`(새 스펙의 접속 탐색, 단일 요청만): SDK 1.30 은 이 메서드를 몰라 `-32601 Method not found` 로 답하고, 클라이언트는
//!   `initialize` 로 돌아간다. 그 오류 글자(`{"jsonrpc":"2.0","id":…,"error":{"code":-32601,"message":"Method not found"}}`,
//!   SDK `Protocol._onrequest` 의 키 순서)를 그대로 낸다 — 이것이 없으면 접속마다 TS `/mcp` 1회가 남는다.
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

/// 요청 하나의 답 — `result` 칸 또는 SDK 오류 글자 한 조각.
#[derive(Debug, PartialEq, Eq)]
enum Out {
    /// `result` 칸의 JSON 글자.
    Result(String),
    /// `-32601 Method not found`(SDK 가 모르는 메서드에 내는 글자).
    MethodNotFound,
}

/// SDK 1.30 이 모르는데 Rust 가 SDK 와 같은 `-32601` 로 대신 답하는 메서드 — 단일 요청일 때만.
/// 모르는 메서드 전부가 아니라 이름을 하나씩 올린다(TS 에만 등록된 메서드를 잘못 막지 않게).
const SDK_UNKNOWN_METHODS: &[&str] = &["server/discover"];

/// 한 메시지의 답 — 요청이면 `Some((id, Out))`, 알림이면 `None`. 답할 수 없으면 `Err`.
fn one(m: &Value, single: bool, tools_list: Option<&str>) -> Result<Option<(String, Out)>, ()> {
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
    let out = match method {
        m if single && SDK_UNKNOWN_METHODS.contains(&m) => {
            return Ok(Some((id, Out::MethodNotFound)));
        }
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
    Ok(Some((id, Out::Result(out))))
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

/// `tools/list` 의 `result` 글자 — TS `mcpToolsListResult` 가 지은 SDK 글자 그대로를 `golden/mcp_tools_list.json` 으로 받는다
/// (`packages/server/test/rustMcpToolsListGolden.test.ts` 가 TS 와 같은지 본다). 조건부 등록은 `delegation.close` 하나라
/// `HARKROOM_DELEGATION_V2`(앞단 env)로 고른다 — 값이 없으면 `None`(TS 가 답한다, P2a 의 `registered` 와 같은 규칙).
pub fn tools_list(delegation_v2: Option<bool>) -> Option<&'static str> {
    static G: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
    let g = G.get_or_init(|| {
        serde_json::from_str(include_str!("../../../golden/mcp_tools_list.json"))
            .expect("golden/mcp_tools_list.json")
    });
    let key = if delegation_v2? {
        "delegation_v2"
    } else {
        "base"
    };
    g.get(key)?.as_str()
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
        match one(m, single, tools_list).ok()? {
            Some((id, Out::Result(result))) => out.push_str(&format!(
                "event: message\ndata: {{\"result\":{result},\"jsonrpc\":\"2.0\",\"id\":{id}}}\n\n"
            )),
            Some((id, Out::MethodNotFound)) => out.push_str(&format!(
                "event: message\ndata: {{\"jsonrpc\":\"2.0\",\"id\":{id},\"error\":{{\"code\":-32601,\"message\":\"Method not found\"}}}}\n\n"
            )),
            None => {}
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
    /// 골든 두 판: 둘 다 객체 하나(`{"tools":[…]}`)이고, `delegation.close` 는 v2 에만 있다. 값이 없으면 TS.
    #[test]
    fn tools_list_snapshot() {
        assert_eq!(tools_list(None), None);
        let names = |s: &str| -> Vec<String> {
            let v: Value = serde_json::from_str(s).unwrap();
            v["tools"]
                .as_array()
                .unwrap()
                .iter()
                .map(|t| t["name"].as_str().unwrap().to_owned())
                .collect()
        };
        let base = names(tools_list(Some(false)).unwrap());
        let v2 = names(tools_list(Some(true)).unwrap());
        assert!(base.contains(&"bg.claim".to_owned()));
        assert!(!base.contains(&"delegation.close".to_owned()));
        assert!(v2.contains(&"delegation.close".to_owned()));
        assert_eq!(v2.len(), base.len() + 1);
        // 답 글자는 스냅숏 그대로 실린다.
        let Some(Reply::Sse(s)) = answer(
            &json!({ "jsonrpc": "2.0", "id": 7, "method": "tools/list" }),
            tools_list(Some(true)),
        ) else {
            panic!()
        };
        assert_eq!(
            s,
            format!(
                "event: message\ndata: {{\"result\":{},\"jsonrpc\":\"2.0\",\"id\":7}}\n\n",
                tools_list(Some(true)).unwrap()
            )
        );
    }

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

    /// Claude Code 2.1.329 가 접속할 때 맨 먼저 보내는 탐색 요청(508B, `_meta` 세 칸·문자열 id). TS SDK 는 -32601 로 답하고
    /// 운영에서 잰 그 답이 124B 다 — 같은 글자를 낸다. 배치에 들어 있으면 지금처럼 TS.
    #[test]
    fn discover_probe_is_sdk_method_not_found() {
        let probe = json!({ "jsonrpc": "2.0", "id": "server-discover-probe-1", "method": "server/discover",
            "params": { "_meta": {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientInfo": { "name": "c", "title": "C", "version": "1", "description": "d", "websiteUrl": "https://example.invalid" },
                "io.modelcontextprotocol/clientCapabilities": { "roots": {}, "elicitation": {}, "extensions": { "tasks": {} } }
            } } });
        let want = "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":\"server-discover-probe-1\",\"error\":{\"code\":-32601,\"message\":\"Method not found\"}}\n\n";
        assert_eq!(want.len(), 124);
        assert_eq!(answer(&probe, None), Some(Reply::Sse(want.into())));
        assert_eq!(answer(&json!([probe]), None), None);
        // 다른 모르는 메서드는 그대로 TS.
        let other = json!({ "jsonrpc": "2.0", "id": 1, "method": "resources/list" });
        assert_eq!(answer(&other, None), None);
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
