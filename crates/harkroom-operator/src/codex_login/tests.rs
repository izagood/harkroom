use super::*;
use std::sync::mpsc;
use std::time::Instant;

fn tmpdir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!(
        "hk-c3c2-{tag}-{}",
        crate::endpoint::random_hex(6).unwrap()
    ));
    fs::create_dir_all(&d).unwrap();
    d
}

/// 가짜 `codex login` — `sh -c <script>`, `CODEX_HOME` 을 넘긴다.
fn fake(script: &'static str) -> SpawnLogin {
    Box::new(move |home: &Path| {
        std::process::Command::new("sh")
            .args(["-c", script])
            .env("CODEX_HOME", home)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
    })
}

/// `auth.json` 이 있으면 로그인된 것으로 본다(시험용 상태).
fn status() -> StatusOf {
    Arc::new(|home: &Path| json!({ "loggedIn": home.join("auth.json").exists() }))
}

fn logins(
    root: &Path,
    script: &'static str,
    grace: Duration,
) -> (CodexLogins, mpsc::Receiver<Value>) {
    let l = CodexLogins::new(root.to_path_buf(), fake(script), status(), grace);
    let (tx, rx) = mpsc::channel();
    let tx = Mutex::new(tx);
    l.on_event(Box::new(move |e| {
        let _ = tx.lock().unwrap().send(e);
    }));
    (l, rx)
}

fn next(rx: &mpsc::Receiver<Value>) -> Value {
    rx.recv_timeout(Duration::from_secs(10))
        .expect("이벤트가 와야 한다")
}

#[test]
fn url_needs_openai_prefix_and_terminator() {
    assert_eq!(
        find_login_url("open https://auth.openai.com/oauth?x=1&y=2 \n"),
        Some("https://auth.openai.com/oauth?x=1&y=2".into())
    );
    assert_eq!(
        find_login_url("\u{1b}]8;;https://auth.openai.com/a\u{7}"),
        Some("https://auth.openai.com/a".into())
    );
    // 끝 표식 전에는 내지 않는다(청크가 URL 중간에서 잘릴 수 있다).
    assert_eq!(find_login_url("https://auth.openai.com/oauth?x=1"), None);
    // 다른 호스트는 무시한다(콜백 localhost URL 을 내지 않는다).
    assert_eq!(
        find_login_url("http://localhost:1455/auth/callback \n"),
        None
    );
    assert_eq!(find_login_url("https://example.com/x \n"), None);
    // `+` — 접두만 있고 바로 끝나면 다음 자리에서 찾는다.
    assert_eq!(
        find_login_url("https://auth.openai.com/ https://auth.openai.com/b\n"),
        Some("https://auth.openai.com/b".into())
    );
}

#[test]
fn success_emits_url_once_then_done_and_signed_in() {
    let root = tmpdir("ok");
    // URL 을 두 번(stderr 에 쪼개서, stdout 에 다시) 찍어도 한 번만 낸다.
    let (l, rx) = logins(
        &root,
        "printf 'https://auth.openai.com/oau' >&2; sleep 0.2; printf 'th?a=1\\n' >&2; \
         sleep 0.3; echo https://auth.openai.com/again; echo '{}' > \"$CODEX_HOME/auth.json\"",
        LOGIN_KILL_GRACE,
    );
    let hit = Arc::new(Mutex::new(None::<PathBuf>));
    let h = hit.clone();
    l.set_on_signed_in(Box::new(move |p| {
        *h.lock().unwrap() = Some(p.to_path_buf())
    }));
    let id = l.start("work").unwrap();
    let e1 = next(&rx);
    assert_eq!(
        e1,
        json!({ "loginId": id, "url": "https://auth.openai.com/oauth?a=1" })
    );
    let e2 = next(&rx);
    assert_eq!(e2["done"], json!(true));
    assert_eq!(e2["status"]["loggedIn"], json!(true));
    assert!(e2.get("error").is_none());
    assert!(
        rx.recv_timeout(Duration::from_millis(300)).is_err(),
        "URL 은 한 번만"
    );
    assert_eq!(
        hit.lock().unwrap().as_deref(),
        Some(root.join("work").as_path())
    );
    assert_eq!(l.live(), 0);
    let mode = std::os::unix::fs::PermissionsExt::mode(
        &fs::metadata(root.join("work")).unwrap().permissions(),
    );
    assert_eq!(mode & 0o777, 0o700);
}

#[test]
fn failure_reports_exit_code_and_keeps_dir_like_ts() {
    let root = tmpdir("fail");
    let (l, rx) = logins(&root, "exit 3", LOGIN_KILL_GRACE);
    let called = Arc::new(Mutex::new(false));
    let c = called.clone();
    l.set_on_signed_in(Box::new(move |_| *c.lock().unwrap() = true));
    l.start("work").unwrap();
    let e = next(&rx);
    assert_eq!(e["done"], json!(true));
    assert_eq!(e["status"]["loggedIn"], json!(false));
    assert_eq!(
        e["error"],
        json!("로그인이 끝나지 않았다 (종료 코드 3) — 다시 시도해라")
    );
    assert!(!*called.lock().unwrap());
    // TS 와 같이 실패해도 지우지 않는다.
    assert!(root.join("work").is_dir());
}

#[test]
fn only_one_login_at_a_time_even_across_accounts() {
    let root = tmpdir("one");
    let (l, rx) = logins(&root, "sleep 30", Duration::from_millis(200));
    let id = l.start("a").unwrap();
    assert_eq!(
        l.start("b").unwrap_err(),
        "codex 로그인이 이미 진행 중이다: a"
    );
    l.cancel(&id);
    let e = next(&rx);
    assert_eq!(e["done"], json!(true));
    // 끝난 뒤에는 다시 된다.
    let id2 = l.start("b").unwrap();
    l.cancel(&id2);
    next(&rx);
}

#[test]
fn cancel_kills_term_ignoring_child_after_grace() {
    let root = tmpdir("kill");
    let (l, rx) = logins(&root, "trap '' TERM; sleep 30", Duration::from_millis(300));
    let id = l.start("a").unwrap();
    std::thread::sleep(Duration::from_millis(200));
    let t0 = Instant::now();
    l.cancel(&id);
    let e = next(&rx);
    assert_eq!(e["done"], json!(true));
    assert!(
        t0.elapsed() >= Duration::from_millis(250),
        "TERM 은 무시됐고 KILL 로 끝나야 한다"
    );
    // 끝난 것·모르는 id 취소는 조용히 지나간다.
    l.cancel(&id);
    l.cancel("nope");
}

#[test]
fn shutdown_reaps_live_logins() {
    let root = tmpdir("shut");
    let (l, _rx) = logins(&root, "trap '' TERM; sleep 30", LOGIN_KILL_GRACE);
    l.start("a").unwrap();
    assert_eq!(l.live(), 1);
    l.shutdown();
    assert_eq!(l.live(), 0);
}

#[test]
fn rejects_bad_name_and_symlink_slot() {
    let root = tmpdir("bad");
    let (l, _rx) = logins(&root, "exit 0", LOGIN_KILL_GRACE);
    assert!(l.start("../x").is_err());
    assert!(l.start("A").is_err());
    let outside = tmpdir("outside");
    std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
    assert!(l.start("link").unwrap_err().contains("심링크"));
    assert_eq!(l.live(), 0);
}

#[test]
fn read_login_ref_matches_ts() {
    assert_eq!(
        read_login_ref(Some(&json!({ "loginId": "x" }))).unwrap(),
        "x"
    );
    assert_eq!(
        read_login_ref(Some(&json!({ "loginId": "" }))).unwrap_err(),
        "loginId 가 없다"
    );
    assert_eq!(
        read_login_ref(Some(&json!([]))).unwrap_err(),
        "payload 가 객체가 아니다"
    );
    assert_eq!(
        read_login_ref(None).unwrap_err(),
        "payload 가 객체가 아니다"
    );
}
