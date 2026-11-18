//! C4a 뼈대 — MCP(`POST /mcp`, TS `mcp/mcpPlugin.ts`)를 Rust 코어로 옮기는 자리. 라우트는 [`route`] (C4a-1: 게이트·한도 뒤 전부 TS 로 투명 전달).
//!
//! TS 쪽 사실(옮길 때 지킬 계약):
//! - 전송은 streamable HTTP **무상태**다(`sessionIdGenerator: undefined`, mcpPlugin.ts `registerMcp`). 요청마다 서버·전송을 새로 만들고
//!   `mcp-session-id` 를 주지도 받지도 않는다 → 한 JSON-RPC 요청 단위로 Rust/TS 를 갈라 보낼 수 있다.
//! - 인가는 전역 auth 훅(`auth/plugin.ts`)이 세운 `req.account` 가 `kind = 'agent'` 일 때만(에이전트 PAT · 오퍼레이터 토큰 +
//!   `X-Harkroom-Agent` 배정). 아니면 401/403 `{ error: { code: 'agent_only' } }`.
//! - 도구의 실패는 JSON-RPC 오류가 아니라 **성공 결과** `content[0].text = {"error":{code,message}}` 다([`tool_error`]).
//! - 모든 도구를 감싸는 층: 비밀 본문 거절(leakGuard) · 백그라운드 회차 허용 목록(`BG_ALLOWED_TOOLS`) · 쓰기 출처 ·
//!   presence mark(요청마다). Rust 가 도구를 받으려면 이 넷을 같이 가져야 한다.
pub mod bg_claim;
pub mod bg_complete;
pub mod delegate_gate;
pub mod grant_writes;
pub mod mem_audit;
pub mod mem_body;
pub mod mem_recall;
pub mod mem_writes;
pub mod model_options;
pub mod msg_post;
pub mod note;
pub mod reads2;
pub mod reads3;
pub mod reads4;
pub mod respond;
pub mod route;
pub mod search;
pub mod tools;
pub mod turn_cancel;
pub mod turn_wake;
pub mod workitem;
pub mod writes;

use serde_json::{Value, json};

/// 도구가 무엇을 하는가 — 갈라 보낼 때 Rust 가 받을 수 있는지의 첫 판정.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Access {
    /// 순수 읽기(DB 를 바꾸지 않는다).
    Read,
    /// 읽기처럼 보이나 부수효과가 있다(읽음 표시·호출 셈·리스 등).
    ReadSide,
    Write,
    /// 서버가 아니라 오퍼레이터가 답한다(`operatorOnly`).
    Operator,
}

#[derive(Debug, Clone, Copy)]
pub struct ToolSpec {
    pub name: &'static str,
    pub access: Access,
    /// 지금 코어 모듈(msg_list·channels·audience·auth)로 답할 수 있는 후보.
    pub core_candidate: bool,
}

const fn t(name: &'static str, access: Access, core_candidate: bool) -> ToolSpec {
    ToolSpec {
        name,
        access,
        core_candidate,
    }
}

use Access::{Operator as O, Read as R, ReadSide as S, Write as W};

/// TS 가 등록하는 도구 전부(등록 순서). `delegation.close` 는 스위치(`delegationV2Enabled`)가 켜졌을 때만 실린다.
pub const TOOLS: &[ToolSpec] = &[
    t("workspace.guide", R, true),
    t("account.me", R, true),
    t("agent.modelOptions", R, false),
    t("account.list", R, true),
    t("channel.list", R, true),
    t("channel.doc", R, true),
    t("message.read", R, true),
    t("message.search", R, false),
    t("message.post", W, false),
    t("message.progress", W, false),
    t("message.notice", W, false),
    t("artifact.publish", W, false),
    t("message.ask", W, false),
    t("message.askBundle", W, false),
    t("message.askBundleResolve", W, false),
    t("permission.request", W, false),
    t("permission.revoke", W, false),
    t("delegation.close", W, false),
    t("message.fail", W, false),
    t("message.delegate", W, false),
    t("message.report", W, false),
    t("message.react", W, false),
    t("message.unreact", W, false),
    t("inbox.poll", S, false),
    t("inbox.read", W, false),
    t("memory.list", R, false),
    t("memory.get", S, false),
    t("memory.search", S, false),
    t("memory.recalled", W, false),
    t("memory.audit", R, false),
    t("memory.set", W, false),
    t("bg.claim", W, false),
    t("bg.complete", W, false),
    t("thread.note", S, false),
    t("thread.note.list", R, false),
    t("thread.plan", S, false),
    t("thread.plan.item", W, false),
    t("memory.archive", W, false),
    t("memory.unarchive", W, false),
    t("memory.merge", W, false),
    t("memory.revisions", R, false),
    t("memory.restore", W, false),
    t("memory.lease", W, false),
    t("skill.propose", W, false),
    t("automation.propose", W, false),
    t("automation.list", R, false),
    t("automation.run", W, false),
    t("workitem.upsert", W, false),
    t("workitem.list", R, false),
    t("workitem.remove", W, false),
    t("turn.wake", W, false),
    t("turn.cancel", W, false),
    t("secret.list", R, false),
    t("grant.delegate", W, false),
    t("grant.revoke", W, false),
    t("grant.list", R, false),
    t("secret.mount", O, false),
    t("secret.generate", O, false),
    t("secret.import", O, false),
    t("secret.rotate", O, false),
    t("attachment.upload", O, false),
    t("pr.status", O, false),
    t("pr.watch", W, false),
    t("attachment.fetch", R, false),
];

pub fn find(name: &str) -> Option<&'static ToolSpec> {
    TOOLS.iter().find(|s| s.name == name)
}

/// TS `jsonResult` 와 같은 모양 — 도구의 답은 JSON 한 덩이를 text 로 싣는다.
pub fn json_result(value: &Value) -> Value {
    json!({ "content": [{ "type": "text", "text": value.to_string() }] })
}

/// 도구의 거절. JSON-RPC 오류가 아니라 성공 결과 안의 `error` 다(TS 와 같다).
pub fn tool_error(code: &str, message: &str) -> Value {
    json_result(&json!({ "error": { "code": code, "message": message } }))
}

/// 한 JSON-RPC 요청을 어디서 답할지 — 무상태라 요청 하나씩 고른다. 지금은 모두 TS 다(라우트 미부착).
#[derive(Debug, PartialEq, Eq)]
pub enum Dispatch {
    Rust(&'static str),
    Ts,
}

/// `tools/call` 이고 `served` 에 든 도구만 Rust. `initialize`·`tools/list`·배치·알림은 TS 로 넘겨 스키마 정본을 하나로 둔다.
pub fn dispatch(body: &Value, served: &[&str]) -> Dispatch {
    if body.get("method").and_then(Value::as_str) != Some("tools/call") {
        return Dispatch::Ts;
    }
    let Some(name) = body.pointer("/params/name").and_then(Value::as_str) else {
        return Dispatch::Ts;
    };
    match find(name) {
        Some(s) if served.contains(&s.name) => Dispatch::Rust(s.name),
        _ => Dispatch::Ts,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 기능 카탈로그 패리티 시험과 같은 방식 — TS 원본의 `registerTool('…'` 을 읽어 표와 맞춘다. 도구가 늘거나 빠지면 여기서 깨진다.
    #[test]
    fn registry_matches_ts_source() {
        let src = include_str!("../../../../../packages/server/src/mcp/mcpPlugin.ts");
        let mut ts = Vec::new();
        for (i, _) in src.match_indices("server.registerTool('") {
            let rest = &src[i + "server.registerTool('".len()..];
            ts.push(&rest[..rest.find('\'').unwrap()]);
        }
        let ours: Vec<&str> = TOOLS.iter().map(|s| s.name).collect();
        assert_eq!(ts, ours);
    }

    #[test]
    fn core_candidates_are_pure_reads() {
        for s in TOOLS.iter().filter(|s| s.core_candidate) {
            assert_eq!(s.access, Access::Read, "{}", s.name);
        }
    }

    #[test]
    fn dispatch_only_served_calls() {
        let call = |n: &str| json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": n, "arguments": {} } });
        assert_eq!(
            dispatch(&call("channel.list"), &["channel.list"]),
            Dispatch::Rust("channel.list")
        );
        assert_eq!(
            dispatch(&call("message.post"), &["channel.list"]),
            Dispatch::Ts
        );
        assert_eq!(dispatch(&call("nope"), &["nope"]), Dispatch::Ts);
        assert_eq!(
            dispatch(
                &json!({ "method": "tools/list", "id": 1 }),
                &["channel.list"]
            ),
            Dispatch::Ts
        );
        assert_eq!(
            dispatch(&json!([call("channel.list")]), &["channel.list"]),
            Dispatch::Ts
        );
    }

    #[test]
    fn error_shape() {
        let v = tool_error("agent_only", "x");
        let inner: Value = serde_json::from_str(v["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(inner["error"]["code"], "agent_only");
    }
}
