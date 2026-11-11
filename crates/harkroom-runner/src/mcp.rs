//! `HarkroomAgentClient`(`packages/agent/src/harkroom.ts`)의 **MCP 절반** — `call()`·`inbox.poll`·`message.*`·기억·계획·bg.
//! REST 절반은 `rest.rs` 다.
//!
//! MCP 는 링크 위의 `mcp.request` 로 간다. 오퍼레이터가 JSON-RPC 메시지 한 개를 서버 `/mcp` 에 넘기고 인증을 붙인다 —
//! 그래서 여기에도 PAT·URL 이 없다. 서버 MCP 는 상태 없는(stateless) 꼴이라 세션 id 가 없다. 정본(SDK `Client`)처럼
//! 첫 호출 앞에 `initialize` + `notifications/initialized` 를 한 번 보내고, `reset()` 뒤에는 다시 보낸다.
//!
//! 정본과 다른 점(일부러):
//! - 결과 모양을 `as T` 로 믿지 않는다. 메시지·배치는 `serde_json::Value` 로 돌려주고, 칸을 꺼내는 메서드는 모양이 틀리면
//!   정본의 거름과 같은 쪽(오류·`None`)으로 간다.
//! - `notice()` 의 옛 서버 대체 본문은 `prompt.ts::runnerNoticeFallbackBody` 몫이라(프롬프트 조각은 B3d) 부르는 쪽이 넘긴다.

use harkroom_proto::p1::RunnerLinkResponse;
use serde_json::{Map, Value, json};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::link::LinkRequest;
use crate::rest::{HarkroomError, RunnerLink};

/// 정본 SDK `LATEST_PROTOCOL_VERSION`(@modelcontextprotocol/sdk 1.30.0).
pub const MCP_PROTOCOL_VERSION: &str = "2025-11-25";
/// 정본 `Client({ name })`.
pub const MCP_CLIENT_NAME: &str = "harkroom-agent";
/// 정본 `RUNNER_OPT_IN_INBOX_REASONS`(`@harkroom/shared`).
pub const RUNNER_OPT_IN_INBOX_REASONS: [&str; 1] = ["delegation_update"];

/// 정본 `isUnknownTool` — 서버가 그 도구를 모른다(옛 서버). **도구 이름까지** 맞춰 본다.
pub fn is_unknown_tool(err: &HarkroomError, name: &str) -> bool {
    err.message.contains(&format!("Tool {name} not found"))
}

/// `message.fail` 의 선택 칸들(정본 `FailOpts`). 있을 때만 싣는다.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FailOpts {
    pub retryable: bool,
    pub what: Option<String>,
    pub reason: Option<String>,
    pub code: Option<String>,
    pub lane_code: Option<String>,
    pub mention_id: Option<String>,
    pub account: Option<String>,
}

/// `inbox.poll` 의 lane·임대 인자(정본 `pollInbox` 의 `claudeLane`·`lease`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaudeLane {
    pub pool: Option<String>,
    pub accounts: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PollLease {
    pub runner_id: String,
    pub holding: Vec<i64>,
}

/// 스레드 메모(`thread.note`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThreadNote {
    pub body: String,
    pub updated_at: String,
    pub flagged: Option<String>,
}

/// 백그라운드 일감(`bg.claim`).
#[derive(Debug, Clone, PartialEq)]
pub struct BgJob {
    pub id: String,
    pub kind: String,
    pub day: String,
    pub input: Value,
}

pub struct HarkroomMcpClient<L: RunnerLink> {
    link: L,
    version: String,
    initialized: Mutex<bool>,
    next_id: AtomicU64,
}

fn err(message: String, status: Option<u16>) -> HarkroomError {
    HarkroomError::new(message, status)
}

fn put(obj: &mut Map<String, Value>, key: &str, v: &Option<String>) {
    if let Some(v) = v.as_ref().filter(|s| !s.is_empty()) {
        obj.insert(key.into(), json!(v));
    }
}

impl<L: RunnerLink> HarkroomMcpClient<L> {
    /// `version` 은 서버에 알리는 러너 판(정본 `VERSION`).
    pub fn new(link: L, version: impl Into<String>) -> Self {
        Self {
            link,
            version: version.into(),
            initialized: Mutex::new(false),
            next_id: AtomicU64::new(0),
        }
    }

    /// 서버 재시작·절단 뒤 다음 호출이 다시 `initialize` 하도록 버린다(정본 `reset()`).
    pub fn reset(&self) {
        *self.initialized.lock().unwrap_or_else(|p| p.into_inner()) = false;
    }

    /// JSON-RPC 메시지 한 개를 링크로 보낸다. 링크·서버의 HTTP 거절은 `status` 를 싣는다(정본 `tagTransportError`) —
    /// `status: 0` 은 링크가 끊긴 것이라 자격 실패가 아니다.
    fn send(&self, payload: Value) -> Result<Vec<Value>, HarkroomError> {
        match self.link.request(LinkRequest::Mcp { payload }) {
            RunnerLinkResponse::McpResponse { messages, .. } => Ok(messages),
            RunnerLinkResponse::McpError {
                status, message, ..
            } => Err(err(message, (status > 0).then_some(status))),
            RunnerLinkResponse::HttpResponse { .. } => {
                Err(err("mcp.request 에 http 답이 왔다".into(), None))
            }
        }
    }

    /// 요청 하나 — 같은 id 의 답을 찾는다. JSON-RPC 오류는 SDK 의 `McpError` 문구(`MCP error <code>: <message>`)로 던진다.
    fn rpc(&self, method: &str, params: Value) -> Result<Value, HarkroomError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let messages =
            self.send(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))?;
        let reply = messages
            .into_iter()
            .find(|m| m.get("id").and_then(Value::as_u64) == Some(id))
            .ok_or_else(|| err(format!("{method}: 답이 없다"), None))?;
        if let Some(e) = reply.get("error") {
            let code = e.get("code").and_then(Value::as_i64).unwrap_or(0);
            let msg = e.get("message").and_then(Value::as_str).unwrap_or("");
            return Err(err(format!("MCP error {code}: {msg}"), None));
        }
        reply
            .get("result")
            .cloned()
            .ok_or_else(|| err(format!("{method}: result 가 없다"), None))
    }

    fn ensure_initialized(&self) -> Result<(), HarkroomError> {
        let mut ready = self.initialized.lock().unwrap_or_else(|p| p.into_inner());
        if *ready {
            return Ok(());
        }
        let res = self.rpc(
            "initialize",
            json!({
                "protocolVersion": MCP_PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": MCP_CLIENT_NAME, "version": self.version},
            }),
        )?;
        if res.get("protocolVersion").and_then(Value::as_str).is_none() {
            return Err(err("initialize: protocolVersion 이 없다".into(), None));
        }
        self.send(json!({"jsonrpc":"2.0","method":"notifications/initialized"}))?;
        *ready = true;
        Ok(())
    }

    /// 정본 `call()` — 도구 하나를 부르고 첫 text 결과를 JSON 으로 푼다. 접속과 호출이 같은 길이라 401 은 어느 쪽에서든 온다.
    pub fn call(&self, name: &str, args: Value) -> Result<Value, HarkroomError> {
        self.ensure_initialized()?;
        let res = self.rpc("tools/call", json!({"name": name, "arguments": args}))?;
        let text = res
            .get("content")
            .and_then(Value::as_array)
            .and_then(|c| c.first())
            .filter(|f| f.get("type").and_then(Value::as_str) == Some("text"))
            .and_then(|f| f.get("text").and_then(Value::as_str))
            .filter(|t| !t.is_empty())
            .ok_or_else(|| err(format!("{name}: 텍스트 결과가 없다"), None))?;
        let is_error = res.get("isError").and_then(Value::as_bool) == Some(true);
        // 입력 검증 거절은 JSON 이 아니라 `MCP error -32602: …` 글로 온다 — 그 글을 살려 던진다.
        if is_error && !text.trim_start().starts_with('{') {
            let cut: String = text.chars().take(300).collect();
            return Err(err(format!("{name}: {cut}"), None));
        }
        let parsed: Value = serde_json::from_str(text)
            .map_err(|e| err(format!("{name}: JSON 이 아니다 ({e})"), None))?;
        if let Some(e) = parsed.get("error").filter(|e| e.is_object()) {
            let code = e.get("code").and_then(Value::as_str).unwrap_or("");
            let msg = e.get("message").and_then(Value::as_str).unwrap_or("");
            return Err(err(format!("{name}: {code} {msg}"), None));
        }
        Ok(parsed)
    }

    fn seq_of(name: &str, v: &Value) -> Result<i64, HarkroomError> {
        v.pointer("/message/seq")
            .and_then(Value::as_i64)
            .ok_or_else(|| err(format!("{name}: message.seq 가 없다"), None))
    }

    fn messages_of(name: &str, v: Value) -> Result<Vec<Value>, HarkroomError> {
        match v.get("messages") {
            Some(Value::Array(a)) => Ok(a.clone()),
            _ => Err(err(format!("{name}: messages 가 없다"), None)),
        }
    }

    /// `account.me` → (id, handle).
    pub fn me(&self) -> Result<(String, String), HarkroomError> {
        let v = self.call("account.me", json!({}))?;
        match (
            v.get("id").and_then(Value::as_str),
            v.get("handle").and_then(Value::as_str),
        ) {
            (Some(id), Some(h)) => Ok((id.into(), h.into())),
            _ => Err(err("account.me: 모양이 틀리다".into(), None)),
        }
    }

    /// `workspace.guide`(턴용). `avcs` 를 모르면 싣지 않는다 — 서버가 전문을 준다.
    pub fn guide(&self, avcs: Option<bool>) -> Result<String, HarkroomError> {
        let mut args = json!({"mode": "turn"});
        if let Some(a) = avcs {
            args["avcs"] = json!(a);
        }
        let v = self.call("workspace.guide", args)?;
        Ok(match &v {
            Value::String(s) => s.clone(),
            _ => v
                .get("guide")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| v.to_string()),
        })
    }

    /// `channel.list` → (id, name).
    pub fn channels(&self) -> Result<Vec<(String, String)>, HarkroomError> {
        let v = self.call("channel.list", json!({}))?;
        let list = v
            .get("channels")
            .and_then(Value::as_array)
            .ok_or_else(|| err("channel.list: channels 가 없다".into(), None))?;
        Ok(list
            .iter()
            .filter_map(|c| {
                Some((
                    c.get("id")?.as_str()?.to_string(),
                    c.get("name")?.as_str()?.to_string(),
                ))
            })
            .collect())
    }

    /// `memory.list` 그대로(slugs·rev·entries·bgCleanup).
    pub fn list_memory(&self) -> Result<Value, HarkroomError> {
        self.call("memory.list", json!({}))
    }

    /// `memory.get` 의 본문만. 없으면 `None`.
    pub fn get_memory_value(&self, slug: &str) -> Result<Option<String>, HarkroomError> {
        let v = self.call("memory.get", json!({"slug": slug}))?;
        Ok(v.get("value").and_then(Value::as_str).map(str::to_string))
    }

    /// 정본 `readMemory` — `core` 본문과 `core` 를 뺀 slug 목록. 던지는 것을 삼키지 않는다(빈 저장소와 조회 실패를 가른다).
    pub fn read_memory(&self) -> Result<(Option<String>, Vec<String>), HarkroomError> {
        let listed = self.list_memory()?;
        let slugs: Vec<String> = listed
            .get("slugs")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        let has_core = slugs.iter().any(|s| s == "core");
        let rest: Vec<String> = slugs.into_iter().filter(|s| s != "core").collect();
        let core = if has_core {
            self.get_memory_value("core")?
        } else {
            None
        };
        Ok((core, rest))
    }

    /// 정본 `searchMemory`(recall, 본문 포함). 결과 `{hits, terms?, focusTerms?}`.
    pub fn search_memory(
        &self,
        query: &str,
        limit: u32,
        exclude: &[String],
        record_top: Option<u32>,
        focus: Option<&str>,
    ) -> Result<Value, HarkroomError> {
        let mut args =
            json!({"query": query, "limit": limit, "includeValue": true, "recall": true});
        if !exclude.is_empty() {
            let start = exclude.len().saturating_sub(200);
            args["exclude"] = json!(&exclude[start..]);
        }
        if let Some(n) = record_top.filter(|n| *n > 0) {
            args["recordTop"] = json!(n);
        }
        if let Some(f) = focus {
            args["focus"] = json!(f.chars().take(2000).collect::<String>());
        }
        let v = self.call("memory.search", args)?;
        let mut out =
            json!({"hits": v.get("hits").filter(|h| h.is_array()).cloned().unwrap_or(json!([]))});
        for k in ["terms", "focusTerms"] {
            if let Some(a) = v.get(k).filter(|a| a.is_array()) {
                out[k] = a.clone();
            }
        }
        Ok(out)
    }

    /// `memory.recalled` — 앞 5개만. 빈 목록이면 부르지 않는다.
    pub fn record_recall(&self, keys: &[String]) -> Result<(), HarkroomError> {
        if keys.is_empty() {
            return Ok(());
        }
        let n = keys.len().min(5);
        self.call("memory.recalled", json!({"slugs": &keys[..n]}))
            .map(|_| ())
    }

    /// `thread.note`. 모양이 틀리면 `None`.
    pub fn read_thread_note(
        &self,
        thread_root_id: &str,
    ) -> Result<Option<ThreadNote>, HarkroomError> {
        let v = self.call("thread.note", json!({"threadRootId": thread_root_id}))?;
        let Some(n) = v.get("note").filter(|n| n.is_object()) else {
            return Ok(None);
        };
        let (Some(body), Some(at)) = (
            n.get("body").and_then(Value::as_str),
            n.get("updatedAt").and_then(Value::as_str),
        ) else {
            return Ok(None);
        };
        let flagged = n.get("flagged").filter(|f| f.is_object()).map(|f| {
            f.get("reason")
                .and_then(Value::as_str)
                .unwrap_or("flagged")
                .to_string()
        });
        Ok(Some(ThreadNote {
            body: body.into(),
            updated_at: at.into(),
            flagged,
        }))
    }

    /// `thread.plan` 그대로. 계획이 없으면 `None`, 모양이 틀리면 오류(부르는 쪽이 이번 턴은 싣지 않는다).
    pub fn read_thread_plan(&self, thread_root_id: &str) -> Result<Option<Value>, HarkroomError> {
        let v = self.call("thread.plan", json!({"threadRootId": thread_root_id}))?;
        let Some(p) = v.get("plan").filter(|p| !p.is_null()) else {
            return Ok(None);
        };
        let ok = p.pointer("/doc/groups").is_some_and(Value::is_array)
            && p.pointer("/doc/steps").is_some_and(Value::is_array)
            && p.get("updatedAt").is_some_and(Value::is_string)
            && p.get("rev").is_some_and(Value::is_number)
            && p.get("derived").is_some_and(|d| !d.is_null())
            && p.get("progress").is_some_and(|d| !d.is_null());
        if !ok {
            return Err(err("thread.plan: unexpected shape".into(), None));
        }
        Ok(Some(p.clone()))
    }

    /// `bg.claim`. 일감이 없거나 모양이 틀리면 `None`.
    pub fn claim_bg(&self) -> Result<Option<BgJob>, HarkroomError> {
        let v = self.call("bg.claim", json!({}))?;
        let Some(j) = v.get("job").filter(|j| j.is_object()) else {
            return Ok(None);
        };
        let (Some(id), Some(kind)) = (
            j.get("id").and_then(Value::as_str),
            j.get("kind").and_then(Value::as_str),
        ) else {
            return Ok(None);
        };
        Ok(Some(BgJob {
            id: id.into(),
            kind: kind.into(),
            day: j.get("day").and_then(Value::as_str).unwrap_or("").into(),
            input: j
                .get("input")
                .filter(|i| i.is_object())
                .cloned()
                .unwrap_or(json!({})),
        }))
    }

    /// `bg.complete` — `result` 는 `{status, summary?, error?, tokens?, durationMs?}`.
    pub fn complete_bg(&self, job_id: &str, result: Value) -> Result<(), HarkroomError> {
        let mut args = json!({"jobId": job_id});
        if let Value::Object(m) = result {
            for (k, v) in m {
                args[k] = v;
            }
        }
        self.call("bg.complete", args).map(|_| ())
    }

    /// 정본 `pollInbox` — 결과는 `{entries, messages, memoryRev?, stopRequestedAt?}` 그대로.
    pub fn poll_inbox(
        &self,
        timeout_ms: u64,
        lane: Option<&ClaudeLane>,
        lease: Option<&PollLease>,
    ) -> Result<Value, HarkroomError> {
        let mut args = json!({
            "timeoutMs": timeout_ms,
            "version": self.version,
            "inboxReasons": RUNNER_OPT_IN_INBOX_REASONS,
        });
        if let Some(l) = lane {
            args["claudeLane"] = json!({"pool": l.pool, "accounts": l.accounts});
        }
        if let Some(l) = lease {
            args["lease"] = json!({"runnerId": l.runner_id, "holding": l.holding});
        }
        let v = self.call("inbox.poll", args)?;
        if !v.get("entries").is_some_and(Value::is_array)
            || !v.get("messages").is_some_and(Value::is_array)
        {
            return Err(err("inbox.poll: entries·messages 가 없다".into(), None));
        }
        Ok(v)
    }

    /// `message.read`(스레드).
    pub fn read_thread(
        &self,
        channel_id: &str,
        thread_root_id: Option<&str>,
        since: Option<i64>,
        limit: u32,
    ) -> Result<Vec<Value>, HarkroomError> {
        let mut args = json!({"channelId": channel_id, "limit": limit});
        if let Some(t) = thread_root_id {
            args["threadRootId"] = json!(t);
        }
        if let Some(s) = since {
            args["since"] = json!(s);
        }
        Self::messages_of("message.read", self.call("message.read", args)?)
    }

    /// 채널 전체(스레드 답 포함)에서 seq 커서 이후.
    pub fn read_channel_since(
        &self,
        channel_id: &str,
        since_seq: i64,
        limit: u32,
    ) -> Result<Vec<Value>, HarkroomError> {
        let v = self.call(
            "message.read",
            json!({"channelId": channel_id, "since": since_seq, "limit": limit}),
        )?;
        Self::messages_of("message.read", v)
    }

    fn post_like(
        &self,
        tool: &str,
        channel_id: &str,
        body: &str,
        thread_root_id: Option<&str>,
    ) -> Result<i64, HarkroomError> {
        let mut args = json!({"channelId": channel_id, "body": body});
        if let Some(t) = thread_root_id {
            args["threadRootId"] = json!(t);
        }
        Self::seq_of(tool, &self.call(tool, args)?)
    }

    pub fn post(
        &self,
        channel_id: &str,
        body: &str,
        thread_root_id: Option<&str>,
    ) -> Result<i64, HarkroomError> {
        self.post_like("message.post", channel_id, body, thread_root_id)
    }

    /// 진행 설명(`message.progress`) — 결과 발화로 세지 않는다.
    pub fn progress(
        &self,
        channel_id: &str,
        body: &str,
        thread_root_id: Option<&str>,
    ) -> Result<i64, HarkroomError> {
        self.post_like("message.progress", channel_id, body, thread_root_id)
    }

    /// 러너 알림 줄(`message.notice`). `notice` 는 `{key, …}` 객체. 옛 서버(`Tool message.notice not found`)면
    /// `fallback_body` 를 일반 글로 올린다. 그 밖의 실패는 그대로 던진다.
    pub fn notice(
        &self,
        channel_id: &str,
        thread_root_id: Option<&str>,
        notice: &Value,
        fallback_body: &str,
    ) -> Result<i64, HarkroomError> {
        let mut args = json!({"channelId": channel_id});
        if let Some(t) = thread_root_id {
            args["threadRootId"] = json!(t);
        }
        if let Value::Object(m) = notice {
            for (k, v) in m {
                args[k.as_str()] = v.clone();
            }
        }
        match self.call("message.notice", args) {
            Ok(v) => Self::seq_of("message.notice", &v),
            Err(e) if is_unknown_tool(&e, "message.notice") => {
                self.post(channel_id, fallback_body, thread_root_id)
            }
            Err(e) => Err(e),
        }
    }

    /// 스스로 못 끝냈음(`message.fail`). `post` 로 대신할 수 없다 — 스레드 상태가 `막힘` 으로 칠해지는 것은 이 글뿐이다.
    pub fn fail(
        &self,
        channel_id: &str,
        body: &str,
        thread_root_id: Option<&str>,
        opts: &FailOpts,
    ) -> Result<i64, HarkroomError> {
        let mut m = Map::new();
        m.insert("channelId".into(), json!(channel_id));
        m.insert("body".into(), json!(body));
        m.insert("retryable".into(), json!(opts.retryable));
        put(&mut m, "threadRootId", &thread_root_id.map(str::to_string));
        put(&mut m, "what", &opts.what);
        put(&mut m, "reason", &opts.reason);
        put(&mut m, "code", &opts.code);
        put(&mut m, "laneCode", &opts.lane_code);
        put(&mut m, "mentionId", &opts.mention_id);
        put(&mut m, "account", &opts.account);
        Self::seq_of(
            "message.fail",
            &self.call("message.fail", Value::Object(m))?,
        )
    }

    /// inbox entry id 로 읽음 처리(`inbox.read`). 빈 목록이면 부르지 않는다.
    pub fn mark_read(&self, ids: &[i64]) -> Result<i64, HarkroomError> {
        if ids.is_empty() {
            return Ok(0);
        }
        let v = self.call("inbox.read", json!({"ids": ids}))?;
        v.get("read")
            .and_then(Value::as_i64)
            .ok_or_else(|| err("inbox.read: read 가 없다".into(), None))
    }

    pub fn add_reaction(
        &self,
        channel_id: &str,
        message_id: &str,
        emoji: &str,
    ) -> Result<(), HarkroomError> {
        self.call(
            "message.react",
            json!({"channelId": channel_id, "messageId": message_id, "emoji": emoji}),
        )
        .map(|_| ())
    }

    pub fn remove_reaction(
        &self,
        channel_id: &str,
        message_id: &str,
        emoji: &str,
    ) -> Result<(), HarkroomError> {
        self.call(
            "message.unreact",
            json!({"channelId": channel_id, "messageId": message_id, "emoji": emoji}),
        )
        .map(|_| ())
    }
}

#[cfg(test)]
mod tests;
