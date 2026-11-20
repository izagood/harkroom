//! `harkroom-operator-rs register <baseUrl> <code> [--name <이름>] [--home <dir>] [--app-data <dir>]` — 사람이 터미널에서
//! 등록 코드(설정 › Operators 가 발급, 5분·1회)를 이 머신의 오퍼레이터 등록으로 바꾼다(P1a, Node 오퍼레이터 걷기 앞 단계).
//!
//! 정본은 TS 옛 Node 오퍼레이터(P3 에서 지움)의 `src/cli.ts`(`parseCliArgs` 의 `register`·`register`·`registerViaRunningOperator`)와
//! `main.ts` 의 `register` 갈래다.
//!
//! TS 와 같은 것:
//! - 인자 꼴(`register <baseUrl> <code> [--name n]`)과 검사(http(s) URL 만, 끝 `/` 를 걷는다). 설정 › Operators 가 보여 주는
//!   명령이 이 꼴이다.
//! - **도는 오퍼레이터가 있으면 그쪽에 시킨다**(`operatorRegister`) — 그쪽이 claim 하고 곧바로 서버에 붙는다. 소켓·토큰이 없거나
//!   hello 가 거절되면 파일 길로 간다(`register`: claim → 토큰 → `operator.json` 의 `operatorId`). 도는 쪽이 **요청을** 거절하면
//!   그 사유로 끝낸다(파일 길로 다시 가지 않는다 — 코드는 1회용이다).
//! - 앱 데이터 자리: `HARKROOM_DATA_DIR`, 없으면 플랫폼 기본(`app.harkroom.desktop`).
//!
//! TS 와 다른 것(Rust 오퍼레이터의 자리 규칙 때문):
//! - 파일을 쓰는 자리는 앱 데이터 폴더가 아니라 **그 커뮤니티의 뿌리**다(`resolve_community_root`, 색인 `operators.json` 을
//!   먼저 본다). Rust 오퍼레이터(`serve`)가 읽는 자리가 거기다. `--home`·`--app-data` 는 `serve` 와 같은 뜻이다.
use crate::forward::Transport;
use crate::index::read_roots_index;
use crate::local_agents::LocalAgents;
use crate::local_register::{RegisterInput, claim_transport, register};
use harkroom_roots::{
    COMMUNITY_ROOT_HASH_LENGTH, CommunityRootResolution, DAEMON_PROTOCOL_VERSION,
    OperatorRootsIndex, community_root_key, computed_community_root, daemon_endpoint_paths,
    resolve_community_root, same_root,
};
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::Duration;

/// TS `APP_IDENTIFIER` — Tauri `identifier` 와 같다.
pub const APP_IDENTIFIER: &str = "app.harkroom.desktop";

pub const USAGE: &str = "사용법: harkroom-operator-rs register <baseUrl> <code> [--name <이름>]";

/// 도는 오퍼레이터 답을 기다리는 시한. 그쪽이 claim(30초)을 하므로 그보다 넉넉히 둔다.
pub const LIVE_TIMEOUT: Duration = Duration::from_secs(45);

#[derive(Clone, PartialEq, Eq)]
pub struct RegisterArgs {
    pub base_url: String,
    pub code: String,
    pub name: Option<String>,
    pub home: Option<String>,
    pub app_data: Option<String>,
}

impl std::fmt::Debug for RegisterArgs {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RegisterArgs")
            .field("base_url", &self.base_url)
            .field("code", &"<redacted>")
            .field("name", &self.name)
            .field("home", &self.home)
            .field("app_data", &self.app_data)
            .finish()
    }
}

/// TS `flagValue` — 플래그가 있는데 값이 없으면 오류.
fn flag(argv: &[String], name: &str) -> Result<Option<String>, String> {
    match argv.iter().position(|a| a == name) {
        None => Ok(None),
        Some(i) => argv
            .get(i + 1)
            .cloned()
            .map(Some)
            .ok_or_else(|| format!("{name} 에 값이 없다")),
    }
}

/// http(s) URL 인가 — TS `new URL` + `^https?:$` 검사. 호스트가 비면 URL 이 아니다.
fn check_url(raw: &str) -> Result<(), String> {
    let lower = raw.to_ascii_lowercase();
    let rest = if let Some(r) = lower.strip_prefix("https://") {
        r
    } else if let Some(r) = lower.strip_prefix("http://") {
        r
    } else if lower.contains("://") || lower.contains(':') && !lower.starts_with('/') {
        return Err(format!("baseUrl 은 http(s) 여야 한다: {raw}"));
    } else {
        return Err(format!("baseUrl 이 URL 이 아니다: {raw}"));
    };
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    if host.is_empty() || host.chars().any(char::is_whitespace) {
        return Err(format!("baseUrl 이 URL 이 아니다: {raw}"));
    }
    Ok(())
}

/// `register` 뒤의 인자(`argv[0]` 은 baseUrl). TS `parseCliArgs` 의 `register` 갈래.
pub fn parse_register_args(argv: &[String]) -> Result<RegisterArgs, String> {
    let (Some(base), Some(code)) = (argv.first(), argv.get(1)) else {
        return Err(USAGE.to_string());
    };
    if base.is_empty() || code.is_empty() || base.starts_with("--") || code.starts_with("--") {
        return Err(USAGE.to_string());
    }
    check_url(base)?;
    let rest = &argv[2..];
    Ok(RegisterArgs {
        base_url: community_root_key(base).to_string(),
        code: code.clone(),
        // TS 는 `cmd.name` 이 빈 문자열이면 싣지 않는다. 공백만이면 소켓 쪽 판독(`read_register_payload`)과 같이 걷는다.
        name: flag(rest, "--name")?
            .map(|n| {
                n.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
                    .to_string()
            })
            .filter(|n| !n.is_empty()),
        home: flag(rest, "--home")?,
        app_data: flag(rest, "--app-data")?,
    })
}

/// TS `defaultDataDir` — 앱이 쓰는 데이터 디렉터리(Tauri `app_data_dir`).
pub fn default_app_data(env: &dyn Fn(&str) -> Option<String>, home: &str) -> String {
    if let Some(d) = env("HARKROOM_DATA_DIR").filter(|d| !d.is_empty()) {
        return d;
    }
    let home = Path::new(home);
    let dir = if cfg!(target_os = "macos") {
        home.join("Library").join("Application Support")
    } else {
        env("XDG_DATA_HOME")
            .filter(|d| !d.is_empty())
            .map(Into::into)
            .unwrap_or_else(|| home.join(".local").join("share"))
    };
    dir.join(APP_IDENTIFIER).to_string_lossy().into_owned()
}

/// 이 커뮤니티의 뿌리 — `serve` 와 같은 규칙(색인이 있으면 색인, 깨졌으면 거절).
pub fn register_root(home: &str, base_url: &str, app_data: &str) -> Result<String, String> {
    let index = if Path::new(app_data).exists() {
        read_roots_index(app_data)?
    } else {
        OperatorRootsIndex::default()
    };
    match resolve_community_root(home, base_url, &index) {
        CommunityRootResolution::Ok { root, .. } => Ok(root),
        CommunityRootResolution::Refused(r) => Err(format!(
            "이 커뮤니티의 뿌리를 정하지 못했다: {}",
            serde_json::to_string(&r).unwrap_or_default()
        )),
    }
}

/// 도는 오퍼레이터에 `operatorRegister` 를 시킨다(TS `registerViaRunningOperator`).
/// - `Ok(None)`: 도는 오퍼레이터가 없다(토큰 파일 없음·접속 실패·hello 거절) — 호출자가 파일 길로 간다.
/// - `Err`: 도는 오퍼레이터가 요청을 거절했다 — 그 사유로 끝낸다.
pub fn register_via_running_operator(
    root: &str,
    input: &RegisterInput,
    timeout: Duration,
) -> Result<Option<Value>, String> {
    let paths = daemon_endpoint_paths(root);
    let Ok(token) = std::fs::read_to_string(&paths.token_path) else {
        return Ok(None);
    };
    let Ok(sock) = UnixStream::connect(&paths.socket_path) else {
        return Ok(None);
    };
    let _ = sock.set_read_timeout(Some(timeout));
    let mut writer = match sock.try_clone() {
        Ok(w) => w,
        Err(_) => return Ok(None),
    };
    let hello = json!({ "type": "hello", "version": DAEMON_PROTOCOL_VERSION, "token": token.trim(), "role": "app" });
    if writer.write_all(format!("{hello}\n").as_bytes()).is_err() {
        return Ok(None);
    }
    let mut reader = BufReader::new(sock);
    let mut next = || -> Option<Value> {
        let mut buf = String::new();
        loop {
            buf.clear();
            match reader.read_line(&mut buf) {
                Ok(0) | Err(_) => return None,
                Ok(_) => {}
            }
            // 깨진 줄은 건너뛴다(TS `if (!line.ok) continue`).
            if let Ok(v) = serde_json::from_str::<Value>(buf.trim_end()) {
                return Some(v);
            }
        }
    };
    // hello 답. 끊김·거절이면 도는 오퍼레이터가 없는 것으로 친다(TS `resolve(null)`).
    match next() {
        Some(v) if v.get("ok") == Some(&Value::Bool(true)) => {}
        _ => return Ok(None),
    }
    let mut payload = json!({ "baseUrl": input.base_url, "code": input.code });
    if let Some(n) = &input.name {
        payload["name"] = Value::String(n.clone());
    }
    let req = json!({ "id": "register", "type": "operatorRegister", "payload": payload });
    writer
        .write_all(format!("{req}\n").as_bytes())
        .map_err(|e| format!("오퍼레이터에 등록을 보내지 못했다: {e}"))?;
    // 우리 요청의 답만 본다 — 그 사이 앱 연결로 오는 알림 줄은 건너뛴다.
    loop {
        let Some(msg) = next() else {
            return Err("오퍼레이터가 등록에 답하지 않고 끊었다".to_string());
        };
        if msg.get("id").and_then(Value::as_str) != Some("register") {
            continue;
        }
        if msg.get("ok") == Some(&Value::Bool(true)) {
            return Ok(Some(msg.get("payload").cloned().unwrap_or(Value::Null)));
        }
        return Err(msg
            .pointer("/error/message")
            .and_then(Value::as_str)
            .unwrap_or("오퍼레이터가 등록을 거절했다")
            .to_string());
    }
}

/// 등록 한 번의 결과.
#[derive(Debug, PartialEq)]
pub struct Registered {
    pub out: Value,
    /// 도는 오퍼레이터가 맡았나.
    pub live: bool,
    pub root: String,
}

/// 뿌리를 정하고 → 도는 오퍼레이터 → 없으면 파일. `transport`·`hostname` 은 파일 길에서만 쓴다.
pub fn run_register(
    args: &RegisterArgs,
    home: &str,
    app_data: &str,
    transport: &dyn Transport,
    hostname: &dyn Fn() -> String,
    live_timeout: Duration,
) -> Result<Registered, String> {
    let root = register_root(home, &args.base_url, app_data)?;
    let input = RegisterInput {
        base_url: args.base_url.clone(),
        code: args.code.clone(),
        name: args.name.clone(),
    };
    if let Some(out) = register_via_running_operator(&root, &input, live_timeout)? {
        return Ok(Registered {
            out,
            live: true,
            root,
        });
    }
    let local = LocalAgents::new(&root, &args.base_url);
    let out = register(&local, transport, &input, hostname).map_err(|e| e.message)?;
    Ok(Registered {
        out,
        live: false,
        root,
    })
}

/// Node 러너 사이드카 이름 — Rust 오퍼레이터는 이것을 `--runner-command` 로 받는다. 앱 번들에는 없다(옆에 있을 때만 쓴다).
pub const RUNNER_SIDECAR_NAME: &str = "harkroom-runner";

/// 앱 없이 이 커뮤니티의 오퍼레이터를 띄울 명령(P1b 안 A — `run` 대신 커뮤니티마다 `serve` 하나).
/// - 뿌리가 계산한 자리가 아니면(색인 `operators.json` 이 정한 자리) `--app-data` 를 붙인다 — 없으면 `serve` 가 다른 뿌리를 본다.
/// - node 러너 사이드카가 옆에 있으면 `--runner-command` 를 붙인다 — 없으면(앱 번들) `serve` 는 옆의 Rust 러너만 띄운다.
pub fn serve_command(
    bin: &str,
    runner: Option<&str>,
    base_url: &str,
    root: &str,
    home: &str,
    app_data: &str,
) -> String {
    let key = community_root_key(base_url);
    let mut cmd = format!("{} serve --base-url {}", shell_quote(bin), shell_quote(key));
    if !same_root(
        root,
        &computed_community_root(home, key, COMMUNITY_ROOT_HASH_LENGTH),
    ) {
        cmd.push_str(&format!(" --app-data {}", shell_quote(app_data)));
    }
    if let Some(r) = runner {
        cmd.push_str(&format!(" --runner-command {}", shell_quote(r)));
    }
    cmd
}

/// 안내 줄을 그대로 붙여 넣어도 낱말이 갈리지 않게 한다(security #2272 권고). macOS 옛 자리
/// (`~/Library/Application Support/…`)처럼 공백이 있으면 인자가 둘로 갈려 `serve` 가 실패했다.
/// 셸이 특별히 읽지 않는 글자만 있으면 그대로 두고, 아니면 작은따옴표로 감싼다(안의 `'` 는 `'\''`).
fn shell_quote(arg: &str) -> String {
    let plain = !arg.is_empty()
        && arg
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_@%+=:,./-".contains(&b));
    if plain {
        arg.to_string()
    } else {
        format!("'{}'", arg.replace('\'', "'\\''"))
    }
}

/// 사람에게 보일 줄(TS `main.ts` 의 두 줄). 도는 오퍼레이터가 없었으면 `serve` 명령을 함께 보인다(TS 는 `run` 이었다).
pub fn success_lines(r: &Registered, serve_cmd: &str) -> String {
    let s = |k: &str| r.out.get(k).and_then(Value::as_str).unwrap_or("");
    let config = Path::new(&r.root).join("operator").join("operator.json");
    let head = format!(
        "등록됐다: {} ({}) @ {} — 설정: {}",
        s("name"),
        s("operatorId"),
        s("baseUrl"),
        config.display()
    );
    if r.live {
        return format!(
            "{head}\n도는 오퍼레이터가 방금 그 커뮤니티에 붙었다. 이제 설정 › 에이전트 상세에서 이 오퍼레이터를 배정하면 러너가 뜬다."
        );
    }
    let runner_note = if serve_cmd.contains(" --runner-command ") {
        ""
    } else {
        "\n러너는 이 실행 파일 옆의 harkroom-runner-rs 로 뜬다(그 파일이 없으면 배정이 와도 러너를 못 띄운다)."
    };
    format!(
        "{head}\n이 커뮤니티의 오퍼레이터가 떠 있지 않다. 앱을 열거나, 앱 없이 두려면 이 명령을 띄운다(상주는 ops/operator.*.template):\n  {serve_cmd}{runner_note}\n그다음 설정 › 에이전트 상세에서 이 오퍼레이터를 배정하면 러너가 뜬다."
    )
}

/// 이 실행 파일과 그 옆의 러너 사이드카(있을 때만).
fn self_and_runner() -> (String, Option<String>) {
    let Ok(exe) = std::env::current_exe() else {
        return ("harkroom-operator-rs".to_string(), None);
    };
    let runner = exe
        .parent()
        .map(|d| d.join(RUNNER_SIDECAR_NAME))
        .filter(|p| p.is_file())
        .map(|p| p.to_string_lossy().into_owned());
    (exe.to_string_lossy().into_owned(), runner)
}

/// `register` 진입점. (stdout 글, stderr 글, 종료 코드).
pub fn register_main(
    argv: &[String],
    env: &dyn Fn(&str) -> Option<String>,
) -> (String, String, i32) {
    let args = match parse_register_args(argv) {
        Ok(a) => a,
        Err(e) => return (String::new(), e, 2),
    };
    let Some(home) = args.home.clone().or_else(|| env("HOME")) else {
        return (String::new(), "HOME 을 모른다".to_string(), 2);
    };
    let app_data = args
        .app_data
        .clone()
        .unwrap_or_else(|| default_app_data(env, &home));
    match run_register(
        &args,
        &home,
        &app_data,
        &claim_transport(),
        &crate::local_merge::hostname,
        LIVE_TIMEOUT,
    ) {
        Ok(r) => {
            let (bin, runner) = self_and_runner();
            let cmd = serve_command(
                &bin,
                runner.as_deref(),
                &args.base_url,
                &r.root,
                &home,
                &app_data,
            );
            (success_lines(&r, &cmd), String::new(), 0)
        }
        Err(e) => (String::new(), e, 1),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::forward::HttpReply;
    use std::os::unix::net::UnixListener;
    use std::sync::Mutex;

    const URL: &str = "http://c.example.com";

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
            // 소켓 경로 상한(100바이트) 안에 들게 /tmp 아래 짧게 둔다.
            let d = std::path::PathBuf::from(format!(
                "/tmp/hkrc-{}-{}",
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

    struct Fake {
        status: u16,
        body: String,
        calls: Mutex<Vec<Value>>,
    }
    impl Fake {
        fn ok() -> Fake {
            Fake {
                status: 201,
                body: json!({"operator": {"id": "op-1", "name": "mac"}, "token": "tok-1"})
                    .to_string(),
                calls: Mutex::new(Vec::new()),
            }
        }
    }
    impl Transport for Fake {
        fn send(
            &self,
            _m: &str,
            url: &str,
            _h: &[(String, String)],
            body: Option<Vec<u8>>,
        ) -> Result<HttpReply, String> {
            let b: Value = serde_json::from_slice(&body.unwrap_or_default()).unwrap();
            self.calls
                .lock()
                .unwrap()
                .push(json!({"url": url, "body": b}));
            Ok(HttpReply {
                status: self.status,
                content_type: "application/json".into(),
                body: self.body.clone(),
            })
        }
    }

    #[test]
    fn parse_matches_ts_cli() {
        let a = parse_register_args(&s(&["https://c.example.com//", "CODE", "--name", " mac "]))
            .unwrap();
        assert_eq!(a.base_url, "https://c.example.com");
        assert_eq!(a.code, "CODE");
        assert_eq!(a.name.as_deref(), Some("mac"));
        assert!(!format!("{a:?}").contains("CODE"), "Debug 는 코드를 숨긴다");
        let plain = parse_register_args(&s(&[URL, "C"])).unwrap();
        assert_eq!(plain.name, None);
        assert_eq!(parse_register_args(&s(&[URL])).unwrap_err(), USAGE);
        assert_eq!(parse_register_args(&s(&[])).unwrap_err(), USAGE);
        assert_eq!(
            parse_register_args(&s(&["ftp://x.example.com", "C"])).unwrap_err(),
            "baseUrl 은 http(s) 여야 한다: ftp://x.example.com"
        );
        assert_eq!(
            parse_register_args(&s(&["not a url", "C"])).unwrap_err(),
            "baseUrl 이 URL 이 아니다: not a url"
        );
        assert_eq!(
            parse_register_args(&s(&["https://", "C"])).unwrap_err(),
            "baseUrl 이 URL 이 아니다: https://"
        );
        assert_eq!(
            parse_register_args(&s(&[URL, "C", "--name"])).unwrap_err(),
            "--name 에 값이 없다"
        );
    }

    #[test]
    fn default_app_data_follows_ts() {
        let env = |k: &str| (k == "HARKROOM_DATA_DIR").then(|| "/x/data".to_string());
        assert_eq!(default_app_data(&env, "/h"), "/x/data");
        let none = |_: &str| None;
        let want = if cfg!(target_os = "macos") {
            "/h/Library/Application Support/app.harkroom.desktop"
        } else {
            "/h/.local/share/app.harkroom.desktop"
        };
        assert_eq!(default_app_data(&none, "/h"), want);
    }

    #[test]
    fn root_uses_index_like_serve() {
        let d = Dir::new();
        let app = format!("{}/app", d.p());
        // 색인이 없으면 계산한 자리.
        let computed = register_root(d.p(), URL, &app).unwrap();
        assert_eq!(
            computed,
            harkroom_roots::computed_community_root(d.p(), URL, 8)
        );
        // 색인이 있으면 그 자리.
        std::fs::create_dir_all(&app).unwrap();
        let legacy = format!("{}/legacy", d.p());
        std::fs::write(
            format!("{app}/operators.json"),
            json!({"version": 1, "communities": {URL: {"root": legacy}}}).to_string(),
        )
        .unwrap();
        assert_eq!(register_root(d.p(), URL, &app).unwrap(), legacy);
        // 깨진 색인은 거절(빈 색인으로 치지 않는다).
        std::fs::write(format!("{app}/operators.json"), "{").unwrap();
        assert!(register_root(d.p(), URL, &app).is_err());
    }

    /// 도는 오퍼레이터가 없으면 파일 길 — 토큰과 operator.json 이 **뿌리에** 생기고 Rust 오퍼레이터가 읽는다.
    #[test]
    fn no_running_operator_writes_root_files() {
        let d = Dir::new();
        let args = parse_register_args(&s(&[URL, "C0DE"])).unwrap();
        let fake = Fake::ok();
        let r = run_register(
            &args,
            d.p(),
            &format!("{}/app", d.p()),
            &fake,
            &|| "host".into(),
            Duration::from_secs(2),
        )
        .unwrap();
        assert!(!r.live);
        assert_eq!(
            r.out,
            json!({"operatorId": "op-1", "name": "mac", "baseUrl": URL, "replaced": null})
        );
        let calls = fake.calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0]["url"], format!("{URL}/operators/claim"));
        assert_eq!(calls[0]["body"], json!({"code": "C0DE", "name": "host"}));
        let local = LocalAgents::new(&r.root, URL);
        assert_eq!(local.operator_token().as_deref(), Some("tok-1"));
        assert_eq!(local.operator_id().as_deref(), Some("op-1"));
        let cmd = serve_command(
            "/b/op",
            None,
            URL,
            &r.root,
            d.p(),
            &format!("{}/app", d.p()),
        );
        assert_eq!(cmd, format!("/b/op serve --base-url {URL}"));
        let lines = success_lines(&r, &cmd);
        assert!(lines.starts_with(&format!(
            "등록됐다: mac (op-1) @ {URL} — 설정: {}/operator/operator.json",
            r.root
        )));
        // 도는 오퍼레이터가 없었다 — `run` 이 아니라 이 커뮤니티의 `serve` 명령을 보인다(P1b 안 A).
        assert!(lines.contains(&format!("\n  /b/op serve --base-url {URL}\n")));
        assert!(lines.contains("옆의 harkroom-runner-rs 로 뜬다"));
        assert!(!lines.contains(" run"));
    }

    /// `serve` 명령은 register 가 쓴 뿌리를 가리켜야 한다 — 색인이 정한 뿌리면 `--app-data`, 러너를 알면 `--runner-command`.
    #[test]
    fn serve_command_quotes_paths_with_spaces() {
        let home = "/h";
        let app_data = "/Users/a/Library/Application Support/dev.harkroom.app";
        assert_eq!(
            serve_command(
                "/Apps/My Apps/Harkroom.app/Contents/MacOS/harkroom-operator-rs",
                Some("/Apps/My Apps/Harkroom.app/Contents/MacOS/harkroom-runner"),
                URL,
                app_data,
                home,
                app_data
            ),
            format!(
                "'/Apps/My Apps/Harkroom.app/Contents/MacOS/harkroom-operator-rs' serve --base-url {URL} \
                 --app-data '/Users/a/Library/Application Support/dev.harkroom.app' \
                 --runner-command '/Apps/My Apps/Harkroom.app/Contents/MacOS/harkroom-runner'"
            )
        );
        assert_eq!(shell_quote("it's"), r"'it'\''s'");
        assert_eq!(shell_quote(""), "''");
        assert_eq!(shell_quote("/b/op"), "/b/op");
    }

    #[test]
    fn serve_command_points_at_the_same_root() {
        let home = "/h";
        let computed = harkroom_roots::computed_community_root(home, URL, 8);
        assert_eq!(
            serve_command("/b/op", None, &format!("{URL}/"), &computed, home, "/h/app"),
            format!("/b/op serve --base-url {URL}")
        );
        // 색인의 legacy 뿌리(옛 단일 자리) — --app-data 가 없으면 serve 는 계산한 뿌리를 보고 토큰을 못 찾는다.
        assert_eq!(
            serve_command(
                "/b/op",
                Some("/b/harkroom-runner"),
                URL,
                "/h/app",
                home,
                "/h/app"
            ),
            format!(
                "/b/op serve --base-url {URL} --app-data /h/app --runner-command /b/harkroom-runner"
            )
        );
        // 러너를 알면 안내 줄을 덧붙이지 않는다.
        let r = Registered {
            out: json!({}),
            live: false,
            root: computed.clone(),
        };
        let cmd = serve_command(
            "/b/op",
            Some("/b/harkroom-runner"),
            URL,
            &computed,
            home,
            "/h/app",
        );
        assert!(!success_lines(&r, &cmd).contains("붙인다"));
        let live = Registered { live: true, ..r };
        assert!(!success_lines(&live, &cmd).contains("serve"));
    }

    /// 토큰 파일은 있는데 소켓이 죽었으면(잔해) 파일 길로 간다.
    #[test]
    fn stale_token_without_socket_falls_back() {
        let d = Dir::new();
        let root = register_root(d.p(), URL, &format!("{}/app", d.p())).unwrap();
        let paths = daemon_endpoint_paths(&root);
        std::fs::create_dir_all(&paths.dir).unwrap();
        std::fs::write(&paths.token_path, "t\n").unwrap();
        let input = RegisterInput {
            base_url: URL.into(),
            code: "c".into(),
            name: None,
        };
        assert_eq!(
            register_via_running_operator(&root, &input, Duration::from_secs(2)).unwrap(),
            None
        );
    }

    /// 가짜 도는 오퍼레이터 — 받은 줄을 돌려주고 `replies` 를 차례로 쓴다.
    fn fake_operator(
        root: &str,
        token: &str,
        replies: Vec<Value>,
    ) -> std::thread::JoinHandle<Vec<Value>> {
        let paths = daemon_endpoint_paths(root);
        std::fs::create_dir_all(&paths.dir).unwrap();
        std::fs::write(&paths.token_path, format!("{token}\n")).unwrap();
        let listener = UnixListener::bind(&paths.socket_path).unwrap();
        std::thread::spawn(move || {
            let (sock, _) = listener.accept().unwrap();
            let mut w = sock.try_clone().unwrap();
            let mut r = BufReader::new(sock);
            let mut seen = Vec::new();
            for reply in replies {
                let mut line = String::new();
                if r.read_line(&mut line).unwrap_or(0) == 0 {
                    break;
                }
                seen.push(serde_json::from_str(line.trim_end()).unwrap());
                let _ = w.write_all(format!("{reply}\n").as_bytes());
            }
            seen
        })
    }

    #[test]
    fn running_operator_claims_and_no_file_is_written() {
        let d = Dir::new();
        let app = format!("{}/app", d.p());
        let root = register_root(d.p(), URL, &app).unwrap();
        let payload =
            json!({"operatorId": "op-9", "name": "mac", "baseUrl": URL, "replaced": null});
        let paths = daemon_endpoint_paths(&root);
        std::fs::create_dir_all(&paths.dir).unwrap();
        std::fs::write(&paths.token_path, "sock-tok\n").unwrap();
        let listener = UnixListener::bind(&paths.socket_path).unwrap();
        let reply = payload.clone();
        let h = std::thread::spawn(move || {
            let (sock, _) = listener.accept().unwrap();
            let mut w = sock.try_clone().unwrap();
            let mut r = BufReader::new(sock);
            let mut seen: Vec<Value> = Vec::new();
            let mut line = String::new();
            r.read_line(&mut line).unwrap();
            seen.push(serde_json::from_str(line.trim_end()).unwrap());
            w.write_all(b"{\"type\":\"hello\",\"ok\":true}\n").unwrap();
            line.clear();
            r.read_line(&mut line).unwrap();
            seen.push(serde_json::from_str(line.trim_end()).unwrap());
            // 깨진 줄·우리 요청과 무관한 줄은 건너뛰고 id 가 맞는 답만 본다.
            w.write_all(b"not json\n{\"type\":\"event\"}\n").unwrap();
            w.write_all(
                format!(
                    "{}\n",
                    json!({"id": "register", "ok": true, "payload": reply})
                )
                .as_bytes(),
            )
            .unwrap();
            seen
        });
        let args = parse_register_args(&s(&[URL, "C0DE", "--name", "mac"])).unwrap();
        let fake = Fake::ok();
        let r = run_register(
            &args,
            d.p(),
            &app,
            &fake,
            &|| "host".into(),
            Duration::from_secs(5),
        )
        .unwrap();
        assert!(r.live);
        assert_eq!(r.out, payload);
        assert!(
            fake.calls.lock().unwrap().is_empty(),
            "직접 claim 하지 않는다"
        );
        assert!(
            LocalAgents::new(&r.root, URL).operator_token().is_none(),
            "파일은 도는 오퍼레이터 몫이다"
        );
        let seen = h.join().unwrap();
        assert_eq!(
            seen[0],
            json!({"type": "hello", "version": 1, "token": "sock-tok", "role": "app"})
        );
        assert_eq!(
            seen[1],
            json!({"id": "register", "type": "operatorRegister",
                   "payload": {"baseUrl": URL, "code": "C0DE", "name": "mac"}})
        );
    }

    #[test]
    fn hello_refused_falls_back_to_file() {
        let d = Dir::new();
        let app = format!("{}/app", d.p());
        let root = register_root(d.p(), URL, &app).unwrap();
        let srv = fake_operator(
            &root,
            "old",
            vec![json!({"type": "hello", "ok": false, "error": {"code": "unauthorized"}})],
        );
        let args = parse_register_args(&s(&[URL, "C0DE"])).unwrap();
        let fake = Fake::ok();
        let r = run_register(
            &args,
            d.p(),
            &app,
            &fake,
            &|| "h".into(),
            Duration::from_secs(5),
        )
        .unwrap();
        assert!(!r.live);
        assert_eq!(fake.calls.lock().unwrap().len(), 1);
        srv.join().unwrap();
    }

    /// 도는 오퍼레이터가 요청을 거절하면 그 사유로 끝낸다 — 1회용 코드를 파일 길에서 다시 쓰지 않는다.
    #[test]
    fn running_operator_refusal_is_final() {
        let d = Dir::new();
        let app = format!("{}/app", d.p());
        let root = register_root(d.p(), URL, &app).unwrap();
        let srv = fake_operator(
            &root,
            "t",
            vec![
                json!({"type": "hello", "ok": true}),
                json!({"id": "register", "ok": false,
                       "error": {"code": "bad-payload", "message": "등록 실패(400): 코드가 만료됐다"}}),
            ],
        );
        let args = parse_register_args(&s(&[URL, "C0DE"])).unwrap();
        let fake = Fake::ok();
        let e = run_register(
            &args,
            d.p(),
            &app,
            &fake,
            &|| "h".into(),
            Duration::from_secs(5),
        )
        .unwrap_err();
        assert_eq!(e, "등록 실패(400): 코드가 만료됐다");
        assert!(fake.calls.lock().unwrap().is_empty());
        srv.join().unwrap();
    }

    #[test]
    fn main_reports_usage_and_missing_home() {
        let none = |_: &str| None;
        let (out, err, code) = register_main(&s(&[URL]), &none);
        assert_eq!((out.as_str(), err.as_str(), code), ("", USAGE, 2));
        let (_, err, code) = register_main(&s(&[URL, "C"]), &none);
        assert_eq!((err.as_str(), code), ("HOME 을 모른다", 2));
    }
}
