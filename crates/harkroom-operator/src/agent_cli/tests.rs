use super::*;
use harkroom_roots::daemon_endpoint_paths;
use std::io::{BufRead, BufReader};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};

const URL: &str = "http://c.example.com";
const AGENT: &str = "11111111-2222-4333-8444-555555555555";

fn s(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| x.to_string()).collect()
}

struct Dir(std::path::PathBuf);
impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
impl Dir {
    fn new() -> Dir {
        use std::sync::atomic::{AtomicU32, Ordering};
        static SEQ: AtomicU32 = AtomicU32::new(0);
        // 소켓 경로 상한 안에 들게 /tmp 아래 짧게 둔다.
        let d = std::path::PathBuf::from(format!(
            "/tmp/hkag-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        Dir(d)
    }
    fn p(&self) -> &str {
        self.0.to_str().unwrap()
    }
}

fn chmod(path: &str, mode: u32) {
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
}

/// 가짜 도는 오퍼레이터 — 요청마다 `answer(type, payload)` 의 답을 돌려주고, 받은 요청을 모아 돌려준다.
fn fake_operator<F>(root: &str, answer: F) -> std::thread::JoinHandle<Vec<Value>>
where
    F: Fn(&str, &Value) -> Result<Value, &'static str> + Send + 'static,
{
    let paths = daemon_endpoint_paths(root);
    std::fs::create_dir_all(&paths.dir).unwrap();
    chmod(&paths.dir, 0o700);
    std::fs::write(&paths.token_path, "sock-tok\n").unwrap();
    chmod(&paths.token_path, 0o600);
    let listener = UnixListener::bind(&paths.socket_path).unwrap();
    std::thread::spawn(move || {
        let (sock, _) = listener.accept().unwrap();
        let mut w: UnixStream = sock.try_clone().unwrap();
        let mut r = BufReader::new(sock);
        let mut seen = Vec::new();
        let mut line = String::new();
        r.read_line(&mut line).unwrap();
        w.write_all(b"{\"type\":\"hello\",\"ok\":true}\n").unwrap();
        loop {
            line.clear();
            if r.read_line(&mut line).unwrap_or(0) == 0 {
                return seen;
            }
            let req: Value = serde_json::from_str(line.trim_end()).unwrap();
            let ty = req["type"].as_str().unwrap().to_string();
            let reply = match answer(&ty, &req["payload"]) {
                Ok(p) => json!({ "id": ty, "ok": true, "payload": p }),
                Err(m) => {
                    json!({ "id": ty, "ok": false, "error": { "code": "bad-payload", "message": m } })
                }
            };
            seen.push(req);
            let _ = w.write_all(format!("{reply}\n").as_bytes());
        }
    })
}

/// 뿌리를 `--home` 아래에 잡고 `agent` 를 돌린다 → (종료 코드, out, err).
fn run(home: &Dir, argv: &[&str]) -> (i32, String, String) {
    let mut v = s(argv);
    v.extend(s(&[
        "--base-url",
        URL,
        "--home",
        home.p(),
        "--app-data",
        &format!("{}/data", home.p()),
    ]));
    let (mut out, mut err) = (Vec::new(), Vec::new());
    let code = agent_main(&v, &|_| None, &mut out, &mut err);
    (
        code,
        String::from_utf8(out).unwrap(),
        String::from_utf8(err).unwrap(),
    )
}

fn root_of(home: &Dir) -> String {
    register_root(home.p(), URL, &format!("{}/data", home.p())).unwrap()
}

fn listing(agents: Value) -> Value {
    json!({ "communities": [
        { "baseUrl": "http://other.example.com", "registered": true, "operatorId": null,
          "agents": { "99999999-2222-4333-8444-555555555555": {} } },
        { "baseUrl": format!("{URL}/"), "registered": true, "operatorId": "op", "agents": agents },
    ] })
}

#[test]
fn parses_verbs_and_rejects_bad_shapes() {
    let a = parse_agent_args(&s(&["list", "--base-url", URL, "--json"])).unwrap();
    assert_eq!(a.action, Action::List { json: true });
    assert_eq!(a.base_url, URL);
    let upper = AGENT.to_ascii_uppercase();
    let a = parse_agent_args(&s(&[
        "add",
        &upper,
        "--working-dir",
        "/srv/work",
        "--claude-pool",
        "main",
        "--base-url",
        URL,
    ]))
    .unwrap();
    assert_eq!(
        a.action,
        Action::Add {
            agent_id: AGENT.to_string(),
            working_dir: Some("/srv/work".to_string()),
            claude_pool: Some("main".to_string()),
        },
        "id 는 소문자로 맞춘다"
    );
    let a = parse_agent_args(&s(&["remove", AGENT, "--base-url", URL])).unwrap();
    assert_eq!(
        a.action,
        Action::Remove {
            agent_id: AGENT.to_string()
        }
    );
    for bad in [
        vec![],
        vec!["list"],
        vec!["list", "extra", "--base-url", URL],
        vec!["add", "--base-url", URL],
        vec!["add", "my-agent", "--base-url", URL],
        vec!["add", AGENT, AGENT, "--base-url", URL],
        vec!["add", AGENT, "--working-dir", "rel/dir", "--base-url", URL],
        vec!["add", AGENT, "--working-dir", "--base-url", URL],
        vec!["remove", AGENT, "--working-dir", "/x", "--base-url", URL],
        vec!["list", "--bogus", "--base-url", URL],
        vec!["add", AGENT, "--base-url", "ftp://c.example.com"],
        vec!["rename", AGENT, "--base-url", URL],
    ] {
        assert!(parse_agent_args(&s(&bad)).is_err(), "{bad:?}");
    }
    let e = parse_agent_args(&s(&["add", "my-agent", "--base-url", URL])).unwrap_err();
    assert!(e.contains("uuid"), "{e}");
}

#[test]
fn list_shows_only_this_community_and_hides_lane_details() {
    let home = Dir::new();
    let op = fake_operator(&root_of(&home), |ty, _| {
        assert_eq!(ty, "operatorAgentsList");
        Ok(listing(json!({
            AGENT: { "workingDir": "/srv/work", "claudePool": "main",
                     "providerLane": { "baseUrl": "https://api.example.com", "secretName": "lane-key" } },
        })))
    });
    let (code, out, err) = run(&home, &["list"]);
    assert_eq!((code, err.as_str()), (0, ""));
    assert!(out.contains(AGENT) && out.contains("/srv/work") && out.contains("main"));
    assert!(out.contains("API 키 연결: 있음"));
    assert!(!out.contains("lane-key") && !out.contains("api.example.com"));
    assert!(!out.contains("99999999"), "다른 커뮤니티 칸은 싣지 않는다");
    op.join().unwrap();

    assert!(render_list(&Map::new()).contains("agent add"));
}

#[test]
fn add_sends_set_and_keeps_values_not_given() {
    // 새 에이전트 — 준 값만 싣는다.
    let home = Dir::new();
    let op = fake_operator(&root_of(&home), |ty, _| match ty {
        "operatorAgentsList" => Ok(listing(json!({}))),
        _ => Ok(json!({})),
    });
    let work = format!("{}/work", home.p());
    let (code, out, err) = run(&home, &["add", AGENT, "--working-dir", &work]);
    assert_eq!((code, err.as_str()), (0, ""));
    assert!(out.contains("넣었다") && out.contains("다시 띄울 필요 없음"));
    assert!(out.contains("mkdir -p"), "없는 폴더는 알려 준다: {out}");
    let seen = op.join().unwrap();
    assert_eq!(seen.len(), 2);
    assert_eq!(seen[1]["type"], "operatorAgentSet");
    assert_eq!(
        seen[1]["payload"],
        json!({ "baseUrl": URL, "agentId": AGENT, "config": { "workingDir": work } })
    );

    // 있던 칸 — 안 준 작업 폴더는 그대로, 준 풀만 바뀐다.
    let home = Dir::new();
    let op = fake_operator(&root_of(&home), |ty, _| match ty {
        "operatorAgentsList" => Ok(listing(
            json!({ AGENT: { "workingDir": "/srv/old", "claudePool": "old" } }),
        )),
        _ => Ok(json!({})),
    });
    let (code, out, _) = run(&home, &["add", AGENT, "--claude-pool", "new"]);
    assert_eq!(code, 0);
    assert!(out.contains("고쳤다"));
    let seen = op.join().unwrap();
    assert_eq!(
        seen[1]["payload"]["config"],
        json!({ "workingDir": "/srv/old", "claudePool": "new" })
    );

    assert_eq!(merged_config(None, None, None), json!({}));
}

#[test]
fn remove_checks_the_list_first_and_refusals_are_errors() {
    let home = Dir::new();
    let op = fake_operator(&root_of(&home), |_, _| Ok(listing(json!({}))));
    let (code, out, err) = run(&home, &["remove", AGENT]);
    assert_eq!((code, out.as_str()), (1, ""));
    assert!(err.contains("목록에 없는"));
    assert_eq!(op.join().unwrap().len(), 1, "지우기 요청은 보내지 않는다");

    let home = Dir::new();
    let op = fake_operator(&root_of(&home), |ty, _| match ty {
        "operatorAgentsList" => Ok(listing(json!({ AGENT: {} }))),
        _ => Ok(json!({})),
    });
    let (code, out, _) = run(&home, &["remove", AGENT]);
    assert_eq!(code, 0);
    assert!(out.contains("뺐다"));
    let seen = op.join().unwrap();
    assert_eq!(seen[1]["type"], "operatorAgentRemove");
    assert_eq!(
        seen[1]["payload"],
        json!({ "baseUrl": URL, "agentId": AGENT })
    );

    let home = Dir::new();
    let op = fake_operator(&root_of(&home), |ty, _| match ty {
        "operatorAgentsList" => Ok(listing(json!({}))),
        _ => Err("workingDir 에 제어문자가 있다"),
    });
    let (code, _, err) = run(&home, &["add", AGENT]);
    assert_eq!(code, 1);
    assert!(err.contains("제어문자"));
    op.join().unwrap();
}

#[test]
fn main_reports_usage_missing_home_and_not_running() {
    let (mut out, mut err) = (Vec::new(), Vec::new());
    assert_eq!(agent_main(&s(&["bogus"]), &|_| None, &mut out, &mut err), 2);
    assert!(String::from_utf8_lossy(&err).contains("사용법"));
    let mut err = Vec::new();
    assert_eq!(
        agent_main(
            &s(&["list", "--base-url", URL]),
            &|_| None,
            &mut out,
            &mut err
        ),
        2
    );
    assert!(String::from_utf8_lossy(&err).contains("HOME"));
    let home = Dir::new();
    let (code, _, err) = run(&home, &["list"]);
    assert_eq!(code, 1);
    assert!(err.contains("떠 있지 않다"), "{err}");
}

#[test]
fn json_listing_keeps_only_the_presence_of_a_provider_lane() {
    let agents = json!({
        AGENT: {
            "workingDir": "/srv/a",
            "providerLane": { "baseUrl": "https://llm.example.com", "secretName": "llm-key" }
        },
        "22222222-2222-4222-8222-222222222222": { "workingDir": "/srv/b" }
    });
    let out = Value::Object(json_listing(agents.as_object().unwrap())).to_string();
    assert!(!out.contains("llm.example.com"), "{out}");
    assert!(!out.contains("llm-key"), "{out}");
    let v: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v[AGENT]["providerLane"], json!(true));
    assert_eq!(v[AGENT]["workingDir"], json!("/srv/a"));
    assert!(
        v["22222222-2222-4222-8222-222222222222"]
            .get("providerLane")
            .is_none()
    );
}
