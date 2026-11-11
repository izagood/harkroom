//! 턴 도중 새 글 — TS `packages/operator/src/turnPeek.ts` 이식(s21b-3b).
//!
//! claude PostToolUse hook 이 hook 소켓으로 `thread.peek` 을 묻는다. 그 턴의 임대(cause = 턴을 띄운 글)로 앵커 스레드를
//! 정하고, 커서 뒤 **사람** 글만 돌려준다. 권한 판정이 아니라 알림이다 — 실패·임대 없음·서버 무응답은 전부 「실을 글 없음」.
//!
//! - 앵커는 인자로 받지 않는다(서버의 cause 글에서 정한다). 인자는 `sinceSeq` 뿐이다.
//! - 커서는 실은 글이 아니라 **본 글**까지 민다. 턴 커서는 500개까지(오래된 것부터 버림), 계정 표는 5분 캐시.
//! - `caller` 는 cause 글 작성자의 글인가(security F1) — 그 사람만 방향을 바꿀 수 있다. cause 가 에이전트 자신의 글이면 없음.
//! - 이 모듈은 I/O 를 하지 않는다 — GET 은 부르는 쪽이 `get` 으로 준다. 잠금은 I/O 사이에 쥐지 않는다.

use crate::turn_leases::TurnLease;
use harkroom_proto::p1::{RunnerLinkKind, RunnerLinkRequest, RunnerLinkResponse};
use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;

pub const THREAD_PEEK_TOOL: &str = "thread.peek";
pub const PEEK_MAX_POSTS: usize = 10;
pub const PEEK_POST_CHARS: usize = 2_000;
pub const PEEK_TOTAL_CHARS: usize = 8_000;
const CURSOR_MAX: usize = 500;
const ACCOUNTS_TTL_MS: u64 = 5 * 60_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeekPost {
    pub seq: i64,
    pub handle: String,
    pub body: String,
    pub caller: bool,
}

#[derive(Clone)]
struct Cursor {
    channel_id: String,
    anchor: String,
    seq: i64,
    caller_id: Option<String>,
}

#[derive(Clone)]
struct Who {
    human: bool,
    handle: String,
}

#[derive(Default)]
struct State {
    cursors: HashMap<String, Cursor>,
    order: VecDeque<String>,
    accounts: HashMap<String, (u64, HashMap<String, Who>)>,
}

pub struct TurnPeek {
    state: Mutex<State>,
    now: Box<dyn Fn() -> u64 + Send + Sync>,
}

/// 에이전트 자격으로 서버에 GET — 200 이 아니면 Err.
pub type Get<'a> = &'a dyn Fn(&str, &str) -> Result<Value, String>;

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// `encodeURIComponent` 과 같은 집합.
fn enc(s: &str) -> String {
    crate::turn_leases::encode_component(s)
}

/// 앞 `n` 글자(UTF-16 이 아니라 char 단위 — TS 와 다를 수 있는 곳은 서로게이트 쌍뿐이다).
fn clip(s: &str, n: usize) -> String {
    match s.char_indices().nth(n) {
        Some((i, _)) => format!("{}…", &s[..i]),
        None => s.to_string(),
    }
}

impl TurnPeek {
    pub fn new(now: impl Fn() -> u64 + Send + Sync + 'static) -> Self {
        TurnPeek {
            state: Mutex::new(State::default()),
            now: Box::new(now),
        }
    }

    pub fn system() -> Self {
        Self::new(|| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0)
        })
    }

    fn accounts_of(&self, agent_id: &str, get: Get) -> Result<HashMap<String, Who>, String> {
        let now = (self.now)();
        if let Some((at, by)) = lock(&self.state).accounts.get(agent_id)
            && now.saturating_sub(*at) < ACCOUNTS_TTL_MS
        {
            return Ok(by.clone());
        }
        let body = get(agent_id, "/accounts")?;
        let mut by = HashMap::new();
        for a in body
            .get("accounts")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let Some(id) = a.get("id").and_then(Value::as_str) {
                let handle = a.get("handle").and_then(Value::as_str).unwrap_or("unknown");
                by.insert(
                    id.to_string(),
                    Who {
                        human: a.get("kind").and_then(Value::as_str) == Some("human"),
                        handle: handle.to_string(),
                    },
                );
            }
        }
        lock(&self.state)
            .accounts
            .insert(agent_id.to_string(), (now, by.clone()));
        Ok(by)
    }

    /// 그 턴의 앵커 스레드에서 커서 뒤 사람 글. 임대가 없거나 다른 에이전트의 것이면 빈 목록.
    pub fn peek(
        &self,
        runner_id: &str,
        agent_id: &str,
        cause: Option<&str>,
        lease: Option<&TurnLease>,
        since_seq: i64,
        get: Get,
    ) -> Result<Vec<PeekPost>, String> {
        let Some(cause) = cause.filter(|c| !c.is_empty()) else {
            return Ok(vec![]);
        };
        match lease {
            Some(l) if l.agent_id == agent_id => {}
            _ => return Ok(vec![]),
        }
        let key = format!("{runner_id}:{cause}");
        let known = lock(&self.state).cursors.get(&key).cloned();
        let cur = match known {
            Some(c) => c,
            None => {
                let m = get(agent_id, &format!("/messages/{}", enc(cause)))?;
                let (Some(ch), Some(id)) = (
                    m.get("channelId").and_then(Value::as_str),
                    m.get("id").and_then(Value::as_str),
                ) else {
                    return Ok(vec![]);
                };
                let anchor = m.get("threadRootId").and_then(Value::as_str).unwrap_or(id);
                let caller_id = m
                    .get("authorId")
                    .and_then(Value::as_str)
                    .filter(|a| *a != agent_id)
                    .map(str::to_string);
                let c = Cursor {
                    channel_id: ch.to_string(),
                    anchor: anchor.to_string(),
                    seq: since_seq.max(0),
                    caller_id,
                };
                let mut st = lock(&self.state);
                if !st.cursors.contains_key(&key) {
                    if st.cursors.len() >= CURSOR_MAX
                        && let Some(old) = st.order.pop_front()
                    {
                        st.cursors.remove(&old);
                    }
                    st.order.push_back(key.clone());
                }
                st.cursors.insert(key.clone(), c.clone());
                c
            }
        };
        let page = get(
            agent_id,
            &format!(
                "/channels/{}/messages?thread={}&since={}&limit=50",
                enc(&cur.channel_id),
                enc(&cur.anchor),
                cur.seq
            ),
        )?;
        let list = if page.is_array() {
            page.as_array()
        } else {
            page.get("messages").and_then(Value::as_array)
        };
        let mut rows: Vec<(i64, &Value)> = list
            .into_iter()
            .flatten()
            .filter_map(|r| r.get("seq").and_then(Value::as_i64).map(|s| (s, r)))
            .filter(|(s, _)| *s > cur.seq)
            .collect();
        rows.sort_by_key(|(s, _)| *s);
        let Some(&(last, _)) = rows.last() else {
            return Ok(vec![]);
        };
        if let Some(c) = lock(&self.state).cursors.get_mut(&key) {
            c.seq = c.seq.max(last);
        }
        let by = self.accounts_of(agent_id, get)?;
        let mut out = Vec::new();
        let mut total = 0usize;
        for (seq, r) in rows {
            let deleted = r
                .get("deletedAt")
                .is_some_and(|d| !d.is_null() && d != false && d != "");
            let author = r.get("authorId").and_then(Value::as_str);
            if r.get("kind").and_then(Value::as_str) != Some("user") || deleted {
                continue;
            }
            let Some(author) = author.filter(|a| *a != agent_id) else {
                continue;
            };
            let Some(who) = by.get(author).filter(|w| w.human) else {
                continue;
            };
            let body = clip(
                r.get("body").and_then(Value::as_str).unwrap_or(""),
                PEEK_POST_CHARS,
            );
            let len = body.chars().count();
            if out.len() >= PEEK_MAX_POSTS || total + len > PEEK_TOTAL_CHARS {
                break;
            }
            total += len;
            out.push(PeekPost {
                seq,
                handle: who.handle.clone(),
                body,
                caller: cur.caller_id.as_deref() == Some(author),
            });
        }
        Ok(out)
    }

    /// 처리했으면 응답, 아니면 None. `thread.peek` 만 받는다 — hook 소켓이 아니면 `hook_only`.
    #[allow(clippy::too_many_arguments)]
    pub fn maybe_handle(
        &self,
        runner_id: &str,
        agent_id: &str,
        req: &RunnerLinkRequest,
        kind: RunnerLinkKind,
        lease: Option<&TurnLease>,
        get: Get,
        log: &dyn Fn(&str),
    ) -> Option<RunnerLinkResponse> {
        let RunnerLinkRequest::McpRequest {
            id, payload, cause, ..
        } = req
        else {
            return None;
        };
        let call = tool_call(payload)?;
        if call
            .get("params")
            .and_then(|p| p.get("name"))
            .and_then(Value::as_str)
            != Some(THREAD_PEEK_TOOL)
        {
            return None;
        }
        let rpc_id = call.get("id").cloned().unwrap_or(Value::Null);
        let reply = |v: Value| RunnerLinkResponse::McpResponse {
            id: id.clone(),
            messages: vec![tool_result(rpc_id.clone(), &v)],
        };
        if kind != RunnerLinkKind::Hook {
            return Some(reply(json!({"posts": [], "error": {
                "code": "hook_only", "message": "thread.peek is answered only on the hook link"}})));
        }
        let since = call
            .get("params")
            .and_then(|p| p.get("arguments"))
            .and_then(|a| a.get("sinceSeq"))
            .and_then(Value::as_f64)
            .filter(|f| f.fract() == 0.0 && f.abs() <= 9_007_199_254_740_991.0)
            .map(|f| f as i64)
            .unwrap_or(0);
        match self.peek(runner_id, agent_id, cause.as_deref(), lease, since, get) {
            Ok(posts) => {
                let posts: Vec<Value> = posts
                    .into_iter()
                    .map(|p| json!({"seq": p.seq, "handle": p.handle, "body": p.body, "caller": p.caller}))
                    .collect();
                Some(reply(json!({ "posts": posts })))
            }
            Err(e) => {
                log(&format!("thread.peek: 실패 — {e}"));
                Some(reply(json!({"posts": []})))
            }
        }
    }
}

/// JSON-RPC `tools/call` 이면 그 호출.
pub fn tool_call(payload: &Value) -> Option<&Value> {
    (payload.get("method").and_then(Value::as_str) == Some("tools/call")
        && payload.get("params").is_some_and(Value::is_object))
    .then_some(payload)
}

pub fn tool_result(id: Value, value: &Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "result": {"content": [{"type": "text", "text": value.to_string()}]}})
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn lease(agent: &str) -> TurnLease {
        TurnLease {
            lease_id: "L".into(),
            token: "t".into(),
            agent_id: agent.into(),
        }
    }

    fn accounts() -> Value {
        json!({"accounts": [
            {"id": "h1", "kind": "human", "handle": "jaebin"},
            {"id": "h2", "kind": "human", "handle": "other"},
            {"id": "ag", "kind": "agent", "handle": "bot"}
        ]})
    }

    fn msgs(rows: Value) -> impl Fn(&str, &str) -> Result<Value, String> {
        move |_a: &str, path: &str| {
            if path.starts_with("/messages/") {
                Ok(json!({"id": "c1", "channelId": "ch", "threadRootId": "root", "authorId": "h1"}))
            } else if path == "/accounts" {
                Ok(accounts())
            } else {
                Ok(json!({"messages": rows.clone()}))
            }
        }
    }

    #[test]
    fn no_lease_or_other_agent_is_empty() {
        let p = TurnPeek::new(|| 0);
        let g = msgs(json!([]));
        assert!(
            p.peek("r", "ag", Some("c1"), None, 0, &g)
                .unwrap()
                .is_empty()
        );
        let l = lease("other");
        assert!(
            p.peek("r", "ag", Some("c1"), Some(&l), 0, &g)
                .unwrap()
                .is_empty()
        );
        let l = lease("ag");
        assert!(p.peek("r", "ag", None, Some(&l), 0, &g).unwrap().is_empty());
    }

    #[test]
    fn only_human_user_posts_and_caller_flag_and_cursor() {
        let p = TurnPeek::new(|| 0);
        let rows = json!([
            {"seq": 5, "kind": "user", "authorId": "h2", "body": "멈춰"},
            {"seq": 3, "kind": "user", "authorId": "h1", "body": "a\nb"},
            {"seq": 4, "kind": "user", "authorId": "ag", "body": "me"},
            {"seq": 6, "kind": "system", "authorId": "h1", "body": "sys"},
            {"seq": 7, "kind": "user", "authorId": "h1", "body": "gone", "deletedAt": "2026-01-01"},
            {"seq": 2, "kind": "user", "authorId": "h1", "body": "old"}
        ]);
        let g = msgs(rows);
        let l = lease("ag");
        let out = p.peek("r", "ag", Some("c1"), Some(&l), 2, &g).unwrap();
        assert_eq!(
            out,
            vec![
                PeekPost {
                    seq: 3,
                    handle: "jaebin".into(),
                    body: "a\nb".into(),
                    caller: true
                },
                PeekPost {
                    seq: 5,
                    handle: "other".into(),
                    body: "멈춰".into(),
                    caller: false
                },
            ]
        );
        // 커서가 본 글(7)까지 밀렸다 — 같은 행을 다시 싣지 않는다.
        assert!(
            p.peek("r", "ag", Some("c1"), Some(&l), 0, &g)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn anchor_from_cause_and_self_cause_has_no_caller() {
        let p = TurnPeek::new(|| 0);
        let seen = RefCell::new(Vec::<String>::new());
        let g = |_a: &str, path: &str| -> Result<Value, String> {
            seen.borrow_mut().push(path.to_string());
            if path.starts_with("/messages/") {
                Ok(json!({"id": "c 1", "channelId": "ch", "authorId": "ag"}))
            } else if path == "/accounts" {
                Ok(accounts())
            } else {
                Ok(json!([{"seq": 1, "kind": "user", "authorId": "h1", "body": "x"}]))
            }
        };
        let l = lease("ag");
        let out = p.peek("r", "ag", Some("c 1"), Some(&l), 0, &g).unwrap();
        assert!(!out[0].caller);
        let s = seen.borrow();
        assert_eq!(s[0], "/messages/c%201");
        assert_eq!(s[1], "/channels/ch/messages?thread=c%201&since=0&limit=50");
    }

    #[test]
    fn clips_and_caps() {
        let p = TurnPeek::new(|| 0);
        let long = "가".repeat(PEEK_POST_CHARS + 5);
        let rows: Vec<Value> = (1..=12)
            .map(|i| json!({"seq": i, "kind": "user", "authorId": "h1", "body": if i == 1 { long.clone() } else { "x".into() }}))
            .collect();
        let g = msgs(Value::Array(rows));
        let l = lease("ag");
        let out = p.peek("r", "ag", Some("c1"), Some(&l), 0, &g).unwrap();
        assert_eq!(out.len(), PEEK_MAX_POSTS);
        assert_eq!(out[0].body.chars().count(), PEEK_POST_CHARS + 1);
        assert!(out[0].body.ends_with('…'));
    }

    #[test]
    fn handle_is_hook_only_and_errors_are_empty() {
        let p = TurnPeek::new(|| 0);
        let req = RunnerLinkRequest::McpRequest {
            id: "q".into(),
            payload: json!({"jsonrpc": "2.0", "id": 9, "method": "tools/call", "params": {"name": "thread.peek", "arguments": {}}}),
            cause: Some("c1".into()),
            cwd: None,
            turn_id: None,
            command_files: None,
        };
        let l = lease("ag");
        let bad = |_: &str, _: &str| -> Result<Value, String> { Err("down".into()) };
        let text = |r: RunnerLinkResponse| match r {
            RunnerLinkResponse::McpResponse { messages, .. } => messages[0]["result"]["content"][0]
                ["text"]
                .as_str()
                .unwrap()
                .to_string(),
            other => panic!("{other:?}"),
        };
        let r = p
            .maybe_handle(
                "r",
                "ag",
                &req,
                RunnerLinkKind::Bridge,
                Some(&l),
                &bad,
                &|_| {},
            )
            .unwrap();
        assert!(text(r).contains("hook_only"));
        let r = p
            .maybe_handle(
                "r",
                "ag",
                &req,
                RunnerLinkKind::Hook,
                Some(&l),
                &bad,
                &|_| {},
            )
            .unwrap();
        assert_eq!(text(r), r#"{"posts":[]}"#);
        let other = RunnerLinkRequest::McpRequest {
            id: "q".into(),
            payload: json!({"method": "tools/call", "params": {"name": "message.read"}}),
            cause: None,
            cwd: None,
            turn_id: None,
            command_files: None,
        };
        assert!(
            p.maybe_handle(
                "r",
                "ag",
                &other,
                RunnerLinkKind::Hook,
                Some(&l),
                &bad,
                &|_| {}
            )
            .is_none()
        );
    }
}
