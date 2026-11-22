//! `harkroom-operator-rs agent <list|add|remove> --base-url <url> …` — 화면 없는 기기(리눅스 서버 등)에서 이 오퍼레이터가
//! 돌릴 수 있는 에이전트 목록(`operator.json` 의 `agents`)을 터미널로 다룬다.
//!
//! 배정은 양쪽 동의다 — 서버의 배정과 이 기기의 로컬 목록. 앱이 있는 기기는 앱이 목록을 채우지만, 앱이 없으면 채울 길이
//! 없어 배정이 거절됐다. 이 명령은 `account` 처럼 **도는 오퍼레이터의 앱 소켓**에 앱과 같은 요청
//! (`operatorAgentsList`·`operatorAgentSet`·`operatorAgentRemove`)을 보낸다. 파일을 직접 고치지 않으므로:
//! - 쓰기 검사(uuid 꼴·제어문자·커뮤니티 하나·잠금)는 오퍼레이터의 한 곳에서만 한다.
//! - 바뀐 목록은 오퍼레이터가 곧바로 서버에 다시 알린다(다시 띄울 필요 없음).
//!
//! `add` 는 이미 있는 칸의 값 중 인자로 주지 않은 것(작업 폴더·계정 풀)을 그대로 둔다 — 소켓 요청은 두 값을 통째로
//! 바꾸므로, 먼저 목록을 읽어 합쳐 보낸다. 소켓 붙기 규율(내 소유·0600 토큰·상대 uid)은 `account_cli::Conn` 그대로다.
use crate::account_cli::{Conn, REQUEST_TIMEOUT};
use crate::local_agents::is_uuid_shape;
use crate::register_cli::{check_url, default_app_data, register_root};
use harkroom_roots::community_root_key;
use serde_json::{Map, Value, json};
use std::io::Write;

pub const USAGE: &str = "사용법:\n  harkroom-operator-rs agent list --base-url <url> [--json]\n  harkroom-operator-rs agent add <agent-id> --base-url <url> [--working-dir <절대 경로>] [--claude-pool <풀>]\n  harkroom-operator-rs agent remove <agent-id> --base-url <url>\n  공통: [--home <dir>] [--app-data <dir>]\n  <agent-id> 는 에이전트의 uuid 다(이름이 아니다) — 앱의 에이전트 상세에서 본다.";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    List {
        json: bool,
    },
    Add {
        agent_id: String,
        working_dir: Option<String>,
        claude_pool: Option<String>,
    },
    Remove {
        agent_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentArgs {
    pub action: Action,
    pub base_url: String,
    pub home: Option<String>,
    pub app_data: Option<String>,
}

pub fn parse_agent_args(argv: &[String]) -> Result<AgentArgs, String> {
    let usage = || USAGE.to_string();
    let verb = argv.first().map(String::as_str).ok_or_else(usage)?;
    let (mut base_url, mut home, mut app_data) = (None, None, None);
    let (mut working_dir, mut claude_pool) = (None, None);
    let mut json = false;
    let mut names: Vec<String> = Vec::new();
    let mut it = argv[1..].iter();
    while let Some(arg) = it.next() {
        let slot = match arg.as_str() {
            "--json" if verb == "list" => {
                json = true;
                continue;
            }
            "--working-dir" if verb == "add" => &mut working_dir,
            "--claude-pool" if verb == "add" => &mut claude_pool,
            "--base-url" => &mut base_url,
            "--home" => &mut home,
            "--app-data" => &mut app_data,
            other if other.starts_with("--") => {
                return Err(format!("모르는 인자: {other}\n{USAGE}"));
            }
            _ => {
                names.push(arg.clone());
                continue;
            }
        };
        match it.next() {
            Some(v) if !v.is_empty() && !v.starts_with("--") => *slot = Some(v.clone()),
            _ => return Err(format!("{arg} 에 값이 없다\n{USAGE}")),
        }
    }
    // 서버는 목록의 글자와 에이전트 id 를 그대로 견준다 — 소문자로 맞춘다.
    let one = |names: Vec<String>| -> Result<String, String> {
        match <[String; 1]>::try_from(names) {
            Ok([id]) if is_uuid_shape(&id) => Ok(id.to_ascii_lowercase()),
            Ok(_) => Err(format!(
                "<agent-id> 는 uuid 꼴(8-4-4-4-12)이어야 한다 — 이름이 아니라 id 다\n{USAGE}"
            )),
            Err(_) => Err(usage()),
        }
    };
    let action = match verb {
        "list" if names.is_empty() => Action::List { json },
        "add" => {
            if let Some(w) = &working_dir
                && !w.starts_with('/')
            {
                return Err(format!("--working-dir 는 절대 경로여야 한다: {w}"));
            }
            Action::Add {
                agent_id: one(names)?,
                working_dir,
                claude_pool,
            }
        }
        "remove" => Action::Remove {
            agent_id: one(names)?,
        },
        _ => return Err(usage()),
    };
    let base_url = base_url.ok_or_else(|| format!("--base-url 이 없다\n{USAGE}"))?;
    check_url(&base_url)?;
    Ok(AgentArgs {
        action,
        base_url: community_root_key(&base_url).to_string(),
        home,
        app_data,
    })
}

/// `operatorAgentsList` 답에서 이 커뮤니티의 `agents` 칸. 없으면 빈 칸.
pub fn agents_of(snapshot: &Value, base_url: &str) -> Map<String, Value> {
    snapshot
        .get("communities")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|c| {
            c.get("baseUrl")
                .and_then(Value::as_str)
                .is_some_and(|b| community_root_key(b) == base_url)
        })
        .find_map(|c| c.get("agents").and_then(Value::as_object).cloned())
        .unwrap_or_default()
}

/// 목록을 사람이 읽을 줄로. API 키 연결은 있는지만 적는다(주소·비밀 이름은 싣지 않는다).
pub fn render_list(agents: &Map<String, Value>) -> String {
    if agents.is_empty() {
        return "이 오퍼레이터가 돌릴 수 있다고 적어 둔 에이전트가 없다 — `agent add <agent-id>` 로 넣은 뒤 앱의 에이전트 상세에서 이 오퍼레이터를 배정한다".to_string();
    }
    let text = |a: &Value, k: &str| {
        a.get(k)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    agents
        .iter()
        .map(|(id, a)| {
            let mut line = format!(
                "{id}  작업 폴더: {}",
                text(a, "workingDir").unwrap_or_else(|| "(없음)".to_string())
            );
            if let Some(p) = text(a, "claudePool") {
                line.push_str(&format!("  계정 풀: {p}"));
            }
            if let Some(r) = text(a, "runner") {
                line.push_str(&format!("  러너: {r}"));
            }
            if a.get("providerLane").is_some_and(Value::is_object) {
                line.push_str("  API 키 연결: 있음");
            }
            line
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// `list --json` 이 찍는 목록 — `providerLane` 은 사람용 출력처럼 있다는 것(`true`)만 남긴다.
/// 연결 주소(`baseUrl`)·비밀 이름(`secretName`)은 터미널·로그에 찍지 않는다.
pub fn json_listing(agents: &Map<String, Value>) -> Map<String, Value> {
    agents
        .iter()
        .map(|(id, a)| {
            let mut a = a.clone();
            if let Some(o) = a.as_object_mut()
                && o.contains_key("providerLane")
            {
                let present = o["providerLane"].is_object();
                o.insert("providerLane".to_string(), Value::Bool(present));
            }
            (id.clone(), a)
        })
        .collect()
}

/// `add` 가 보낼 `config` — 인자로 준 값이 이기고, 안 준 값은 있던 칸의 것을 그대로 둔다.
pub fn merged_config(
    existing: Option<&Value>,
    working_dir: Option<&str>,
    claude_pool: Option<&str>,
) -> Value {
    let old = |k: &str| {
        existing
            .and_then(|e| e.get(k))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
    };
    let mut config = Map::new();
    if let Some(w) = working_dir.or_else(|| old("workingDir")) {
        config.insert("workingDir".into(), Value::String(w.to_string()));
    }
    if let Some(p) = claude_pool.or_else(|| old("claudePool")) {
        config.insert("claudePool".into(), Value::String(p.to_string()));
    }
    Value::Object(config)
}

/// `agent` 진입점. 표·결과는 `out`, 오류는 `err`. 돌려주는 것은 종료 코드(0 됨 · 1 실패 · 2 인자 틀림).
pub fn agent_main(
    argv: &[String],
    env: &dyn Fn(&str) -> Option<String>,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> i32 {
    let args = match parse_agent_args(argv) {
        Ok(a) => a,
        Err(e) => {
            let _ = writeln!(err, "{e}");
            return 2;
        }
    };
    let Some(home) = args
        .home
        .clone()
        .or_else(|| env("HOME"))
        .filter(|h| !h.is_empty())
    else {
        let _ = writeln!(err, "HOME 을 모른다");
        return 2;
    };
    let app_data = args
        .app_data
        .clone()
        .unwrap_or_else(|| default_app_data(env, &home));
    let run = || -> Result<String, String> {
        let root = register_root(&home, &args.base_url, &app_data)?;
        let mut conn = Conn::open(&root, REQUEST_TIMEOUT)?;
        let snapshot = conn.call("operatorAgentsList", json!({}))?;
        let agents = agents_of(&snapshot, &args.base_url);
        match &args.action {
            Action::List { json: true } => Ok(Value::Object(json_listing(&agents)).to_string()),
            Action::List { json: false } => Ok(render_list(&agents)),
            Action::Add {
                agent_id,
                working_dir,
                claude_pool,
            } => {
                let existing = agents.get(agent_id);
                let config =
                    merged_config(existing, working_dir.as_deref(), claude_pool.as_deref());
                conn.call(
                    "operatorAgentSet",
                    json!({ "baseUrl": args.base_url, "agentId": agent_id, "config": config }),
                )?;
                let mut lines = vec![format!(
                    "{}: {agent_id}",
                    if existing.is_some() {
                        "고쳤다"
                    } else {
                        "넣었다"
                    }
                )];
                match config.get("workingDir").and_then(Value::as_str) {
                    Some(w) => {
                        lines.push(format!("  작업 폴더: {w}"));
                        if !std::path::Path::new(w).is_dir() {
                            lines.push(format!(
                                "  주의: 그 폴더가 아직 없다 — 배정 전에 만든다(mkdir -p {w})"
                            ));
                        }
                    }
                    None => lines.push(
                        "  작업 폴더를 정하지 않았다 — 정하려면 `--working-dir <절대 경로>` 로 다시 부른다"
                            .to_string(),
                    ),
                }
                lines.push(
                    "도는 오퍼레이터가 바뀐 목록을 서버에 다시 알린다(다시 띄울 필요 없음). 이제 앱의 에이전트 상세에서 이 오퍼레이터를 배정한다."
                        .to_string(),
                );
                Ok(lines.join("\n"))
            }
            Action::Remove { agent_id } => {
                if !agents.contains_key(agent_id) {
                    return Err(format!("목록에 없는 에이전트다: {agent_id}"));
                }
                conn.call(
                    "operatorAgentRemove",
                    json!({ "baseUrl": args.base_url, "agentId": agent_id }),
                )?;
                Ok(format!(
                    "뺐다: {agent_id}\n도는 오퍼레이터가 바뀐 목록을 서버에 다시 알린다. 배정이 이 오퍼레이터에 남아 있으면 앱에서 다른 오퍼레이터로 옮긴다."
                ))
            }
        }
    };
    match run() {
        Ok(text) => {
            let _ = writeln!(out, "{text}");
            0
        }
        Err(e) => {
            let _ = writeln!(err, "{e}");
            1
        }
    }
}

#[cfg(test)]
mod tests;
