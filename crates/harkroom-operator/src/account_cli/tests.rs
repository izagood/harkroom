use super::*;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixListener;

const URL: &str = "http://c.example.com";
const LOGIN_URL: &str = "https://login.example.com/oauth?state=SECRETSTATE";

fn s(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| x.to_string()).collect()
}

fn euid() -> u32 {
    // SAFETY: 인자 없는 조회다.
    unsafe { libc::geteuid() }
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
            "/tmp/hkac-{}-{}",
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

/// 가짜 도는 오퍼레이터 — 토큰(0600)·폴더(0700)를 운영과 같은 권한으로 두고, 접속 하나를 `script` 에 넘긴다.
fn fake_operator<F>(root: &str, script: F) -> std::thread::JoinHandle<Vec<Value>>
where
    F: FnOnce(&mut BufReader<UnixStream>, &mut UnixStream, &mut Vec<Value>) + Send + 'static,
{
    let paths = daemon_endpoint_paths(root);
    std::fs::create_dir_all(&paths.dir).unwrap();
    chmod(&paths.dir, 0o700);
    std::fs::write(&paths.token_path, "sock-tok\n").unwrap();
    chmod(&paths.token_path, 0o600);
    let listener = UnixListener::bind(&paths.socket_path).unwrap();
    std::thread::spawn(move || {
        let (sock, _) = listener.accept().unwrap();
        let mut w = sock.try_clone().unwrap();
        let mut r = BufReader::new(sock);
        let mut seen = Vec::new();
        seen.push(read(&mut r).unwrap());
        w.write_all(b"{\"type\":\"hello\",\"ok\":true}\n").unwrap();
        script(&mut r, &mut w, &mut seen);
        seen
    })
}

fn read(r: &mut BufReader<UnixStream>) -> Option<Value> {
    let mut line = String::new();
    if r.read_line(&mut line).unwrap_or(0) == 0 {
        return None;
    }
    serde_json::from_str(line.trim_end()).ok()
}

fn write(w: &mut UnixStream, v: Value) {
    let _ = w.write_all(format!("{v}\n").as_bytes());
}

fn event(payload: Value) -> Value {
    json!({ "type": "event", "event": "claudeLoginOutput", "payload": payload })
}

/// 프롬프트(`코드> `)가 찍히면 준비한 입력을 넣는 출력 — 사람이 주소를 본 **뒤에** 코드를 넣는 차례를 흉내 낸다.
struct Out {
    buf: Vec<u8>,
    on_prompt: Option<(Sender<Msg>, Msg)>,
}
impl Write for Out {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        self.buf.extend_from_slice(b);
        if String::from_utf8_lossy(&self.buf).contains("코드> ")
            && let Some((tx, m)) = self.on_prompt.take()
        {
            let _ = tx.send(m);
        }
        Ok(b.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn quick() -> LoginTimeouts {
    LoginTimeouts {
        url: Duration::from_secs(5),
        code: Duration::from_secs(5),
        done: Duration::from_secs(5),
    }
}

fn login(root: &str, reauth: bool, input: Msg, t: LoginTimeouts) -> (i32, String, String) {
    let conn = Conn::open(root, Duration::from_secs(5)).unwrap();
    let (tx, rx) = channel();
    let mut out = Out {
        buf: Vec::new(),
        on_prompt: Some((tx.clone(), input)),
    };
    let (code, line) = run_login(
        conn,
        LoginTarget {
            pool: "main",
            account: "work",
            reauth,
        },
        rx,
        tx,
        &mut out,
        t,
    );
    (code, line, String::from_utf8(out.buf).unwrap())
}

#[test]
fn parses_the_three_verbs() {
    let a = parse_account_args(&s(&[
        "list",
        "--base-url",
        "http://c.example.com/",
        "--json",
    ]))
    .unwrap();
    assert_eq!(a.action, Action::List { json: true });
    assert_eq!(a.base_url, URL);
    let a = parse_account_args(&s(&[
        "login",
        "main",
        "work",
        "--reauth",
        "--base-url",
        URL,
    ]))
    .unwrap();
    assert_eq!(
        a.action,
        Action::Login {
            pool: "main".into(),
            account: "work".into(),
            reauth: true
        }
    );
    let a = parse_account_args(&s(&[
        "remove",
        "--base-url",
        URL,
        "main",
        "work",
        "--yes",
        "--home",
        "/h",
    ]))
    .unwrap();
    assert_eq!(
        a.action,
        Action::Remove {
            pool: "main".into(),
            account: "work".into(),
            yes: true
        }
    );
    assert_eq!(a.home.as_deref(), Some("/h"));
    // 틀린 꼴은 모두 사용법이다.
    for bad in [
        &[][..],
        &["login", "main", "--base-url", URL],
        &["list", "extra", "--base-url", URL],
        &["agent", "--base-url", URL],
        &["list"],
        &["list", "--base-url"],
        &["list", "--base-url", URL, "--yes"],
        &["login", "a", "b", "--base-url", "ftp://x.example.com"],
    ] {
        assert!(parse_account_args(&s(bad)).is_err(), "{bad:?}");
    }
}

#[test]
fn token_is_read_only_when_private_regular_and_mine() {
    let d = Dir::new();
    let p = format!("{}/t.token", d.p());
    assert_eq!(read_socket_token(&p, euid()).unwrap(), None, "없으면 None");
    std::fs::write(&p, "abc\n").unwrap();
    chmod(&p, 0o600);
    assert_eq!(
        read_socket_token(&p, euid()).unwrap().as_deref(),
        Some("abc")
    );
    // 남의 소유로 보이면 읽지 않는다.
    let e = read_socket_token(&p, euid() + 1).unwrap_err();
    assert!(e.contains("내 소유가 아니다") && !e.contains("abc"), "{e}");
    // 그룹·남이 읽을 수 있으면 읽지 않는다.
    for mode in [0o640, 0o604, 0o660] {
        chmod(&p, mode);
        let e = read_socket_token(&p, euid()).unwrap_err();
        assert!(e.contains("0600") && !e.contains("abc"), "{e}");
    }
    chmod(&p, 0o600);
    // 심링크는 가리키는 파일이 멀쩡해도 읽지 않는다.
    let link = format!("{}/link.token", d.p());
    std::os::unix::fs::symlink(&p, &link).unwrap();
    assert!(read_socket_token(&link, euid()).is_err());
    // 보통 파일이 아니면(폴더) 읽지 않는다.
    let dir = format!("{}/dir.token", d.p());
    std::fs::create_dir(&dir).unwrap();
    chmod(&dir, 0o700);
    assert!(read_socket_token(&dir, euid()).is_err());
    // 빈 것·너무 큰 것.
    std::fs::write(&p, " \n").unwrap();
    assert!(read_socket_token(&p, euid()).is_err());
    std::fs::write(&p, "a".repeat(5000)).unwrap();
    assert!(read_socket_token(&p, euid()).is_err());
}

#[test]
fn open_refuses_loose_places_and_reports_not_running() {
    let d = Dir::new();
    // 토큰이 없다 = 뜬 적 없다.
    assert_eq!(
        Conn::open(d.p(), Duration::from_secs(1)).err().unwrap(),
        NOT_RUNNING
    );
    let paths = daemon_endpoint_paths(d.p());
    std::fs::create_dir_all(&paths.dir).unwrap();
    chmod(&paths.dir, 0o700);
    std::fs::write(&paths.token_path, "t\n").unwrap();
    chmod(&paths.token_path, 0o600);
    // 토큰만 남고 소켓이 없다(잔해) — 붙지 않는다.
    assert!(Conn::open(d.p(), Duration::from_secs(1)).is_err());
    // 소켓 자리에 보통 파일이 있으면 토큰을 보내지 않는다.
    std::fs::write(&paths.socket_path, "").unwrap();
    let e = Conn::open(d.p(), Duration::from_secs(1)).err().unwrap();
    assert!(e.contains("소켓 파일이 아니다"), "{e}");
    std::fs::remove_file(&paths.socket_path).unwrap();
    // 폴더를 남이 쓸 수 있으면 붙지 않는다.
    let _l = UnixListener::bind(&paths.socket_path).unwrap();
    chmod(&paths.dir, 0o777);
    let e = Conn::open(d.p(), Duration::from_secs(1)).err().unwrap();
    assert!(e.contains("닫힌 디렉터리가 아니다"), "{e}");
    chmod(&paths.dir, 0o700);
}

#[test]
fn list_asks_the_running_operator_and_renders() {
    let d = Dir::new();
    let snap = json!({
        "root": "/x", "mode": "pools", "defaultPool": "main",
        "pools": [
            {"name": "main", "accounts": [
                {"name": "work", "status": {"loggedIn": true, "email": "a@example.com"}},
                {"name": "old", "status": {"loggedIn": false}, "authFailure": {"atMs": 1}},
            ]},
            {"name": "spare", "accounts": []},
        ],
    });
    let reply = snap.clone();
    let srv = fake_operator(d.p(), move |r, w, seen| {
        seen.push(read(r).unwrap());
        // 우리 답이 아닌 줄은 건너뛴다.
        write(w, event(json!({"loginId": "x", "url": LOGIN_URL})));
        write(
            w,
            json!({"id": "claudeAccountsList", "ok": true, "payload": reply}),
        );
    });
    let got = Conn::open(d.p(), Duration::from_secs(5))
        .and_then(|mut c| c.call("claudeAccountsList", json!({})))
        .unwrap();
    assert_eq!(got, snap);
    let seen = srv.join().unwrap();
    assert_eq!(
        seen[0],
        json!({"type": "hello", "version": 1, "token": "sock-tok", "role": "app"})
    );
    assert_eq!(seen[1]["type"], "claudeAccountsList");
    assert_eq!(
        render_list(&snap),
        "풀 main (기본)\n  work\t로그인됨\ta@example.com\n  old\t로그인 안 됨\t[다시 로그인 필요]\n풀 spare\n  (계정 없음)"
    );
    assert!(render_list(&json!({"pools": []})).contains("계정이 없다"));
}

#[test]
fn operator_refusal_is_the_error() {
    let d = Dir::new();
    let srv = fake_operator(d.p(), |r, w, seen| {
        seen.push(read(r).unwrap());
        write(
            w,
            json!({"id": "claudeAccountRemove", "ok": false,
                   "error": {"code": "bad-payload", "message": "그런 계정이 없다"}}),
        );
    });
    let e = Conn::open(d.p(), Duration::from_secs(5))
        .and_then(|mut c| c.call("claudeAccountRemove", json!({"pool": "p", "account": "a"})))
        .unwrap_err();
    assert_eq!(e, "그런 계정이 없다");
    let seen = srv.join().unwrap();
    assert_eq!(seen[1]["payload"], json!({"pool": "p", "account": "a"}));
}

/// 주소는 출력에만 실리고, 코드는 소켓에만 간다. 시작 답보다 먼저 온 주소 이벤트도 놓치지 않는다.
#[test]
fn login_shows_url_sends_code_and_reports_done() {
    let d = Dir::new();
    let srv = fake_operator(d.p(), |r, w, seen| {
        seen.push(read(r).unwrap());
        // 남의 로그인 이벤트와, 시작 답보다 앞선 우리 주소.
        write(
            w,
            event(json!({"loginId": "other", "url": "https://other.example.com/x"})),
        );
        write(w, event(json!({"loginId": "L1", "url": LOGIN_URL})));
        write(
            w,
            json!({"id": "start", "ok": true, "payload": {"loginId": "L1"}}),
        );
        seen.push(read(r).unwrap());
        write(w, json!({"id": "submit", "ok": true, "payload": {}}));
        write(
            w,
            event(json!({"loginId": "L1", "done": true,
                         "status": {"loggedIn": true, "email": "a@example.com"}})),
        );
        // 닫지 않고 상대가 끝내기를 기다린다.
        let _ = read(r);
    });
    let (code, line, out) = login(
        d.p(),
        true,
        Msg::Stdin(Some("  C0DE#state \n".into())),
        quick(),
    );
    assert_eq!(
        (code, line.as_str()),
        (0, "로그인됐다: main/work (a@example.com)")
    );
    assert!(out.contains(LOGIN_URL));
    assert!(
        !out.contains("other.example.com"),
        "남의 로그인 주소는 찍지 않는다"
    );
    assert!(!out.contains("C0DE"), "코드를 되찍지 않는다");
    let seen = srv.join().unwrap();
    assert_eq!(
        seen[1],
        json!({"id": "start", "type": "claudeAccountLoginStart",
               "payload": {"pool": "main", "account": "work", "reauth": true}})
    );
    assert_eq!(
        seen[2],
        json!({"id": "submit", "type": "claudeAccountLoginSubmit",
               "payload": {"loginId": "L1", "code": "C0DE#state"}})
    );
}

/// 입력 끝·Ctrl-C·시한은 로그인을 취소하고 끝낸다 — 오퍼레이터에 로그인 자식을 남기지 않는다.
#[test]
fn login_cancels_on_eof_interrupt_and_timeout() {
    let slow = LoginTimeouts {
        code: Duration::from_millis(300),
        ..quick()
    };
    for (input, t, want_code, want) in [
        (Msg::Stdin(None), quick(), 1, "입력이 끝났다"),
        (Msg::Interrupt, quick(), 130, "취소했다"),
        // 빈 줄은 코드가 아니다 — 다시 묻고, 끝내 안 오면 시한.
        (Msg::Stdin(Some("\n".into())), slow, 1, "시한이 지났다"),
    ] {
        let d = Dir::new();
        let srv = fake_operator(d.p(), |r, w, seen| {
            seen.push(read(r).unwrap());
            write(
                w,
                json!({"id": "start", "ok": true, "payload": {"loginId": "L2"}}),
            );
            write(w, event(json!({"loginId": "L2", "url": LOGIN_URL})));
            seen.push(read(r).unwrap());
        });
        let (code, line, _) = login(d.p(), false, input, t);
        assert_eq!(code, want_code, "{line}");
        assert!(line.contains(want), "{line}");
        assert!(
            !line.contains("login.example.com"),
            "끝 줄에 주소를 싣지 않는다"
        );
        let seen = srv.join().unwrap();
        assert_eq!(
            seen[1]["payload"],
            json!({"pool": "main", "account": "work"})
        );
        assert_eq!(
            seen[2],
            json!({"id": "cancel", "type": "claudeAccountLoginCancel", "payload": {"loginId": "L2"}})
        );
    }
}

#[test]
fn login_reports_refusal_and_failed_end() {
    // 시작 거절.
    let d = Dir::new();
    let srv = fake_operator(d.p(), |r, w, seen| {
        seen.push(read(r).unwrap());
        write(
            w,
            json!({"id": "start", "ok": false,
                   "error": {"code": "bad-payload", "message": "이 계정에 로그인이 이미 진행 중이다: main/work"}}),
        );
    });
    let (code, line, out) = login(d.p(), false, Msg::Interrupt, quick());
    assert_eq!(code, 1);
    assert!(line.contains("이미 진행 중"));
    assert!(out.is_empty());
    srv.join().unwrap();
    // 코드 없이 끝난 로그인(자식이 죽음)은 그 사유로 실패.
    let d = Dir::new();
    let srv = fake_operator(d.p(), |r, w, seen| {
        seen.push(read(r).unwrap());
        write(
            w,
            json!({"id": "start", "ok": true, "payload": {"loginId": "L3"}}),
        );
        write(
            w,
            event(
                json!({"loginId": "L3", "done": true, "status": {"loggedIn": false},
                         "error": "로그인이 끝나지 않았다 (종료 코드 1) — 다시 시도해라"}),
            ),
        );
        let _ = read(r);
    });
    let (code, line, _) = login(d.p(), false, Msg::Interrupt, quick());
    assert_eq!(code, 1);
    assert!(line.contains("종료 코드 1"));
    srv.join().unwrap();
}

#[test]
fn main_reports_usage_missing_home_and_not_running() {
    let none = |_: &str| None;
    let run = |argv: &[&str], input: &str| {
        let (mut out, mut err) = (Vec::new(), Vec::new());
        let code = account_main(
            &s(argv),
            &none,
            Box::new(std::io::Cursor::new(input.as_bytes().to_vec())),
            &mut out,
            &mut err,
        );
        (
            code,
            String::from_utf8(out).unwrap(),
            String::from_utf8(err).unwrap(),
        )
    };
    let (code, _, err) = run(&["list"], "");
    assert_eq!(code, 2);
    assert!(err.contains("--base-url 이 없다"));
    assert_eq!(run(&["list", "--base-url", URL], "").0, 2, "HOME 을 모른다");
    let d = Dir::new();
    let (code, out, err) = run(&["list", "--base-url", URL, "--home", d.p()], "");
    assert_eq!((code, out.as_str()), (1, ""));
    assert_eq!(err.trim_end(), NOT_RUNNING);
    // 읽기만 했다 — 없는 홈에 아무것도 만들지 않는다.
    assert_eq!(std::fs::read_dir(d.p()).unwrap().count(), 0);
}

/// `remove` 는 `--yes` 가 없으면 묻고, y 가 아니면 요청을 보내지 않는다.
#[test]
fn remove_asks_first() {
    let d = Dir::new();
    let app = format!("{}/app", d.p());
    let root = register_root(d.p(), URL, &app).unwrap();
    let none = |_: &str| None;
    let argv = s(&[
        "remove",
        "main",
        "work",
        "--base-url",
        URL,
        "--home",
        d.p(),
        "--app-data",
        &app,
    ]);
    for (answer, want_code) in [("n\n", 1), ("y\n", 0)] {
        let srv = fake_operator(&root, |r, w, seen| {
            if let Some(v) = read(r) {
                seen.push(v);
                write(
                    w,
                    json!({"id": "claudeAccountRemove", "ok": true, "payload": {}}),
                );
            }
        });
        let (mut out, mut err) = (Vec::new(), Vec::new());
        let code = account_main(
            &argv,
            &none,
            Box::new(std::io::Cursor::new(answer.as_bytes().to_vec())),
            &mut out,
            &mut err,
        );
        assert_eq!(code, want_code);
        let seen = srv.join().unwrap();
        assert_eq!(seen.len(), if want_code == 0 { 2 } else { 1 }, "{answer}");
        let paths = daemon_endpoint_paths(&root);
        std::fs::remove_file(&paths.socket_path).unwrap();
    }
}
