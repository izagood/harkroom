//! `harkroom-operator merge <owner/name> <PR 번호> --head <40자 sha>` — 하네스 셸에서 도는 클라이언트.
//! 인자를 재고, 브릿지와 같은 소켓·같은 자격으로 `tools/call repo.merge` 한 줄을 보낸 뒤 답 한 줄을 받아 JSON 한 줄로 찍는다.
//! 판정·gh 실행은 전부 오퍼레이터 쪽이다 — 이 프로세스는 토큰도 임대도 모른다.
use harkroom_proto::p1::{RUNNER_LINK_PROTOCOL_VERSION, RunnerLinkKind};
use serde_json::{Map, Value, json};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::time::Duration;

pub const MERGE_TOOL: &str = "repo.merge";
/// 링크 env(`RUNNER_LINK_ENV`·`RUNNER_TURN_KEY_ENV.shell`·`RUNNER_TURN_CAUSE_ENV`).
pub const ENV_SOCKET: &str = "HARKROOM_OPERATOR_SOCKET";
pub const ENV_RUNNER_ID: &str = "HARKROOM_RUNNER_ID";
pub const ENV_SECRET: &str = "HARKROOM_RUNNER_SECRET";
pub const ENV_TURN_KEY: &str = "HARKROOM_TURN_GRANT";
pub const ENV_CAUSE: &str = "HARKROOM_TURN_CAUSE";
/// 오퍼레이터가 답하지 않을 때 기다리는 상한 — TS `DEFAULT_REQUEST_TIMEOUT_MS`(90초)와 같다.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(90);
/// 링크가 이만큼 안 붙으면 포기한다 — TS `DEFAULT_LINK_DOWN_GRACE_MS`.
pub const LINK_DOWN_GRACE: Duration = Duration::from_secs(15);
/// 아래 문구들은 TS 브릿지(`mcpBridge.ts`)가 같은 경우에 내는 글과 글자까지 같다.
pub const LINK_DOWN_MESSAGE: &str = "오퍼레이터 링크가 없다 — 재접속 중이다. 잠시 뒤 다시 불러라";
pub const LINK_CLOSED_MESSAGE: &str = "오퍼레이터 링크가 끊겼다(오퍼레이터 교체·재시작) — 이 요청이 처리됐는지는 알 수 없다. 결과를 확인한 뒤에 다시 불러라. 링크는 곧 스스로 다시 붙는다";
fn timeout_message(t: Duration) -> String {
    format!(
        "harkroom 오퍼레이터가 {}ms 안에 답하지 않았다 — 이 요청이 처리됐는지는 알 수 없다. 결과를 확인한 뒤에 다시 불러라",
        t.as_millis()
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MergeArgs {
    pub repo: String,
    pub number: u64,
    pub head_sha: String,
}

fn is_repo(s: &str) -> bool {
    // /^[a-z0-9][a-z0-9._-]{0,99}\/[a-z0-9._-]{1,100}$/i
    let Some((owner, name)) = s.split_once('/') else {
        return false;
    };
    let ok = |c: char| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-');
    let mut oc = owner.chars();
    matches!(oc.next(), Some(c) if c.is_ascii_alphanumeric())
        && owner.chars().count() <= 100
        && oc.all(ok)
        && (1..=100).contains(&name.chars().count())
        && name.chars().all(ok)
}

fn is_pr_number(s: &str) -> bool {
    // /^[1-9][0-9]{0,8}$/
    let b = s.as_bytes();
    (1..=9).contains(&b.len()) && (b'1'..=b'9').contains(&b[0]) && b.iter().all(u8::is_ascii_digit)
}

fn is_sha(s: &str) -> bool {
    s.len() == 40
        && s.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

/// `parseMergeArgs` — 오류 문구도 TS 와 글자까지 같다(출력 JSON 의 `error.message` 로 나간다).
pub fn parse_merge_args(argv: &[String]) -> Result<MergeArgs, String> {
    let (Some(repo), Some(num)) = (argv.first(), argv.get(1)) else {
        return Err(
            "사용법: harkroom-operator merge <owner/name> <PR 번호> --head <40자 sha>".into(),
        );
    };
    if repo.is_empty() || num.is_empty() {
        return Err(
            "사용법: harkroom-operator merge <owner/name> <PR 번호> --head <40자 sha>".into(),
        );
    }
    if !is_repo(repo) {
        return Err(format!("저장소 이름이 아니다: {repo}"));
    }
    if !is_pr_number(num) {
        return Err(format!("PR 번호는 양의 정수 하나다: {num}"));
    }
    let rest = &argv[2..];
    let mut head: Option<&String> = None;
    let mut i = 0;
    while i < rest.len() {
        let flag = &rest[i];
        let value = rest.get(i + 1);
        if flag == "--head" && value.is_some() && head.is_none() {
            head = value;
            i += 2;
            continue;
        }
        return Err(format!(
            "받지 않는 인자: {flag} — 래퍼는 --head 만 받는다(--admin·--auto·-R·--approval 없음)"
        ));
    }
    match head {
        Some(h) if is_sha(h) => Ok(MergeArgs {
            repo: repo.to_lowercase(),
            number: num.parse().expect("숫자를 쟀다"),
            head_sha: h.clone(),
        }),
        _ => Err("--head <40자 hex sha> 가 필요하다".into()),
    }
}

/// 링크 자격 — env 에서 읽는다(`callOperatorTool`).
#[derive(Debug, Clone)]
pub struct LinkEnv {
    pub socket_path: String,
    pub runner_id: String,
    pub secret: Option<String>,
    pub turn_key: Option<String>,
    pub cause: Option<String>,
    pub cwd: Option<String>,
}

impl LinkEnv {
    /// 빈 값은 없는 것으로 친다(TS 의 `|| null`). 턴 밖이면 `None`.
    pub fn from_env(get: impl Fn(&str) -> Option<String>, cwd: Option<String>) -> Option<LinkEnv> {
        let nonempty = |k: &str| get(k).filter(|v| !v.is_empty());
        let socket_path = nonempty(ENV_SOCKET)?;
        let runner_id = nonempty(ENV_RUNNER_ID)?;
        let secret = nonempty(ENV_SECRET);
        let turn_key = nonempty(ENV_TURN_KEY);
        let cause = nonempty(ENV_CAUSE);
        if turn_key.is_none() && (secret.is_none() || cause.is_none()) {
            return None;
        }
        Some(LinkEnv {
            socket_path,
            runner_id,
            secret,
            turn_key,
            cause,
            cwd,
        })
    }
}

/// `{ ok, text }` — 오퍼레이터가 돌려준 도구 결과의 첫 글(`content[0].text`)과 `isError`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolReply {
    pub ok: bool,
    pub text: String,
}

fn link_error(message: &str) -> ToolReply {
    ToolReply {
        ok: false,
        text: json!({ "error": { "code": "link_error", "message": message } }).to_string(),
    }
}

/// 브릿지와 같은 꼴로 `tools/call` 한 줄을 보내고 답 한 줄을 받는다.
pub fn call_operator_tool(link: &LinkEnv, name: &str, args: Value, timeout: Duration) -> ToolReply {
    let kind = if link.turn_key.is_some() {
        RunnerLinkKind::Wrapper
    } else {
        RunnerLinkKind::Bridge
    };
    let mut hello = Map::new();
    hello.insert("type".into(), json!("hello"));
    hello.insert("version".into(), json!(RUNNER_LINK_PROTOCOL_VERSION));
    hello.insert("role".into(), json!("runner"));
    hello.insert("runnerId".into(), json!(link.runner_id));
    match &link.turn_key {
        Some(k) => hello.insert("turnKey".into(), json!(k)),
        None => hello.insert(
            "secret".into(),
            json!(link.secret.clone().unwrap_or_default()),
        ),
    };
    hello.insert("kind".into(), serde_json::to_value(kind).expect("직렬화"));
    let payload = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": name, "arguments": args } });
    let mut req = Map::new();
    req.insert("type".into(), json!("mcp.request"));
    req.insert("id".into(), json!("w1"));
    req.insert("payload".into(), payload);
    if let Some(c) = &link.cause {
        req.insert("cause".into(), json!(c));
    }
    if let Some(c) = &link.cwd {
        req.insert("cwd".into(), json!(c));
    }

    // TS 브릿지처럼 200ms 부터 두 배씩(상한 5초) 다시 붙되, 유예(15초)를 넘기면 LINK_DOWN 으로 답한다.
    // link.rejected 도 TS 에서는 재접속 → 유예 만료로 같은 답이 된다.
    let started = std::time::Instant::now();
    let mut delay = Duration::from_millis(200);
    let mut sock = loop {
        if let Ok(s) = UnixStream::connect(&link.socket_path) {
            break s;
        }
        if started.elapsed() + delay > LINK_DOWN_GRACE {
            return link_error(LINK_DOWN_MESSAGE);
        }
        std::thread::sleep(delay);
        delay = (delay * 2).min(Duration::from_secs(5));
    };
    let _ = sock.set_read_timeout(Some(timeout));
    let line = format!("{}\n{}\n", Value::Object(hello), Value::Object(req));
    if sock.write_all(line.as_bytes()).is_err() {
        return link_error(LINK_CLOSED_MESSAGE);
    }
    let mut reader = BufReader::new(sock);
    let mut buf = String::new();
    loop {
        buf.clear();
        match reader.read_line(&mut buf) {
            Ok(0) => return link_error(LINK_CLOSED_MESSAGE),
            Ok(_) => {}
            Err(_) => return link_error(&timeout_message(timeout)),
        }
        let Ok(frame) = serde_json::from_str::<Value>(buf.trim_end()) else {
            continue;
        };
        match frame["type"].as_str() {
            Some("link.rejected") => return link_error(LINK_DOWN_MESSAGE),
            Some("mcp.error") if frame["id"] == "w1" => {
                // TS 템플릿 문자열처럼: 문자열은 따옴표 없이, 그 밖은 JSON 그대로.
                let status = match &frame["status"] {
                    Value::String(s) => s.clone(),
                    v => v.to_string(),
                };
                let msg = format!(
                    "harkroom 서버가 거절했다 ({status}): {}",
                    frame["message"].as_str().unwrap_or("undefined")
                );
                return link_error(&msg);
            }
            Some("mcp.response") if frame["id"] == "w1" => {
                let Some(msg) = frame["messages"]
                    .as_array()
                    .and_then(|m| m.iter().find(|m| m["id"] == 1))
                else {
                    return ToolReply { ok: false, text: json!({ "error": { "code": "bad_reply", "message": "unparseable reply from operator" } }).to_string() };
                };
                if let Some(err) = msg.get("error") {
                    return link_error(err["message"].as_str().unwrap_or("link error"));
                }
                let result = &msg["result"];
                let ok = result["isError"] != json!(true);
                let text = result["content"][0]["text"]
                    .as_str()
                    .unwrap_or("{}")
                    .to_string();
                return ToolReply { ok, text };
            }
            _ => continue,
        }
    }
}

/// 한 줄 출력과 종료 코드. TS: `{ ...out, merged: out.merged === true, exit }`(키 순서까지 같다).
pub fn render(reply: &ToolReply) -> (String, i32) {
    let mut out: Map<String, Value> = match serde_json::from_str::<Value>(&reply.text) {
        Ok(Value::Object(m)) => m,
        // JS 의 `typeof [] === 'object'` 라 배열도 펼쳐진다: `{...[a,b]}` → `{"0":a,"1":b}`.
        Ok(Value::Array(a)) => a
            .into_iter()
            .enumerate()
            .map(|(i, v)| (i.to_string(), v))
            .collect(),
        Ok(_) => Map::new(),
        Err(_) => {
            let mut m = Map::new();
            m.insert("raw".into(), json!(reply.text));
            m
        }
    };
    let merged = out.get("merged") == Some(&json!(true));
    let exit = if reply.ok { 0 } else { 1 };
    out.insert("merged".into(), json!(merged));
    out.insert("exit".into(), json!(exit));
    (Value::Object(out).to_string(), exit)
}

/// `mergeMain` 전체: (출력 한 줄, 종료 코드).
pub fn merge_main(argv: &[String], link: Option<LinkEnv>, timeout: Duration) -> (String, i32) {
    let parsed = match parse_merge_args(argv) {
        Ok(p) => p,
        Err(message) => {
            return (json!({ "error": { "code": "bad_request", "message": message }, "merged": false, "exit": 2 }).to_string(), 2);
        }
    };
    let Some(link) = link else {
        let message = format!(
            "{ENV_SOCKET}·{ENV_RUNNER_ID}·{ENV_SECRET}·{ENV_CAUSE} are required — the wrapper only runs inside a runner-launched mention turn"
        );
        return (json!({ "error": { "code": "not_in_turn", "message": message }, "merged": false, "exit": 2 }).to_string(), 2);
    };
    let args = json!({ "repo": parsed.repo, "number": parsed.number, "headSha": parsed.head_sha });
    render(&call_operator_tool(&link, MERGE_TOOL, args, timeout))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }
    const SHA: &str = "53e53ae5d9f3b6fb2712d6281f0ec31e66f572f1";

    #[test]
    fn parses_good_args_and_lowercases_repo() {
        let a = parse_merge_args(&v(&["IzaGood/HarkRoom", "1842", "--head", SHA])).unwrap();
        assert_eq!(
            a,
            MergeArgs {
                repo: "izagood/harkroom".into(),
                number: 1842,
                head_sha: SHA.into()
            }
        );
    }

    #[test]
    fn rejects_like_ts() {
        let usage = "사용법: harkroom-operator merge <owner/name> <PR 번호> --head <40자 sha>";
        assert_eq!(parse_merge_args(&v(&["a/b"])).unwrap_err(), usage);
        assert_eq!(
            parse_merge_args(&v(&["ab", "1"])).unwrap_err(),
            "저장소 이름이 아니다: ab"
        );
        assert_eq!(
            parse_merge_args(&v(&["a/b", "01"])).unwrap_err(),
            "PR 번호는 양의 정수 하나다: 01"
        );
        assert_eq!(
            parse_merge_args(&v(&["a/b", "1", "--admin"])).unwrap_err(),
            "받지 않는 인자: --admin — 래퍼는 --head 만 받는다(--admin·--auto·-R·--approval 없음)"
        );
        assert_eq!(
            parse_merge_args(&v(&["a/b", "1", "--head", SHA, "--head", SHA])).unwrap_err(),
            "받지 않는 인자: --head — 래퍼는 --head 만 받는다(--admin·--auto·-R·--approval 없음)"
        );
        assert_eq!(
            parse_merge_args(&v(&["a/b", "1", "--head", "ABC"])).unwrap_err(),
            "--head <40자 hex sha> 가 필요하다"
        );
        assert_eq!(
            parse_merge_args(&v(&["a/b", "1"])).unwrap_err(),
            "--head <40자 hex sha> 가 필요하다"
        );
    }

    #[test]
    fn render_matches_ts_spread() {
        let r = |ok, t: &str| render(&ToolReply { ok, text: t.into() });
        assert_eq!(
            r(true, r#"{"merged":true,"exit":9,"pr":1}"#),
            (r#"{"merged":true,"exit":0,"pr":1}"#.into(), 0)
        );
        assert_eq!(
            r(false, r#"{"error":{"code":"not_granted"}}"#),
            (
                r#"{"error":{"code":"not_granted"},"merged":false,"exit":1}"#.into(),
                1
            )
        );
        assert_eq!(
            r(true, "not json"),
            (r#"{"raw":"not json","merged":false,"exit":0}"#.into(), 0)
        );
        assert_eq!(r(true, "null"), (r#"{"merged":false,"exit":0}"#.into(), 0));
        assert_eq!(
            r(true, r#"["a",1]"#),
            (r#"{"0":"a","1":1,"merged":false,"exit":0}"#.into(), 0)
        );
        assert_eq!(
            r(true, r#"{"merged":"yes"}"#),
            (r#"{"merged":false,"exit":0}"#.into(), 0)
        );
    }

    #[test]
    fn link_env_needs_turn_key_or_secret_and_cause() {
        let env = |pairs: &'static [(&'static str, &'static str)]| {
            move |k: &str| {
                pairs
                    .iter()
                    .find(|(a, _)| *a == k)
                    .map(|(_, b)| b.to_string())
            }
        };
        assert!(
            LinkEnv::from_env(env(&[(ENV_SOCKET, "/s"), (ENV_RUNNER_ID, "r")]), None).is_none()
        );
        assert!(
            LinkEnv::from_env(
                env(&[(ENV_SOCKET, "/s"), (ENV_RUNNER_ID, "r"), (ENV_SECRET, "x")]),
                None
            )
            .is_none()
        );
        assert!(
            LinkEnv::from_env(
                env(&[
                    (ENV_SOCKET, "/s"),
                    (ENV_RUNNER_ID, "r"),
                    (ENV_SECRET, "x"),
                    (ENV_CAUSE, "c")
                ]),
                None
            )
            .is_some()
        );
        assert!(
            LinkEnv::from_env(
                env(&[(ENV_SOCKET, "/s"), (ENV_RUNNER_ID, "r"), (ENV_TURN_KEY, "")]),
                None
            )
            .is_none()
        );
        assert!(
            LinkEnv::from_env(
                env(&[
                    (ENV_SOCKET, "/s"),
                    (ENV_RUNNER_ID, "r"),
                    (ENV_TURN_KEY, "k")
                ]),
                None
            )
            .is_some()
        );
    }
}
