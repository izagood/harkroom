//! A2 소켓 서버를 실제 바이너리로 띄워 본다 — 커뮤니티 둘이면 오퍼레이터 둘이 각자 뿌리에서 함께 뜨고,
//! 같은 커뮤니티로 하나 더 띄우면 점유를 보고 물러나며, 죽은 오퍼레이터의 잔해 소켓은 치우고 잡는다.
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};

static SEQ: AtomicU32 = AtomicU32::new(0);

/// macOS 의 `$TMPDIR` 는 길어 소켓 경로 상한(100바이트)을 넘는다 — `/tmp` 아래 짧은 집을 쓴다.
fn short_home() -> String {
    let h = format!(
        "/tmp/hkop-{}-{}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::SeqCst)
    );
    let _ = std::fs::remove_dir_all(&h);
    std::fs::create_dir_all(&h).unwrap();
    h
}

struct Op {
    child: Child,
    first: Value,
}
impl Drop for Op {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn spawn(home: &str, base: &str) -> Op {
    spawn_with(home, base, &[])
}

fn spawn_with(home: &str, base: &str, extra: &[&str]) -> Op {
    let mut child = Command::new(env!("CARGO_BIN_EXE_harkroom-operator-rs"))
        .args(["serve", "--base-url", base, "--home", home])
        .args(extra)
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    Op {
        child,
        first: serde_json::from_str(line.trim()).unwrap(),
    }
}

struct Client {
    w: UnixStream,
    r: BufReader<UnixStream>,
}
impl Client {
    fn connect(sock: &str) -> Self {
        let w = UnixStream::connect(sock).unwrap();
        let r = BufReader::new(w.try_clone().unwrap());
        Self { w, r }
    }
    fn send(&mut self, v: &Value) {
        self.w.write_all(format!("{v}\n").as_bytes()).unwrap();
    }
    fn recv(&mut self) -> Option<Value> {
        let mut line = String::new();
        if self.r.read_line(&mut line).unwrap_or(0) == 0 {
            return None;
        }
        Some(serde_json::from_str(line.trim()).unwrap())
    }
    fn token_for(sock: &str) -> String {
        std::fs::read_to_string(sock.replace(".sock", ".token")).unwrap()
    }
}

fn hello(token: &str) -> Value {
    json!({"type":"hello","version":1,"token":token,"role":"app"})
}

#[test]
fn two_communities_two_operators_hello_ping_list() {
    let home = short_home();
    let a = spawn(&home, "https://a.example.com/");
    let b = spawn(&home, "https://b.example.com");
    assert_eq!(a.first["ok"], true, "{}", a.first);
    assert_eq!(b.first["ok"], true, "{}", b.first);
    let (sa, sb) = (
        a.first["listening"].as_str().unwrap(),
        b.first["listening"].as_str().unwrap(),
    );
    assert_ne!(sa, sb);
    assert_ne!(a.first["pid"], b.first["pid"]);
    for (sock, op) in [(sa, &a), (sb, &b)] {
        // 파일 권한: 소켓·토큰 0600, 디렉터리 0700.
        let mode = |p: &str| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(sock), 0o600);
        assert_eq!(mode(&sock.replace(".sock", ".token")), 0o600);
        assert_eq!(mode(&sock.replace("/operator-v1.sock", "")), 0o700);
        let pid: Value =
            serde_json::from_str(&std::fs::read_to_string(sock.replace(".sock", ".pid")).unwrap())
                .unwrap();
        assert_eq!(pid["pid"], op.first["pid"]);

        let mut c = Client::connect(sock);
        c.send(&hello(&Client::token_for(sock)));
        let h = c.recv().unwrap();
        assert_eq!(h["type"], "hello");
        assert_eq!(h["ok"], true);
        assert_eq!(h["daemon"]["pid"], op.first["pid"]);
        assert_eq!(h["daemon"]["launchNonce"], pid["launchNonce"]);
        // 두 요청을 한 줄 묶음으로 보내도 둘 다 답한다.
        c.w.write_all(
            b"{\"id\":\"1\",\"type\":\"ping\"}\n{\"id\":\"2\",\"type\":\"listRunners\"}\n",
        )
        .unwrap();
        let p = c.recv().unwrap();
        assert_eq!(
            (p["id"].as_str(), p["ok"].as_bool()),
            (Some("1"), Some(true))
        );
        assert!(p["payload"]["nowMs"].as_i64().unwrap() > 0);
        assert_eq!(
            c.recv().unwrap(),
            json!({"id":"2","ok":true,"payload":{"runners":[]}})
        );
        c.send(&json!({"id":"3","type":"nope"}));
        assert_eq!(c.recv().unwrap()["error"]["code"], "unknown-request");
        c.send(&json!({"id":"4","type":"spawnRunner","payload":{}}));
        assert_eq!(c.recv().unwrap()["error"]["code"], "bad-payload");
        // 러너 프로그램이 정해지지 않은 오퍼레이터는 띄우지 않는다.
        c.send(&json!({"id":"5","type":"spawnRunner","payload":{"agentId":"x","env":{}}}));
        assert_eq!(c.recv().unwrap()["error"]["code"], "internal");
        c.send(&json!({"id":"6","type":"terminalInput","payload":{}}));
        assert_eq!(c.recv().unwrap()["error"]["code"], "internal");
    }
    // 서로의 토큰으로는 안 붙는다.
    let mut c = Client::connect(sa);
    c.send(&hello(&Client::token_for(sb)));
    assert_eq!(c.recv().unwrap()["error"]["code"], "unauthorized");
    assert!(c.recv().is_none(), "거절 뒤에는 끊는다");
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn hello_gate_rejects_and_drops() {
    let home = short_home();
    let a = spawn(&home, "https://gate.example.com");
    let sock = a.first["listening"].as_str().unwrap().to_string();
    let mut c = Client::connect(&sock);
    c.send(&json!({"id":"1","type":"ping"}));
    let r = c.recv().unwrap();
    assert_eq!(
        (r["type"].as_str(), r["error"]["code"].as_str()),
        (Some("hello"), Some("not-authenticated"))
    );
    assert!(c.recv().is_none());
    let mut c = Client::connect(&sock);
    c.send(&json!({"type":"hello","version":2,"token":Client::token_for(&sock),"role":"app"}));
    assert_eq!(c.recv().unwrap()["error"]["code"], "version-mismatch");
    // 상한을 넘긴 줄은 오류 한 줄 뒤 끊는다.
    let mut c = Client::connect(&sock);
    c.send(&hello(&Client::token_for(&sock)));
    c.recv().unwrap();
    let big = vec![b'x'; 1024 * 1024 + 10];
    let _ = c.w.write_all(&big);
    assert_eq!(c.recv().unwrap()["error"]["code"], "line-too-long");
    assert!(c.recv().is_none());
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn same_community_second_operator_backs_off_and_stale_socket_is_reclaimed() {
    let home = short_home();
    let a = spawn(&home, "https://same.example.com");
    let sock = a.first["listening"].as_str().unwrap().to_string();
    let mut b = Command::new(env!("CARGO_BIN_EXE_harkroom-operator-rs"))
        .args([
            "serve",
            "--base-url",
            "https://same.example.com/",
            "--home",
            &home,
        ])
        .output()
        .unwrap();
    assert_eq!(b.status.code(), Some(1));
    let out: Value = serde_json::from_slice(&std::mem::take(&mut b.stdout)).unwrap();
    assert_eq!(out["occupied"], sock.as_str());
    // 처음 것은 그대로 서비스한다.
    let mut c = Client::connect(&sock);
    c.send(&hello(&Client::token_for(&sock)));
    assert_eq!(c.recv().unwrap()["ok"], true);
    drop(c);
    // SIGKILL — 소켓 파일이 잔해로 남는다.
    drop(a);
    assert!(std::path::Path::new(&sock).exists());
    let c2 = spawn(&home, "https://same.example.com");
    assert_eq!(c2.first["ok"], true, "{}", c2.first);
    assert_eq!(c2.first["listening"], sock.as_str());
    let mut c = Client::connect(&sock);
    c.send(&hello(&Client::token_for(&sock)));
    assert_eq!(c.recv().unwrap()["daemon"]["pid"], c2.first["pid"]);
    let _ = std::fs::remove_dir_all(&home);
}

/// A3b — 러너 표: spawn → 중복 없음 → list → kill(SIGTERM) → `runnerExit` 이벤트는 인증된 접속에만, 세대가 실려 온다.
#[test]
fn runner_table_spawn_kill_and_exit_event() {
    let home = short_home();
    let runner = format!("{home}/runner.sh");
    std::fs::write(
        &runner,
        "#!/bin/sh\nif [ \"$HK_MODE\" = quick ]; then exit 3; fi\nexec sleep 30\n",
    )
    .unwrap();
    std::fs::set_permissions(&runner, std::fs::Permissions::from_mode(0o755)).unwrap();
    let a = spawn_with(
        &home,
        "https://runner.example.com",
        &["--runner-command", &runner],
    );
    assert_eq!(a.first["ok"], true, "{}", a.first);
    let sock = a.first["listening"].as_str().unwrap().to_string();
    let token = Client::token_for(&sock);
    // 인증 안 한 접속 — 이벤트를 받으면 안 된다.
    let mut quiet = Client::connect(&sock);
    let mut c = Client::connect(&sock);
    c.send(&hello(&token));
    assert_eq!(c.recv().unwrap()["ok"], true);

    c.send(&json!({"id":"1","type":"spawnRunner","payload":{"agentId":"ag1","env":{"HK_MODE":"long"}}}));
    let s1 = c.recv().unwrap();
    assert_eq!(s1["ok"], true, "{s1}");
    let pid = s1["payload"]["pid"].as_i64().unwrap();
    let inc = s1["payload"]["incarnationId"].as_str().unwrap().to_string();
    c.send(&json!({"id":"2","type":"spawnRunner","payload":{"agentId":"ag1","env":{}}}));
    let s2 = c.recv().unwrap();
    assert_eq!(s2["payload"], s1["payload"], "살아 있으면 새로 안 띄운다");
    c.send(&json!({"id":"3","type":"listRunners"}));
    let l = c.recv().unwrap();
    let rows = l["payload"]["runners"].as_array().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(
        (
            rows[0]["pid"].as_i64(),
            rows[0]["alive"].as_bool(),
            rows[0]["adopted"].as_bool()
        ),
        (Some(pid), Some(true), Some(false))
    );
    // 세대가 어긋난 kill 은 없는 러너와 같다.
    c.send(
        &json!({"id":"4","type":"killRunner","payload":{"agentId":"ag1","incarnationId":"old"}}),
    );
    assert_eq!(c.recv().unwrap()["error"]["code"], "no-such-runner");
    c.send(&json!({"id":"5","type":"killRunner","payload":{"agentId":"ag1","incarnationId":inc}}));
    let k = c.recv().unwrap();
    assert_eq!(k["payload"]["pid"].as_i64(), Some(pid));
    assert!(k["payload"]["termSentAtMs"].as_i64().unwrap() > 0);
    let ev = c.recv().unwrap();
    assert_eq!(
        ev,
        json!({"type":"event","event":"runnerExit","payload":{
            "agentId":"ag1","incarnationId":inc,"code":null,"signal":"SIGTERM","tailLines":[]}})
    );
    // 종료 코드가 실린다. 표에서 빠진다.
    c.send(&json!({"id":"6","type":"spawnRunner","payload":{"agentId":"ag2","env":{"HK_MODE":"quick"}}}));
    let s3 = c.recv().unwrap();
    assert_eq!(s3["ok"], true);
    let ev = c.recv().unwrap();
    assert_eq!(ev["payload"]["code"], 3);
    assert_eq!(
        ev["payload"]["incarnationId"],
        s3["payload"]["incarnationId"]
    );
    c.send(&json!({"id":"7","type":"listRunners"}));
    assert_eq!(c.recv().unwrap()["payload"]["runners"], json!([]));
    // 인증 안 한 접속은 이벤트를 하나도 못 받았다 — 첫 줄을 보내면 hello 거절이 첫 응답이다.
    quiet.send(&json!({"id":"1","type":"ping"}));
    assert_eq!(quiet.recv().unwrap()["type"], "hello");
    let _ = std::fs::remove_dir_all(&home);
}

/// A3b — `--app-data` 의 `operators.json` 에 적힌 자리를 계산한 자리보다 먼저 쓴다. 깨진 색인이면 뜨지 않는다.
#[test]
fn operators_index_root_wins_and_broken_index_refuses() {
    let home = short_home();
    let app = format!("{home}/app");
    std::fs::create_dir_all(&app).unwrap();
    let legacy = format!("{home}/legacy");
    std::fs::write(
        format!("{app}/operators.json"),
        json!({"version":1,"communities":{"https://idx.example.com/":{"root":legacy,"legacy":true}}}).to_string(),
    )
    .unwrap();
    let a = spawn_with(&home, "https://idx.example.com", &["--app-data", &app]);
    assert_eq!(a.first["ok"], true, "{}", a.first);
    assert_eq!(a.first["root"], legacy.as_str());
    assert_eq!(
        a.first["listening"],
        format!("{legacy}/operator/operator-v1.sock").as_str()
    );
    drop(a);
    std::fs::write(
        format!("{app}/operators.json"),
        r#"{"version":1,"communities":[]}"#,
    )
    .unwrap();
    let out = Command::new(env!("CARGO_BIN_EXE_harkroom-operator-rs"))
        .args([
            "serve",
            "--base-url",
            "https://idx.example.com",
            "--home",
            &home,
            "--app-data",
            &app,
        ])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1));
    let v: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert!(
        v["error"].as_str().unwrap().contains("모양이 다르다"),
        "{v}"
    );
    let _ = std::fs::remove_dir_all(&home);
}

/// A4②: 앱이 준 `--app-version`·`--launch-nonce` 가 pid 레코드에 실린다. 안 실리면 앱은 crate 판(0.1.0)을 자기보다
/// 낮다고 보고 띄울 때마다 물린다(`should_retire_daemon`).
#[test]
fn app_version_and_nonce_from_app_land_in_pid_record() {
    let home = short_home();
    let op = spawn_with(
        &home,
        "https://v.example.com",
        &["--app-version", "9.8.7", "--launch-nonce", "nonce-a4b"],
    );
    assert_eq!(op.first["ok"], true, "{}", op.first);
    let sock = op.first["listening"].as_str().unwrap();
    let pid: Value =
        serde_json::from_str(&std::fs::read_to_string(sock.replace(".sock", ".pid")).unwrap())
            .unwrap();
    assert_eq!(pid["appVersion"], "9.8.7", "{pid}");
    assert_eq!(pid["launchNonce"], "nonce-a4b", "{pid}");
}
