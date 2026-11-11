//! 전달 — 러너가 서버에 하던 말을 오퍼레이터가 대신 한다. TS `packages/operator/src/forward.ts` 이식(s21b-2).
//!
//! **인증만 바꾼다.** `authorization` 을 오퍼레이터 토큰으로, `x-harkroom-agent` 를 `expect` 장부의 에이전트 id 로.
//! 본문은 열지 않는다. 러너가 보낸 머리는 옮기지 않는다 — 머리는 전부 여기서 새로 짓는다.
//!
//! MCP 는 Streamable HTTP 라 요청 하나가 POST 하나다. 답은 JSON 한 개·SSE 스트림·202 빈 본문 셋 중 하나이고,
//! 셋을 전부 JSON-RPC 메시지 **목록**으로 편다.
//!
//! TS 와 다른 점: `http.forward` 는 **러너 코어 소켓(relay)** 에서 온 것만, **허용 목록**([`REST_ALLOW`])에 있는
//! (메서드, 경로) 만 넘긴다. 경로는 쿼리 앞까지 정확히 일치해야 한다. TS 는 「베이스 아래 경로」만 보아 오퍼레이터
//! 토큰으로 서버의 어떤 REST 든 부를 수 있었다(s21b-2 security 후속). 목록은 TS 러너가 실제로 부르는 19개이고,
//! `tests` 의 회귀 시험이 TS 정본에서 다시 뽑아 비교한다.

use std::time::Duration;

use base64::Engine;
use harkroom_proto::p1::{RunnerLinkKind, RunnerLinkRequest, RunnerLinkResponse};
use serde_json::{Value, json};

/// TS `CAUSE_HEADER`.
pub const CAUSE_HEADER: &str = "x-harkroom-cause";
/// TS `TURN_ID_HEADER`.
pub const TURN_ID_HEADER: &str = "x-harkroom-turn-id";
/// TS `COMMAND_FILES_HEADER`.
pub const COMMAND_FILES_HEADER: &str = "x-harkroom-command-files";
pub const AGENT_HEADER: &str = "x-harkroom-agent";

/// 러너 코어가 `http.forward` 로 부르는 (메서드, 경로) 전부. 출처: `packages/agent/src/harkroom.ts`(rest 10 + 직접 8)
/// ·`turnKeys.ts`(2, 그중 하나는 harkroom.ts 와 겹치지 않는다) — 합 19. 오퍼레이터 자체 전달(turnApi·turnCommand·
/// turnPrStatus·turnPeek·prWatchPoller)은 러너 링크를 거치지 않으므로 여기 없다.
pub const REST_ALLOW: &[(&str, &str)] = &[
    ("GET", "/agent/config"),
    ("GET", "/agent/thread-model"),
    ("GET", "/agent/api-grants"),
    ("GET", "/agent/secret-create"),
    ("GET", "/agent/merge-grants"),
    ("GET", "/agent/tool-allows"),
    ("GET", "/accounts"),
    ("GET", "/skills"),
    ("POST", "/agent/activity"),
    ("POST", "/skills/usage"),
    ("POST", "/agent/turn-leases"),
    ("POST", "/agent/thread-claims"),
    ("POST", "/agent/thread-claims/release"),
    ("POST", "/agent/cleanup-report"),
    ("POST", "/agent/turn-slots"),
    ("POST", "/agent/turn-slots/release"),
    ("POST", "/agent/provider-lane/mount"),
    ("POST", "/agent/turn-keys"),
    ("POST", "/agent/turn-keys/end"),
];

/// 전달 대상. `agent_id` 는 `expect` 장부 값이다 — 러너의 주장이 아니다.
#[derive(Clone)]
pub struct ForwardTarget {
    pub base_url: String,
    pub token: String,
    pub agent_id: String,
}

impl std::fmt::Debug for ForwardTarget {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ForwardTarget")
            .field("base_url", &self.base_url)
            .field("token", &"<redacted>")
            .field("agent_id", &self.agent_id)
            .finish()
    }
}

/// HTTP 한 번의 답.
pub struct HttpReply {
    pub status: u16,
    pub content_type: String,
    pub body: String,
}

impl std::fmt::Debug for HttpReply {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HttpReply")
            .field("status", &self.status)
            .field("content_type", &self.content_type)
            .field("body_len", &self.body.len())
            .finish()
    }
}

/// HTTP 를 내는 쪽. 시험은 가짜를 준다. Err 는 연결 자체의 실패다(status 0).
pub trait Transport: Send + Sync {
    fn send(
        &self,
        method: &str,
        url: &str,
        headers: &[(String, String)],
        body: Option<Vec<u8>>,
    ) -> Result<HttpReply, String>;
}

/// ureq 판. MCP 롱폴(`inbox.poll` 25초)을 넘기도록 넉넉히 둔다.
pub struct UreqTransport {
    agent: ureq::Agent,
}

impl Default for UreqTransport {
    fn default() -> Self {
        Self {
            agent: ureq::Agent::new_with_config(
                ureq::Agent::config_builder()
                    .http_status_as_error(false)
                    .timeout_global(Some(Duration::from_secs(120)))
                    .build(),
            ),
        }
    }
}

impl Transport for UreqTransport {
    fn send(
        &self,
        method: &str,
        url: &str,
        headers: &[(String, String)],
        body: Option<Vec<u8>>,
    ) -> Result<HttpReply, String> {
        let m = ureq::http::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?;
        let mut b = ureq::http::Request::builder().method(m).uri(url);
        for (k, v) in headers {
            b = b.header(k.as_str(), v.as_str());
        }
        let req = b
            .body(body.unwrap_or_default())
            .map_err(|e| e.to_string())?;
        let mut res = self.agent.run(req).map_err(|e| e.to_string())?;
        let status = res.status().as_u16();
        let content_type = res
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        let body = res
            .body_mut()
            .with_config()
            .limit(crate::runner_link::RUNNER_LINK_MAX_LINE_BYTES as u64)
            .read_to_string()
            .map_err(|e| e.to_string())?;
        Ok(HttpReply {
            status,
            content_type,
            body,
        })
    }
}

/// SSE 본문에서 `data:` 줄들을 JSON 으로 편다. 파싱 안 되는 이벤트는 버린다 — 지어내지 않는다(TS `parseSseMessages`).
pub fn parse_sse_messages(text: &str) -> Vec<Value> {
    let norm = text.replace("\r\n", "\n");
    let mut out = Vec::new();
    for block in norm.split("\n\n") {
        let data: Vec<&str> = block
            .split('\n')
            .filter_map(|l| l.strip_prefix("data:"))
            .map(str::trim_start)
            .collect();
        if data.is_empty() {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<Value>(&data.join("\n")) {
            out.push(v);
        }
    }
    out
}

/// 경로(쿼리 앞)·메서드가 허용 목록에 있나. 상위 이동·절대 URL·`//` 은 목록에 있을 수 없으니 함께 막힌다.
pub fn rest_allowed(method: &str, path: &str) -> bool {
    let bare = path.split(['?', '#']).next().unwrap_or("");
    REST_ALLOW.iter().any(|(m, p)| *m == method && *p == bare)
        && !path.contains("..")
        && !path.contains('#')
}

/// 링크에서 들어온 요청의 「오퍼레이터만 채우는 칸」을 지운다(TS `turnCommand.stripLinkOnlyFields`).
/// `commandFiles` 는 오퍼레이터가 잰 값만 서버에 간다 — 재는 쪽(s21b-3) 전까지는 늘 비운다.
pub fn strip_link_only_fields(req: RunnerLinkRequest) -> RunnerLinkRequest {
    match req {
        RunnerLinkRequest::McpRequest {
            id,
            payload,
            cause,
            cwd,
            turn_id,
            ..
        } => RunnerLinkRequest::McpRequest {
            id,
            payload,
            cause,
            cwd,
            turn_id,
            command_files: None,
        },
        other => other,
    }
}

fn base_headers(t: &ForwardTarget) -> Vec<(String, String)> {
    vec![
        ("authorization".into(), format!("Bearer {}", t.token)),
        (AGENT_HEADER.into(), t.agent_id.clone()),
    ]
}

/// 머리값으로 못 쓰는 글자(제어 문자)가 있으면 그 머리는 싣지 않는다 — 머리 주입을 막는다.
fn header_safe(v: &str) -> bool {
    !v.is_empty() && v.len() <= 4096 && v.bytes().all(|b| b == b'\t' || (0x20..0x7f).contains(&b))
}

/// 요청 하나를 서버로. `kind` 는 그 요청이 들어온 소켓의 종류다 — `http.forward` 는 relay 에서 온 것만 넘긴다.
pub fn forward(
    tr: &dyn Transport,
    target: &ForwardTarget,
    req: RunnerLinkRequest,
    kind: RunnerLinkKind,
) -> RunnerLinkResponse {
    let base = target.base_url.trim_end_matches('/');
    match req {
        RunnerLinkRequest::McpRequest {
            id,
            payload,
            cause,
            turn_id,
            command_files,
            ..
        } => {
            let mut h = base_headers(target);
            for (name, v) in [
                (CAUSE_HEADER, cause),
                (TURN_ID_HEADER, turn_id),
                (COMMAND_FILES_HEADER, command_files),
            ] {
                if let Some(v) = v.filter(|v| header_safe(v)) {
                    h.push((name.into(), v));
                }
            }
            h.push(("content-type".into(), "application/json".into()));
            h.push((
                "accept".into(),
                "application/json, text/event-stream".into(),
            ));
            let body = serde_json::to_vec(&payload).unwrap_or_default();
            let res = match tr.send("POST", &format!("{base}/mcp"), &h, Some(body)) {
                Ok(r) => r,
                Err(message) => {
                    return RunnerLinkResponse::McpError {
                        id,
                        status: 0,
                        message,
                    };
                }
            };
            if !(200..300).contains(&res.status) {
                let message = if res.body.is_empty() {
                    format!("HTTP {}", res.status)
                } else {
                    res.body
                };
                return RunnerLinkResponse::McpError {
                    id,
                    status: res.status,
                    message,
                };
            }
            if res.status == 202 || res.status == 204 {
                return RunnerLinkResponse::McpResponse {
                    id,
                    messages: vec![],
                };
            }
            if res.content_type.contains("text/event-stream") {
                return RunnerLinkResponse::McpResponse {
                    id,
                    messages: parse_sse_messages(&res.body),
                };
            }
            if res.body.trim().is_empty() {
                return RunnerLinkResponse::McpResponse {
                    id,
                    messages: vec![],
                };
            }
            match serde_json::from_str::<Value>(&res.body) {
                Ok(Value::Array(a)) => RunnerLinkResponse::McpResponse { id, messages: a },
                Ok(v) => RunnerLinkResponse::McpResponse {
                    id,
                    messages: vec![v],
                },
                Err(_) => RunnerLinkResponse::McpError {
                    id,
                    status: res.status,
                    message: "MCP 응답을 JSON 으로 읽지 못했다".into(),
                },
            }
        }
        RunnerLinkRequest::HttpForward {
            id,
            method,
            path,
            body,
            body_base64,
            content_type,
        } => {
            if kind != RunnerLinkKind::Relay {
                return bad(
                    id,
                    403,
                    "not_allowed",
                    "REST 전달은 러너 코어 소켓에서만 받는다",
                );
            }
            if !rest_allowed(&method, &path) {
                return bad(id, 403, "not_allowed", "허용 목록에 없는 경로다");
            }
            let mut h = base_headers(target);
            if let Some(ct) = content_type.filter(|v| header_safe(v)) {
                h.push(("content-type".into(), ct));
            }
            let payload = match (body_base64, body) {
                (Some(b64), _) => match base64::engine::general_purpose::STANDARD.decode(b64) {
                    Ok(b) => Some(b),
                    Err(_) => return bad(id, 400, "bad_body", "bodyBase64 를 읽지 못했다"),
                },
                (None, Some(s)) => Some(s.into_bytes()),
                (None, None) => None,
            };
            match tr.send(&method, &format!("{base}{path}"), &h, payload) {
                Ok(r) => RunnerLinkResponse::HttpResponse {
                    id,
                    status: r.status,
                    body: r.body,
                },
                Err(e) => RunnerLinkResponse::HttpResponse {
                    id,
                    status: 0,
                    body: e,
                },
            }
        }
    }
}

fn bad(id: String, status: u16, code: &str, message: &str) -> RunnerLinkResponse {
    RunnerLinkResponse::HttpResponse {
        id,
        status,
        body: json!({ "error": { "code": code, "message": message } }).to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    type Call = (String, String, Vec<(String, String)>, Option<Vec<u8>>);
    type Canned = Result<(u16, String, String), String>;

    #[derive(Default)]
    struct Fake {
        calls: Mutex<Vec<Call>>,
        reply: Mutex<Option<Canned>>,
    }

    impl Fake {
        fn replying(status: u16, ct: &str, body: &str) -> Self {
            let f = Fake::default();
            *f.reply.lock().unwrap() = Some(Ok((status, ct.into(), body.into())));
            f
        }
    }

    impl Transport for Fake {
        fn send(
            &self,
            method: &str,
            url: &str,
            headers: &[(String, String)],
            body: Option<Vec<u8>>,
        ) -> Result<HttpReply, String> {
            self.calls
                .lock()
                .unwrap()
                .push((method.into(), url.into(), headers.to_vec(), body));
            match self.reply.lock().unwrap().clone().expect("reply") {
                Ok((status, content_type, body)) => Ok(HttpReply {
                    status,
                    content_type,
                    body,
                }),
                Err(e) => Err(e),
            }
        }
    }

    fn target() -> ForwardTarget {
        ForwardTarget {
            base_url: "https://srv.example/api/".into(),
            token: "op-token".into(),
            agent_id: "agent-1".into(),
        }
    }

    fn mcp(cause: Option<&str>, files: Option<&str>) -> RunnerLinkRequest {
        RunnerLinkRequest::McpRequest {
            id: "r1".into(),
            payload: json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}),
            cause: cause.map(str::to_string),
            cwd: Some("/w".into()),
            turn_id: Some("t1".into()),
            command_files: files.map(str::to_string),
        }
    }

    fn rest(method: &str, path: &str) -> RunnerLinkRequest {
        RunnerLinkRequest::HttpForward {
            id: "h1".into(),
            method: method.into(),
            path: path.into(),
            body: Some("{}".into()),
            body_base64: None,
            content_type: Some("application/json".into()),
        }
    }

    fn header<'a>(h: &'a [(String, String)], k: &str) -> Option<&'a str> {
        h.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str())
    }

    #[test]
    fn mcp_json_reply_becomes_one_message_with_rewritten_auth() {
        let f = Fake::replying(
            200,
            "application/json",
            r#"{"jsonrpc":"2.0","id":1,"result":{}}"#,
        );
        let r = forward(&f, &target(), mcp(Some("c1"), None), RunnerLinkKind::Bridge);
        assert_eq!(
            r,
            RunnerLinkResponse::McpResponse {
                id: "r1".into(),
                messages: vec![json!({"jsonrpc":"2.0","id":1,"result":{}})]
            }
        );
        let calls = f.calls.lock().unwrap();
        let (m, url, h, _) = &calls[0];
        assert_eq!(
            (m.as_str(), url.as_str()),
            ("POST", "https://srv.example/api/mcp")
        );
        assert_eq!(header(h, "authorization"), Some("Bearer op-token"));
        assert_eq!(header(h, AGENT_HEADER), Some("agent-1"));
        assert_eq!(header(h, CAUSE_HEADER), Some("c1"));
        assert_eq!(header(h, TURN_ID_HEADER), Some("t1"));
        assert_eq!(header(h, COMMAND_FILES_HEADER), None);
    }

    #[test]
    fn mcp_sse_and_202_and_errors() {
        let sse = "event: message\ndata: {\"id\":1}\n\ndata: broken\n\r\ndata: {\"id\":2}\n\n";
        let f = Fake::replying(200, "text/event-stream", sse);
        let r = forward(&f, &target(), mcp(None, None), RunnerLinkKind::Relay);
        assert_eq!(
            r,
            RunnerLinkResponse::McpResponse {
                id: "r1".into(),
                messages: vec![json!({"id":1}), json!({"id":2})]
            }
        );
        let f = Fake::replying(202, "", "");
        assert_eq!(
            forward(&f, &target(), mcp(None, None), RunnerLinkKind::Relay),
            RunnerLinkResponse::McpResponse {
                id: "r1".into(),
                messages: vec![]
            }
        );
        let f = Fake::replying(401, "text/plain", "nope");
        assert_eq!(
            forward(&f, &target(), mcp(None, None), RunnerLinkKind::Relay),
            RunnerLinkResponse::McpError {
                id: "r1".into(),
                status: 401,
                message: "nope".into()
            }
        );
        let f = Fake::default();
        *f.reply.lock().unwrap() = Some(Err("refused".into()));
        assert_eq!(
            forward(&f, &target(), mcp(None, None), RunnerLinkKind::Relay),
            RunnerLinkResponse::McpError {
                id: "r1".into(),
                status: 0,
                message: "refused".into()
            }
        );
        let f = Fake::replying(200, "application/json", "[{\"a\":1},{\"b\":2}]");
        match forward(&f, &target(), mcp(None, None), RunnerLinkKind::Relay) {
            RunnerLinkResponse::McpResponse { messages, .. } => assert_eq!(messages.len(), 2),
            other => panic!("{other:?}"),
        }
        let f = Fake::replying(200, "application/json", "not json");
        assert!(matches!(
            forward(&f, &target(), mcp(None, None), RunnerLinkKind::Relay),
            RunnerLinkResponse::McpError { status: 200, .. }
        ));
    }

    #[test]
    fn header_injection_values_are_dropped() {
        let f = Fake::replying(202, "", "");
        forward(
            &f,
            &target(),
            mcp(Some("c\r\nx-evil: 1"), None),
            RunnerLinkKind::Relay,
        );
        let calls = f.calls.lock().unwrap();
        assert_eq!(header(&calls[0].2, CAUSE_HEADER), None);
    }

    #[test]
    fn strip_link_only_fields_clears_command_files() {
        let r = strip_link_only_fields(mcp(None, Some("sha")));
        let f = Fake::replying(202, "", "");
        forward(&f, &target(), r, RunnerLinkKind::Relay);
        assert_eq!(
            header(&f.calls.lock().unwrap()[0].2, COMMAND_FILES_HEADER),
            None
        );
    }

    #[test]
    fn rest_forward_only_allowlisted_from_relay() {
        let f = Fake::replying(200, "application/json", "{\"ok\":true}");
        let r = forward(
            &f,
            &target(),
            rest("GET", "/agent/tool-allows?channelId=c"),
            RunnerLinkKind::Relay,
        );
        assert_eq!(
            r,
            RunnerLinkResponse::HttpResponse {
                id: "h1".into(),
                status: 200,
                body: "{\"ok\":true}".into()
            }
        );
        {
            let calls = f.calls.lock().unwrap();
            assert_eq!(
                calls[0].1,
                "https://srv.example/api/agent/tool-allows?channelId=c"
            );
            assert_eq!(
                header(&calls[0].2, "authorization"),
                Some("Bearer op-token")
            );
            assert_eq!(
                header(&calls[0].2, "content-type"),
                Some("application/json")
            );
        }
        for (kind, m, p) in [
            (RunnerLinkKind::Bridge, "GET", "/agent/config"),
            (RunnerLinkKind::Hook, "GET", "/agent/config"),
            (RunnerLinkKind::Wrapper, "GET", "/agent/config"),
            (RunnerLinkKind::Relay, "POST", "/agent/config"),
            (RunnerLinkKind::Relay, "GET", "/agent/config/x"),
            (RunnerLinkKind::Relay, "GET", "/agent/../admin"),
            (RunnerLinkKind::Relay, "GET", "//evil.example/agent/config"),
            (
                RunnerLinkKind::Relay,
                "GET",
                "https://evil.example/agent/config",
            ),
            (RunnerLinkKind::Relay, "DELETE", "/accounts"),
            (RunnerLinkKind::Relay, "GET", "/agent/config#x"),
            (RunnerLinkKind::Relay, "GET", "/agent/api-checks"),
            (RunnerLinkKind::Relay, "get", "/agent/config"),
        ] {
            let before = f.calls.lock().unwrap().len();
            let r = forward(&f, &target(), rest(m, p), kind);
            assert!(
                matches!(r, RunnerLinkResponse::HttpResponse { status: 403, .. }),
                "{kind:?} {m} {p}"
            );
            assert_eq!(
                f.calls.lock().unwrap().len(),
                before,
                "{m} {p} 는 나가면 안 된다"
            );
        }
    }

    #[test]
    fn rest_body_base64() {
        let f = Fake::replying(200, "", "");
        let req = RunnerLinkRequest::HttpForward {
            id: "h".into(),
            method: "POST".into(),
            path: "/skills/usage".into(),
            body: Some("ignored".into()),
            body_base64: Some("aGk=".into()),
            content_type: None,
        };
        forward(&f, &target(), req, RunnerLinkKind::Relay);
        assert_eq!(f.calls.lock().unwrap()[0].3.as_deref(), Some(&b"hi"[..]));
    }

    /// TS 정본(러너 코어)에서 `http.forward` 경로를 다시 뽑아 [`REST_ALLOW`] 와 같은지 본다.
    /// 러너가 새 REST 를 부르기 시작하면 여기서 깨진다 — 목록에 더할지 security 와 정한다.
    #[test]
    fn allowlist_matches_ts_runner_sources() {
        let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../../packages");
        let read = |p: &str| std::fs::read_to_string(format!("{root}/{p}")).unwrap_or_default();
        let agent = read("agent/src/harkroom.ts");
        if agent.is_empty() {
            eprintln!("TS 정본이 없다 — 건너뜀");
            return;
        }
        // 상수 이름 → 경로(공유 패키지).
        let mut consts = std::collections::HashMap::new();
        for f in [
            "shared/src/runnerLink.ts",
            "shared/src/workspaceCleanup.ts",
            "shared/src/providerLane.ts",
        ] {
            for line in read(f).lines() {
                if let Some(rest) = line.strip_prefix("export const ")
                    && let Some((name, val)) = rest.split_once(" = '")
                    && let Some(path) = val.strip_suffix("';")
                    && path.starts_with('/')
                {
                    consts.insert(name.trim().to_string(), path.to_string());
                }
            }
        }
        let mut found = std::collections::BTreeSet::new();
        let mut files = vec![agent];
        if let Ok(dir) = std::fs::read_dir(format!("{root}/agent/src")) {
            for e in dir.flatten() {
                let n = e.file_name().to_string_lossy().to_string();
                if n.ends_with(".ts") && !n.contains(".test.") && n != "harkroom.ts" {
                    files.push(std::fs::read_to_string(e.path()).unwrap_or_default());
                }
            }
        }
        let path_of = |s: &str| -> Option<String> {
            let s = s.trim_start();
            if let Some(q) = s.strip_prefix('\'').or_else(|| s.strip_prefix('`')) {
                let end = q.find(['\'', '`', '?', '$'])?;
                return Some(q[..end].to_string());
            }
            let name: String = s
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
                .collect();
            consts.get(&name).cloned()
        };
        for src in &files {
            // this.rest<...>('GET', '/x', ...) / this.rest('POST', ...)
            for (i, _) in src.match_indices("this.rest") {
                let tail = &src[i..];
                let Some(open) = tail.find("('") else {
                    continue;
                };
                let args = &tail[open + 2..];
                let Some((m, after)) = args.split_once("',") else {
                    continue;
                };
                if let Some(p) = path_of(after) {
                    found.insert((m.to_string(), p));
                }
            }
            // type: 'http.forward', method: 'POST', path: X
            for (i, _) in src.match_indices("type: 'http.forward'") {
                let mut end = src.len().min(i + 300);
                while !src.is_char_boundary(end) {
                    end -= 1;
                }
                let tail = &src[i..end];
                let Some(mi) = tail.find("method: '") else {
                    continue;
                };
                let m: String = tail[mi + 9..].chars().take_while(|c| *c != '\'').collect();
                let Some(pi) = tail.find("path: ") else {
                    continue;
                };
                if let Some(p) = path_of(&tail[pi + 6..]) {
                    found.insert((m, p));
                }
            }
        }
        let want: std::collections::BTreeSet<(String, String)> = REST_ALLOW
            .iter()
            .map(|(m, p)| (m.to_string(), p.to_string()))
            .collect();
        assert_eq!(found, want, "TS 러너가 부르는 REST 와 허용 목록이 다르다");
    }
}
