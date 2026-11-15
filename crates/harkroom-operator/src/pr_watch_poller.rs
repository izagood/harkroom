//! PR 감시 폴러(위임 재설계 P5, 서버 `services/prWatch.ts`) — TS `prWatchPoller.ts` 의 `createPrWatchPoller` 이식.
//!
//! 60초마다 이 오퍼레이터가 띄우는 에이전트마다 서버에 열린 감시를 묻고(`GET /agent/pr-watches/due`),
//! `pr.status` 와 같은 gh 길(같은 계정 고르기 `GhTokens::token_for`·같은 관문 `PrGate::inspect` 의 고정 칸)로 읽어
//! `POST /agent/pr-watches/:id/status` 로 보낸다. 바뀐 것 가르기·끝내기·깨우기는 전부 서버다.
//!
//! 서버 스위치가 꺼지면 due 가 빈 목록이라 gh 를 부르지 않는다. 감시 하나의 실패는 로그만 남기고 넘긴다 — 오퍼레이터를 죽이지 않는다.
//! 저장소는 서버가 돌려준 감시 행의 것이다(서버가 머지 grant 를 보고 만든 행, 보고 때 다시 본다).
use crate::forward::{AGENT_HEADER, Transport};
use crate::local_merge::gh_env;
use crate::merge::is_repo;
use crate::op_token::SharedToken;
use crate::pr_gate::PrInspection;
use crate::turn_pr_status::{TurnPrStatus, pick_pr_status};
use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

/// 폴링 주기(TS `PR_WATCH_POLL_MS`).
pub const PR_WATCH_POLL_MS: u64 = 60_000;
/// 열린 감시 묻기 자리.
pub const PR_WATCHES_DUE_PATH: &str = "/agent/pr-watches/due";

/// 에이전트 자격의 서버 요청 — (agent id, method, path, JSON 본문) → (status, 본문). Err·status 0 은 닿지 못함.
/// TS 의 `deps.forward(agentId, {type: 'http.forward', …})` 자리다.
pub type AgentHttp =
    Arc<dyn Fn(&str, &str, &str, Option<String>) -> Result<(u16, String), String> + Send + Sync>;

/// TS `PrWatchPollerDeps` 의 Rust 판. `pr` 는 `pr.status` 손잡이와 **같은** `PrGate`·`GhTokens` 다(「처음 본 시각」 공유).
#[derive(Clone)]
pub struct PrWatchPoller {
    pub pr: TurnPrStatus,
    pub http: AgentHttp,
    pub agent_ids: Arc<dyn Fn() -> Vec<String> + Send + Sync>,
    pub log: Arc<dyn Fn(&str) + Send + Sync>,
}

/// `start` 가 돌려주는 손잡이 — `stop` 하면 다음 깨어날 때 고리를 나간다(TS `stop`).
pub struct PrWatchHandle {
    stop: Arc<AtomicBool>,
}

impl PrWatchHandle {
    pub fn stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

/// TS `encodeURIComponent` — 영숫자와 `-_.!~*'()` 만 그대로.
fn encode_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// 실제 서버로 가는 `AgentHttp` — `bridge.rs` `server_post` 와 같은 머리(오퍼레이터 토큰 + 에이전트 머리)로 이 커뮤니티 서버에 보낸다.
/// 러너 REST 허용 목록을 거치지 않는 오퍼레이터 자체 요청이다.
pub fn agent_http(
    transport: Arc<dyn Transport>,
    base_url: String,
    token: SharedToken,
) -> AgentHttp {
    Arc::new(move |agent_id, method, path, body| {
        let url = format!("{}{}", base_url.trim_end_matches('/'), path);
        let mut headers = vec![
            (
                "authorization".to_string(),
                format!("Bearer {}", token.get()),
            ),
            (AGENT_HEADER.to_string(), agent_id.to_string()),
        ];
        if body.is_some() {
            headers.push(("content-type".to_string(), "application/json".to_string()));
        }
        let r = transport.send(method, &url, &headers, body.map(String::into_bytes))?;
        Ok((r.status, r.body))
    })
}

fn panic_text(e: &(dyn std::any::Any + Send)) -> String {
    e.downcast_ref::<&str>()
        .map(|s| s.to_string())
        .or_else(|| e.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "panic".into())
}

impl PrWatchPoller {
    /// TS `http` — 닿지 못했거나 status 0 이면 None. 본문이 JSON 이 아니면 Null.
    fn http(
        &self,
        agent_id: &str,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> Option<(u16, Value)> {
        let (status, text) =
            (self.http)(agent_id, method, path, body.map(|b| b.to_string())).ok()?;
        if status == 0 {
            return None;
        }
        Some((status, serde_json::from_str(&text).unwrap_or(Value::Null)))
    }

    /// TS `pollOne` — 감시 하나. 모양이 틀리면 조용히 넘기고, gh·보고 실패는 로그만.
    fn poll_one(&self, agent_id: &str, w: &Value) {
        let (Some(id), Some(repo), Some(n)) = (
            w.get("id").and_then(Value::as_str),
            w.get("repo").and_then(Value::as_str),
            w.get("number").and_then(Value::as_f64),
        ) else {
            return;
        };
        // TS `Number.isInteger` — 5.0 도 정수다. gh 에 넘길 수 있는 양의 정수만.
        if !is_repo(repo) || n.fract() != 0.0 || !(1.0..=999_999_999.0).contains(&n) {
            return;
        }
        let number = n as u64;
        let tok = match self.pr.tokens.token_for(repo) {
            Ok(t) => t,
            Err(f) => {
                (self.log)(&format!(
                    "pr.watch: {repo}#{number} gh 계정 없음({})",
                    f.code
                ));
                return;
            }
        };
        let env = gh_env(&self.pr.home, Some(&tok.token));
        let pr = match self.pr.gate.inspect(repo, number, &env, None, false) {
            PrInspection::Ok { pr, .. } => pr,
            PrInspection::ViewFailed(_) => {
                (self.log)(&format!("pr.watch: {repo}#{number} gh pr view 실패"));
                return;
            }
        };
        let Some(picked) = pick_pr_status(&pr) else {
            return;
        };
        let body = json!({"state": picked["state"], "headRefOid": picked["headRefOid"], "checks": picked["checks"]});
        let path = format!("/agent/pr-watches/{}/status", encode_component(id));
        match self.http(agent_id, "POST", &path, Some(body)) {
            Some((s, _)) if s < 400 => {}
            r => {
                let s = r.map_or("unreachable".to_string(), |(s, _)| s.to_string());
                (self.log)(&format!("pr.watch: {repo}#{number} 보고 실패({s})"));
            }
        }
    }

    /// TS `tick` — 에이전트마다 due 를 묻고 감시마다 읽어 보고한다. 어떤 실패도 밖으로 내지 않는다.
    /// (TS 의 `running` 겹침 막기는 `start` 의 한 스레드가 차례로 부르므로 따로 두지 않는다.)
    pub fn tick(&self) {
        for agent_id in (self.agent_ids)() {
            let watches = match self.http(&agent_id, "GET", PR_WATCHES_DUE_PATH, None) {
                Some((200, v)) => match v.get("watches") {
                    Some(Value::Array(a)) => a.clone(),
                    _ => continue,
                },
                _ => continue,
            };
            for w in &watches {
                let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    self.poll_one(&agent_id, w)
                }));
                if let Err(e) = r {
                    let id = w.get("id").map_or("undefined".to_string(), |v| match v {
                        Value::String(s) => s.clone(),
                        v => v.to_string(),
                    });
                    (self.log)(&format!(
                        "pr.watch: 감시 {id} 실패 — {}",
                        panic_text(e.as_ref())
                    ));
                }
            }
        }
    }

    /// TS `start` — 주기마다 `tick`. 첫 tick 은 한 주기 뒤다(setInterval). 스레드 하나가 차례로 돌아 겹치지 않는다.
    pub fn start(self) -> PrWatchHandle {
        self.start_every(Duration::from_millis(PR_WATCH_POLL_MS))
    }

    fn start_every(self, every: Duration) -> PrWatchHandle {
        let stop = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&stop);
        let spawned = std::thread::Builder::new()
            .name("pr-watch-poller".into())
            .spawn(move || {
                loop {
                    std::thread::sleep(every);
                    if flag.load(Ordering::SeqCst) {
                        return;
                    }
                    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.tick()));
                }
            });
        if let Err(e) = spawned {
            eprintln!("pr.watch: 폴러 스레드를 못 띄웠다 — {e}");
        }
        PrWatchHandle { stop }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_merge::ExecResult;
    use crate::pr_gate::{GhTokens, PrGate};
    use std::collections::HashMap;
    use std::sync::Mutex;

    // PR 감시 폴러(P5) — due 가 비면 gh 를 부르지 않고, 읽은 고정 칸을 보고하고, 한 감시의 실패로 멈추지 않는다.
    // TS `test/prWatchPoller.test.ts` 이식.
    const SHA: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const REPO: &str = "example-org/example-repo";

    type Seen = Arc<Mutex<Vec<String>>>;
    /// (agent, method, path, body)
    type Forwards = Arc<Mutex<Vec<(String, String, String, Option<String>)>>>;

    struct T {
        poller: PrWatchPoller,
        forwards: Forwards,
        execs: Seen,
        logs: Seen,
    }

    fn res(code: i32, out: &str, err: &str) -> ExecResult {
        ExecResult {
            code,
            stdout: out.into(),
            stderr: err.into(),
        }
    }

    fn setup(due: Value, view_fails: bool) -> T {
        let execs: Seen = Arc::default();
        let logs: Seen = Arc::default();
        let forwards: Forwards = Arc::default();
        let script = move |args: &[String]| -> ExecResult {
            match (args.first().map(String::as_str), args.get(1).map(String::as_str)) {
                (Some("auth"), _) => res(0, "tok\n", ""),
                (Some("pr"), Some("view")) if view_fails => res(1, "", "boom"),
                (Some("pr"), Some("view")) => res(
                    0,
                    &json!({"state": "OPEN", "isDraft": false, "headRefOid": SHA, "baseRefName": "main",
                        "mergeStateStatus": "CLEAN",
                        "statusCheckRollup": [{"__typename": "CheckRun", "name": "test", "status": "COMPLETED", "conclusion": "SUCCESS"}]})
                    .to_string(),
                    "",
                ),
                _ => res(1, "", "unexpected"),
            }
        };
        let script = Arc::new(script);
        let (e1, e2, s1, s2) = (execs.clone(), execs.clone(), script.clone(), script);
        let gate = PrGate {
            gh: Arc::new(move |args: &[String], _e: &[(String, String)]| {
                e1.lock().unwrap().push(args.join(" "));
                s1(args)
            }),
            now: Arc::new(|| 1_000),
            first_seen: Arc::new(Mutex::new(HashMap::new())),
        };
        let tokens = GhTokens {
            exec: Arc::new(move |_f: &str, args: &[String], _e: &[(String, String)]| {
                e2.lock().unwrap().push(args.join(" "));
                s2(args)
            }),
            gh_path: "/usr/bin/gh".into(),
            home: "/home/x".into(),
            gh_user_for: Arc::new(|r: &str| {
                r.starts_with("example-org/")
                    .then(|| ("alice".to_string(), "example-org/*".to_string()))
            }),
        };
        let f = forwards.clone();
        let http: AgentHttp = Arc::new(move |agent, method, path, body| {
            f.lock()
                .unwrap()
                .push((agent.into(), method.into(), path.into(), body));
            if method == "GET" {
                Ok((200, json!({"watches": due}).to_string()))
            } else {
                Ok((200, json!({"changed": true, "state": "done"}).to_string()))
            }
        });
        let l = logs.clone();
        T {
            poller: PrWatchPoller {
                pr: TurnPrStatus {
                    gate,
                    tokens,
                    home: "/home/x".into(),
                },
                http,
                agent_ids: Arc::new(|| vec!["a1".to_string()]),
                log: Arc::new(move |line: &str| l.lock().unwrap().push(line.into())),
            },
            forwards,
            execs,
            logs,
        }
    }

    fn one_watch() -> Value {
        json!([{"id": "w1", "repo": REPO, "number": 7, "head": SHA, "until": "checks"}])
    }

    #[test]
    fn empty_due_calls_no_gh() {
        let t = setup(json!([]), false);
        t.poller.tick();
        assert!(t.execs.lock().unwrap().is_empty());
        let paths: Vec<String> = t
            .forwards
            .lock()
            .unwrap()
            .iter()
            .map(|f| f.2.clone())
            .collect();
        assert_eq!(paths, vec![PR_WATCHES_DUE_PATH.to_string()]);
    }

    #[test]
    fn reads_each_watch_and_posts_fixed_fields() {
        let t = setup(one_watch(), false);
        t.poller.tick();
        let fw = t.forwards.lock().unwrap();
        let post = fw.iter().find(|f| f.1 == "POST").expect("POST 없음");
        assert_eq!(post.0, "a1");
        assert_eq!(post.2, "/agent/pr-watches/w1/status");
        let body: Value = serde_json::from_str(post.3.as_deref().unwrap()).unwrap();
        assert_eq!(
            body,
            json!({"state": "OPEN", "headRefOid": SHA, "checks": [{"name": "test", "conclusion": "SUCCESS"}]})
        );
        // pr.status 와 같은 gh 길 — 서버가 준 저장소로 `gh pr view`.
        assert!(
            t.execs
                .lock()
                .unwrap()
                .iter()
                .any(|c| c.contains(&format!("pr view 7 -R {REPO}")))
        );
    }

    #[test]
    fn gh_failure_only_logs_and_moves_on() {
        let t = setup(one_watch(), true);
        t.poller.tick();
        assert!(!t.forwards.lock().unwrap().iter().any(|f| f.1 == "POST"));
        assert!(t.logs.lock().unwrap().iter().any(|l| l.contains("실패")));
    }

    #[test]
    fn bad_rows_are_skipped_and_ids_are_encoded() {
        let t = setup(
            json!([
                {"id": "x", "repo": "../etc", "number": 7},
                {"id": "y", "repo": REPO, "number": 1.5},
                {"id": "a/b c", "repo": REPO, "number": 7},
            ]),
            false,
        );
        t.poller.tick();
        let fw = t.forwards.lock().unwrap();
        let posts: Vec<&str> = fw
            .iter()
            .filter(|f| f.1 == "POST")
            .map(|f| f.2.as_str())
            .collect();
        assert_eq!(posts, vec!["/agent/pr-watches/a%2Fb%20c/status"]);
    }

    #[test]
    fn report_failure_and_unreachable_server_only_log() {
        let mut t = setup(one_watch(), false);
        t.poller.http = Arc::new(|_a, method, _p, _b| {
            if method == "GET" {
                Ok((200, json!({"watches": one_watch()}).to_string()))
            } else {
                Err("down".into())
            }
        });
        t.poller.tick();
        assert!(
            t.logs
                .lock()
                .unwrap()
                .iter()
                .any(|l| l.contains("보고 실패(unreachable)"))
        );
        // due 가 닿지 않으면 gh 를 부르지 않는다.
        let t = setup(one_watch(), false);
        let mut p = t.poller.clone();
        p.http = Arc::new(|_a, _m, _p, _b| Ok((0, String::new())));
        p.tick();
        assert!(t.execs.lock().unwrap().is_empty());
    }

    #[test]
    fn start_ticks_on_interval_and_stops() {
        let t = setup(json!([]), false);
        let h = t.poller.clone().start_every(Duration::from_millis(5));
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while t.forwards.lock().unwrap().is_empty() && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        h.stop();
        assert!(!t.forwards.lock().unwrap().is_empty());
    }

    #[test]
    fn encode_matches_encode_uri_component() {
        assert_eq!(encode_component("w-1_.!~*'()"), "w-1_.!~*'()");
        assert_eq!(encode_component("a/b?c#é"), "a%2Fb%3Fc%23%C3%A9");
    }
}
