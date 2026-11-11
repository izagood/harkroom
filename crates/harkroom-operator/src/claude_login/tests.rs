use super::*;
use crate::claude_accounts::account_status_from_disk;
use std::process::{Command, Stdio};
use std::time::Instant;

fn tmp(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!(
        "hk-login-{tag}-{}-{}",
        std::process::id(),
        new_login_id()
    ));
    fs::create_dir_all(&d).unwrap();
    d
}

fn sh(script: &'static str) -> SpawnLogin {
    Box::new(move |dir: &Path| {
        Command::new("sh")
            .args(["-c", script])
            .env("CLAUDE_CONFIG_DIR", dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
    })
}

fn disk_status() -> StatusOf {
    Arc::new(|d: &Path| account_status_from_disk(d, &|_| false))
}

fn setup(script: &'static str, grace: Duration) -> (PathBuf, ClaudeLogins, Arc<Mutex<Vec<Value>>>) {
    let root = tmp("root");
    fs::create_dir_all(root.join("p")).unwrap();
    let pools = root.join("pools.json");
    fs::write(&pools, r#"{"order":{"p":["old"]}}"#).unwrap();
    let logins = ClaudeLogins::new(root.clone(), pools, sh(script), disk_status(), grace);
    let events = Arc::new(Mutex::new(Vec::new()));
    let ev = Arc::clone(&events);
    logins.on_event(Box::new(move |e| ev.lock().unwrap().push(e)));
    (root, logins, events)
}

fn wait_done(events: &Arc<Mutex<Vec<Value>>>) -> Value {
    let until = Instant::now() + Duration::from_secs(15);
    while Instant::now() < until {
        if let Some(e) = events
            .lock()
            .unwrap()
            .iter()
            .find(|e| e.get("done").is_some())
        {
            return e.clone();
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("done 이벤트가 오지 않았다");
}

// 가짜 claude: URL 을 OSC 8 꼴(BEL 끝)로 찍고, 코드 한 줄을 받아 적고, 정체·자격 파일을 남긴다.
const OK_SCRIPT: &str = r#"printf 'Open: \033]8;;https://claude.ai/oauth/x?code=1&s=2\007link\n'; read line; printf '%s' "$line" > "$CLAUDE_CONFIG_DIR/got"; printf '{"oauthAccount":{"emailAddress":"a@b"},"keep":1}' > "$CLAUDE_CONFIG_DIR/.claude.json"; : > "$CLAUDE_CONFIG_DIR/.credentials.json"; exit 0"#;

#[test]
fn url_needs_terminator() {
    assert_eq!(find_login_url("go https://a.b/c"), None);
    assert_eq!(
        find_login_url("go https://a.b/c "),
        Some("https://a.b/c".into())
    );
    assert_eq!(
        find_login_url("\x1b]8;;https://a.b/c?x=1\x07t"),
        Some("https://a.b/c?x=1".into())
    );
    assert_eq!(
        find_login_url("https://a.b/c\x1b\\"),
        Some("https://a.b/c".into())
    );
    assert_eq!(find_login_url("https:// x"), None);
}

#[test]
fn submit_sends_first_line_only() {
    assert_eq!(first_line("abc\r\nrest"), "abc");
    assert_eq!(first_line("abc\nrest"), "abc");
    assert_eq!(first_line("abc"), "abc");
}

#[test]
fn gates_keep_other_keys_and_skip_broken() {
    let mut m = Map::new();
    m.insert("x".into(), json!(1));
    m.insert("autoModeEnvSetup".into(), json!({ "denials": 3 }));
    let next = with_account_gates(&m).unwrap();
    assert_eq!(next["x"], json!(1));
    assert_eq!(next["hasCompletedOnboarding"], json!(true));
    assert_eq!(
        next["autoModeEnvSetup"],
        json!({ "denials": 3, "dismissed": true })
    );
    assert!(with_account_gates(&next).is_none());

    let d = tmp("gates");
    fs::write(d.join(GLOBAL_CONFIG_FILE), "{broken").unwrap();
    assert!(mark_account_gates(&d).is_err());
    assert_eq!(
        fs::read_to_string(d.join(GLOBAL_CONFIG_FILE)).unwrap(),
        "{broken"
    );
    fs::remove_file(d.join(GLOBAL_CONFIG_FILE)).unwrap();
    assert_eq!(mark_account_gates(&d), Ok(true));
    assert_eq!(mark_account_gates(&d), Ok(false));
    use std::os::unix::fs::PermissionsExt;
    let mode = fs::metadata(d.join(GLOBAL_CONFIG_FILE))
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(mode & 0o777, 0o600);
}

#[test]
fn login_success_emits_url_then_done_and_settles_account() {
    let (root, logins, events) = setup(OK_SCRIPT, LOGIN_KILL_GRACE);
    let dir = root.join("p/new");
    let id = logins.start("p", "new", false).unwrap();
    // URL 이 먼저 와야 코드를 넣는다(사람의 순서).
    let until = Instant::now() + Duration::from_secs(10);
    while events.lock().unwrap().is_empty() {
        assert!(Instant::now() < until, "url 이벤트가 오지 않았다");
        std::thread::sleep(Duration::from_millis(20));
    }
    fs::write(dir.join(ATTENTION_FILE), "{}").unwrap();
    fs::write(dir.join(AUTH_FILE), "{}").unwrap();
    logins.submit(&id, "CODE-1\nnext answer").unwrap();
    let done = wait_done(&events);
    let evs = events.lock().unwrap().clone();
    assert_eq!(
        evs[0],
        json!({ "loginId": id, "url": "https://claude.ai/oauth/x?code=1&s=2" })
    );
    assert_eq!(done["status"]["loggedIn"], json!(true));
    assert!(done.get("error").is_none());
    assert_eq!(fs::read_to_string(dir.join("got")).unwrap(), "CODE-1");
    assert!(!dir.join(ATTENTION_FILE).exists() && !dir.join(AUTH_FILE).exists());
    let cfg: Value =
        serde_json::from_str(&fs::read_to_string(dir.join(".claude.json")).unwrap()).unwrap();
    assert_eq!(cfg["keep"], json!(1));
    assert_eq!(cfg["hasCompletedOnboarding"], json!(true));
    let pools: Value =
        serde_json::from_str(&fs::read_to_string(root.join("pools.json")).unwrap()).unwrap();
    assert_eq!(pools["order"]["p"], json!(["old", "new"]));
    assert_eq!(logins.live(), 0);
    assert!(
        logins.submit(&id, "x").is_err(),
        "끝난 로그인에 코드를 받으면 안 된다"
    );
}

#[test]
fn failed_login_removes_only_dir_it_created() {
    let (root, logins, events) = setup("exit 3", LOGIN_KILL_GRACE);
    logins.start("p", "fresh", false).unwrap();
    let done = wait_done(&events);
    assert_eq!(done["status"], json!({ "loggedIn": false }));
    assert!(done["error"].as_str().unwrap().contains("종료 코드 3"));
    assert!(!root.join("p/fresh").exists());

    // 이미 있던 계정의 다시 로그인이 실패해도 그 디렉터리(세션·설정)는 남는다.
    let (root, logins, events) = setup("exit 1", LOGIN_KILL_GRACE);
    fs::create_dir_all(root.join("p/kept")).unwrap();
    fs::write(root.join("p/kept/session"), "s").unwrap();
    logins.start("p", "kept", true).unwrap();
    wait_done(&events);
    assert!(root.join("p/kept/session").exists());
    let pools: Value =
        serde_json::from_str(&fs::read_to_string(root.join("pools.json")).unwrap()).unwrap();
    assert_eq!(pools["order"]["p"], json!(["old"]));
}

#[test]
fn start_rejects_reauth_of_missing_dup_slot_and_escape() {
    let (root, logins, events) = setup("read line; exit 0", LOGIN_KILL_GRACE);
    let e = logins.start("p", "gone", true).unwrap_err();
    assert!(e.contains("다시 로그인할 계정이 없다"));
    assert!(
        !root.join("p/gone").exists(),
        "거절이 디렉터리를 만들면 안 된다"
    );
    assert!(logins.start("..", "x", false).is_err());
    assert!(logins.start("p", "a/b", false).is_err());
    let id = logins.start("p", "a", false).unwrap();
    assert!(
        logins
            .start("p", "a", false)
            .unwrap_err()
            .contains("이미 진행 중")
    );
    logins.submit(&id, "c").unwrap();
    wait_done(&events);
}

#[test]
fn cancel_terms_then_kills_after_grace() {
    let (root, logins, events) = setup(
        "trap '' TERM; while :; do sleep 0.05; done",
        Duration::from_millis(300),
    );
    let id = logins.start("p", "slow", false).unwrap();
    std::thread::sleep(Duration::from_millis(200));
    let t = Instant::now();
    logins.cancel(&id);
    let done = wait_done(&events);
    assert!(
        t.elapsed() >= Duration::from_millis(250),
        "TERM 을 무시하면 유예 뒤 KILL 이어야 한다"
    );
    assert_eq!(done["status"]["loggedIn"], json!(false));
    assert!(!root.join("p/slow").exists());
    logins.cancel(&id); // 끝난 것을 취소해도 던지지 않는다
    logins.cancel("no-such");
}

#[test]
fn shutdown_reaps_all() {
    let (_root, logins, _events) = setup(
        "trap '' TERM; while :; do sleep 0.05; done",
        LOGIN_KILL_GRACE,
    );
    logins.start("p", "a", false).unwrap();
    logins.start("p", "b", false).unwrap();
    assert_eq!(logins.live(), 2);
    logins.shutdown();
    assert_eq!(logins.live(), 0);
}

#[test]
fn submit_payload_shape_like_ts() {
    let ok = json!({ "loginId": "L", "code": "c" });
    assert_eq!(read_login_submit(Some(&ok)), Ok(("L".into(), "c".into())));
    assert!(read_login_submit(Some(&json!({ "loginId": "L" }))).is_err());
    assert!(read_login_submit(Some(&json!({ "loginId": "", "code": "c" }))).is_err());
    assert!(
        read_login_submit(Some(&json!({ "loginId": "L", "code": "x".repeat(4097) })))
            .unwrap_err()
            .contains("너무 길다")
    );
    assert!(read_login_submit(Some(&json!({ "loginId": "L", "code": "x".repeat(4096) }))).is_ok());
    assert!(read_login_ref(Some(&json!([]))).is_err());
    assert!(read_login_ref(None).is_err());
}

#[test]
fn login_ids_are_uuid_v4_and_distinct() {
    let a = new_login_id();
    assert_eq!(a.len(), 36);
    assert_eq!(&a[14..15], "4");
    assert_ne!(a, new_login_id());
}
