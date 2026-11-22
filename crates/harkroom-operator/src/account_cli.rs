//! `harkroom-operator-rs account <list|login|remove> --base-url <url> …` — 화면 없는 기기(리눅스 서버 등)에서 claude 계정을
//! 터미널로 다룬다(L1a-2). **도는 오퍼레이터의 앱 소켓**에 앱과 같은 요청을 보낸다 — 계정 풀을 직접 건드리지 않는다.
//!
//! - `list`: `claudeAccountsList` 를 표로(또는 `--json` 그대로).
//! - `login <pool> <account> [--reauth]`: `claudeAccountLoginStart` → `claudeLoginOutput` 이벤트의 주소를 **이 터미널에만**
//!   찍고 → 붙여 넣은 코드를 `claudeAccountLoginSubmit` 으로 보낸 뒤 → 끝 이벤트(`done`)의 상태로 성패를 낸다.
//! - `remove <pool> <account> [--yes]`: `claudeAccountRemove`. `--yes` 가 없으면 한 번 묻는다.
//!
//! 규율:
//! - **주소·코드는 표준 출력(주소)과 소켓(코드) 말고 어디에도 쓰지 않는다** — 로그·오류 글·파일에 싣지 않는다.
//! - 소켓 토큰은 **내 소유·0600·보통 파일(심링크 아님)** 일 때만 읽고, 소켓과 그 폴더도 내 소유일 때만 붙는다 —
//!   토큰을 남이 듣는 소켓에 보내지 않게.
//! - 오퍼레이터가 떠 있지 않으면 그 사실을 알리고 끝낸다(파일 길로 대신하지 않는다).
//! - `login` 은 Ctrl-C·TERM·HUP·입력 끝(EOF)·시한에 `claudeAccountLoginCancel` 을 보내고 끝낸다 — 로그인 자식을 남기지 않는다.
//!   시작 요청을 보낸 뒤 그 답(loginId) 전에 끝나게 되면 답을 잠깐 더 기다려 취소한다. 보내기 전에 온 신호면 시작하지 않는다.
use crate::register_cli::{check_url, default_app_data, register_root};
use harkroom_roots::{DAEMON_PROTOCOL_VERSION, community_root_key, daemon_endpoint_paths};
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::{FileTypeExt, MetadataExt, OpenOptionsExt};
use std::os::unix::io::AsRawFd;
use std::os::unix::net::UnixStream;
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::time::{Duration, Instant};

pub const USAGE: &str = "사용법:\n  harkroom-operator-rs account list --base-url <url> [--json]\n  harkroom-operator-rs account login <pool> <account> --base-url <url> [--reauth]\n  harkroom-operator-rs account remove <pool> <account> --base-url <url> [--yes]\n  공통: [--home <dir>] [--app-data <dir>]";

/// 토큰 파일 상한 — 토큰은 hex 64자다.
const MAX_TOKEN_BYTES: u64 = 4096;
/// 요청 하나의 답을 기다리는 시한.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// `login` 의 시한들. 시험이 줄인다.
#[derive(Debug, Clone, Copy)]
pub struct LoginTimeouts {
    /// 시작 답·주소가 오기까지.
    pub url: Duration,
    /// 사람이 코드를 붙여 넣기까지.
    pub code: Duration,
    /// 코드를 보낸 뒤 끝 이벤트까지.
    pub done: Duration,
    /// 시작 답(loginId) 전에 끝나게 됐을 때, 취소하려고 그 답을 더 기다리는 시간.
    pub grace: Duration,
}

impl Default for LoginTimeouts {
    fn default() -> Self {
        Self {
            url: Duration::from_secs(60),
            code: Duration::from_secs(600),
            done: Duration::from_secs(120),
            grace: Duration::from_secs(2),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    List {
        json: bool,
    },
    Login {
        pool: String,
        account: String,
        reauth: bool,
    },
    Remove {
        pool: String,
        account: String,
        yes: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountArgs {
    pub action: Action,
    pub base_url: String,
    pub home: Option<String>,
    pub app_data: Option<String>,
}

pub fn parse_account_args(argv: &[String]) -> Result<AccountArgs, String> {
    let usage = || USAGE.to_string();
    let verb = argv.first().map(String::as_str).ok_or_else(usage)?;
    let (mut base_url, mut home, mut app_data) = (None, None, None);
    let (mut json, mut reauth, mut yes) = (false, false, false);
    let mut names: Vec<String> = Vec::new();
    let mut it = argv[1..].iter();
    while let Some(arg) = it.next() {
        let slot = match arg.as_str() {
            "--json" if verb == "list" => {
                json = true;
                continue;
            }
            "--reauth" if verb == "login" => {
                reauth = true;
                continue;
            }
            "--yes" if verb == "remove" => {
                yes = true;
                continue;
            }
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
    let pair = |names: Vec<String>| -> Result<(String, String), String> {
        match <[String; 2]>::try_from(names) {
            Ok([p, a]) if !p.is_empty() && !a.is_empty() => Ok((p, a)),
            _ => Err(usage()),
        }
    };
    let action = match verb {
        "list" if names.is_empty() => Action::List { json },
        "login" => {
            let (pool, account) = pair(names)?;
            Action::Login {
                pool,
                account,
                reauth,
            }
        }
        "remove" => {
            let (pool, account) = pair(names)?;
            Action::Remove { pool, account, yes }
        }
        _ => return Err(usage()),
    };
    let base_url = base_url.ok_or_else(|| format!("--base-url 이 없다\n{USAGE}"))?;
    check_url(&base_url)?;
    Ok(AccountArgs {
        action,
        base_url: community_root_key(&base_url).to_string(),
        home,
        app_data,
    })
}

/// 소켓 토큰을 읽는다 — 심링크를 따르지 않고(`O_NOFOLLOW`), **연 파일**이 내 소유의 0600 보통 파일일 때만.
/// `Ok(None)` 은 파일이 없다(오퍼레이터가 뜬 적 없다)는 뜻이다. 오류 글에는 경로만 싣는다.
pub fn read_socket_token(path: &str, euid: u32) -> Result<Option<String>, String> {
    let f = match std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
    {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        // 심링크면 ELOOP 다. 어느 쪽이든 읽지 않는다.
        Err(e) => {
            return Err(format!(
                "소켓 토큰을 열지 못했다(심링크는 읽지 않는다): {path} — {e}"
            ));
        }
    };
    let m = f
        .metadata()
        .map_err(|e| format!("소켓 토큰을 재지 못했다: {path} — {e}"))?;
    if !m.file_type().is_file() {
        return Err(format!("소켓 토큰이 보통 파일이 아니다: {path}"));
    }
    if m.uid() != euid {
        return Err(format!("소켓 토큰이 내 소유가 아니다: {path}"));
    }
    if m.mode() & 0o077 != 0 {
        return Err(format!(
            "소켓 토큰의 권한이 0600 보다 넓다({:o}): {path}",
            m.mode() & 0o777
        ));
    }
    let mut text = String::new();
    f.take(MAX_TOKEN_BYTES + 1)
        .read_to_string(&mut text)
        .map_err(|e| format!("소켓 토큰을 읽지 못했다: {path} — {e}"))?;
    let token = text.trim();
    if token.is_empty() || text.len() as u64 > MAX_TOKEN_BYTES {
        return Err(format!("소켓 토큰이 비었거나 너무 크다: {path}"));
    }
    Ok(Some(token.to_string()))
}

/// 소켓과 그 폴더가 내 것인가 — 토큰을 보내기 전에 본다. 폴더는 심링크가 아닌 내 소유 디렉터리이고 남이 쓸 수 없어야 한다.
fn check_socket_place(dir: &str, socket_path: &str, euid: u32) -> Result<(), String> {
    let d = std::fs::symlink_metadata(dir)
        .map_err(|e| format!("소켓 폴더를 재지 못했다: {dir} — {e}"))?;
    if !d.file_type().is_dir() || d.uid() != euid || d.mode() & 0o022 != 0 {
        return Err(format!(
            "소켓 폴더가 내 소유의 닫힌 디렉터리가 아니다: {dir}"
        ));
    }
    let s = std::fs::symlink_metadata(socket_path)
        .map_err(|e| format!("소켓을 재지 못했다: {socket_path} — {e}"))?;
    if !s.file_type().is_socket() || s.uid() != euid {
        return Err(format!(
            "소켓이 내 소유의 소켓 파일이 아니다: {socket_path}"
        ));
    }
    Ok(())
}

/// 붙은 상대의 uid. 못 읽으면 `None`.
fn peer_uid(sock: &UnixStream) -> Option<u32> {
    let fd = sock.as_raw_fd();
    #[cfg(target_os = "linux")]
    {
        // SAFETY: 0 으로 채운 `ucred` 와 그 크기를 넘기는 표준 호출이다.
        let mut cred: libc::ucred = unsafe { std::mem::zeroed() };
        let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
        let rc = unsafe {
            libc::getsockopt(
                fd,
                libc::SOL_SOCKET,
                libc::SO_PEERCRED,
                (&raw mut cred).cast(),
                &raw mut len,
            )
        };
        (rc == 0).then_some(cred.uid)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let (mut uid, mut gid): (libc::uid_t, libc::gid_t) = (0, 0);
        // SAFETY: 열린 소켓 fd 와 받을 자리 둘을 넘기는 표준 호출이다.
        let rc = unsafe { libc::getpeereid(fd, &raw mut uid, &raw mut gid) };
        (rc == 0).then_some(uid)
    }
}

/// 인증을 마친 앱 접속.
pub struct Conn {
    writer: UnixStream,
    reader: BufReader<UnixStream>,
}

/// 앱이 오퍼레이터를 띄우는 기기(macOS)의 안내.
#[cfg(not(target_os = "linux"))]
pub const NOT_RUNNING: &str = "이 커뮤니티의 오퍼레이터가 떠 있지 않다 — 앱을 열거나 `harkroom-operator-rs serve --base-url <url>` 을 먼저 띄운다";
/// Linux 는 앱이 없다 — 설치기가 깐 유닛(키는 `register` 가 찍은 설정 경로의 `c/<8자>`)이나 `serve` 로 띄운다.
#[cfg(target_os = "linux")]
pub const NOT_RUNNING: &str = "이 커뮤니티의 오퍼레이터가 떠 있지 않다 — `systemctl --user start harkroom-operator@<키>` 로 띄우거나 `harkroom-operator serve --base-url <url>` 을 먼저 띄운다";

fn send(w: &mut UnixStream, v: &Value) -> Result<(), String> {
    w.write_all(format!("{v}\n").as_bytes())
        .map_err(|e| format!("오퍼레이터에 요청을 보내지 못했다: {e}"))
}

/// 한 줄(JSON)을 읽는다. 깨진 줄은 건너뛴다. 끊기거나 시한이면 `None`.
fn next_line(r: &mut BufReader<UnixStream>) -> Option<Value> {
    let mut buf = String::new();
    loop {
        buf.clear();
        match r.read_line(&mut buf) {
            Ok(0) | Err(_) => return None,
            Ok(_) => {}
        }
        if let Ok(v) = serde_json::from_str::<Value>(buf.trim_end()) {
            return Some(v);
        }
    }
}

fn error_message(msg: &Value) -> String {
    msg.pointer("/error/message")
        .and_then(Value::as_str)
        .unwrap_or("오퍼레이터가 요청을 거절했다")
        .to_string()
}

impl Conn {
    /// 뿌리 `root` 의 도는 오퍼레이터에 앱으로 붙는다.
    pub fn open(root: &str, timeout: Duration) -> Result<Conn, String> {
        // SAFETY: 인자 없는 조회다.
        let euid = unsafe { libc::geteuid() };
        let paths = daemon_endpoint_paths(root);
        let Some(token) = read_socket_token(&paths.token_path, euid)? else {
            return Err(NOT_RUNNING.to_string());
        };
        check_socket_place(&paths.dir, &paths.socket_path, euid)?;
        let sock = UnixStream::connect(&paths.socket_path).map_err(|_| NOT_RUNNING.to_string())?;
        // 경로를 잰 뒤 붙기까지의 틈에 소켓이 바뀌었어도, 붙은 상대가 내 uid 가 아니면 토큰을 보내지 않는다.
        if peer_uid(&sock) != Some(euid) {
            return Err(format!(
                "소켓의 상대가 내 계정의 프로세스가 아니다: {}",
                paths.socket_path
            ));
        }
        let _ = sock.set_read_timeout(Some(timeout));
        let _ = sock.set_write_timeout(Some(timeout));
        let mut writer = sock
            .try_clone()
            .map_err(|e| format!("소켓을 나누지 못했다: {e}"))?;
        send(
            &mut writer,
            &json!({ "type": "hello", "version": DAEMON_PROTOCOL_VERSION, "token": token, "role": "app" }),
        )?;
        let mut reader = BufReader::new(sock);
        match next_line(&mut reader) {
            Some(v) if v.get("ok") == Some(&Value::Bool(true)) => Ok(Conn { writer, reader }),
            Some(v) => Err(format!(
                "오퍼레이터가 접속을 거절했다: {}",
                error_message(&v)
            )),
            None => Err(NOT_RUNNING.to_string()),
        }
    }

    /// 요청 하나를 보내고 그 답만 기다린다(그 사이 이벤트 줄은 버린다).
    pub fn call(&mut self, ty: &str, payload: Value) -> Result<Value, String> {
        send(
            &mut self.writer,
            &json!({ "id": ty, "type": ty, "payload": payload }),
        )?;
        loop {
            let Some(msg) = next_line(&mut self.reader) else {
                return Err("오퍼레이터가 답하지 않고 끊었다".to_string());
            };
            if msg.get("id").and_then(Value::as_str) != Some(ty) {
                continue;
            }
            if msg.get("ok") == Some(&Value::Bool(true)) {
                return Ok(msg.get("payload").cloned().unwrap_or(Value::Null));
            }
            return Err(error_message(&msg));
        }
    }
}

/// `claudeAccountsList` 답을 사람이 읽을 표로. 자격증명·경로 밖의 것은 싣지 않는다(이름·로그인 여부·메일·표식).
pub fn render_list(snapshot: &Value) -> String {
    let mut out = Vec::new();
    let default = snapshot.get("defaultPool").and_then(Value::as_str);
    let pools = snapshot
        .get("pools")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for p in &pools {
        let name = p.get("name").and_then(Value::as_str).unwrap_or("");
        out.push(format!(
            "풀 {name}{}",
            if default == Some(name) {
                " (기본)"
            } else {
                ""
            }
        ));
        let accounts = p
            .get("accounts")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if accounts.is_empty() {
            out.push("  (계정 없음)".to_string());
        }
        for a in &accounts {
            let acc = a.get("name").and_then(Value::as_str).unwrap_or("");
            let logged = a.pointer("/status/loggedIn") == Some(&Value::Bool(true));
            let mut line = format!(
                "  {acc}\t{}",
                if logged {
                    "로그인됨"
                } else {
                    "로그인 안 됨"
                }
            );
            if let Some(e) = a.pointer("/status/email").and_then(Value::as_str) {
                line.push_str(&format!("\t{e}"));
            }
            if a.get("authFailure").is_some() {
                line.push_str("\t[다시 로그인 필요]");
            }
            if a.get("attention").is_some() {
                line.push_str("\t[확인 필요]");
            }
            out.push(line);
        }
    }
    if pools.is_empty() {
        out.push(NO_POOLS.to_string());
    }
    out.join("\n")
}

/// 풀이 하나도 없을 때의 한 줄. 풀은 **선택**이다 — 없으면 러너는 이 기기 하네스의 기본 로그인으로 돈다.
pub const NO_POOLS: &str = "계정 풀이 없다 — 이대로도 돈다(하네스의 기본 로그인을 쓴다). 계정 여러 개를 돌려 쓰려 할 때만 `account login <pool> <account>` 로 더한다";

/// `login` 루프가 받는 것.
pub enum Msg {
    Sock(Value),
    SockClosed,
    /// 입력 한 줄. `None` 은 입력 끝(EOF).
    Stdin(Option<String>),
    /// Ctrl-C·TERM·HUP.
    Interrupt,
}

/// 표준 입력을 줄 단위로 넘긴다. 끝나면 `None` 을 한 번 보낸다.
pub fn pump_stdin(mut input: Box<dyn BufRead + Send>, tx: Sender<Msg>) {
    std::thread::spawn(move || {
        loop {
            let mut line = String::new();
            match input.read_line(&mut line) {
                Ok(0) | Err(_) => {
                    let _ = tx.send(Msg::Stdin(None));
                    return;
                }
                Ok(_) => {
                    if tx.send(Msg::Stdin(Some(line))).is_err() {
                        return;
                    }
                }
            }
        }
    });
}

struct Hangup(UnixStream);
impl Drop for Hangup {
    fn drop(&mut self) {
        let _ = self.0.shutdown(std::net::Shutdown::Both);
    }
}

/// 취소를 보낸다. id 를 아직 모르면(시작 답 전) 그 답을 `grace` 만큼 더 기다려 id 가 오면 취소한다 —
/// 그냥 끊으면 오퍼레이터는 접속이 끊겨도 로그인을 거두지 않아 로그인 자식이 남는다.
fn cancel_login(writer: &mut UnixStream, id: Option<&str>, rx: &Receiver<Msg>, grace: Duration) {
    let late: Option<String>;
    let id = match id {
        Some(id) => id,
        None => {
            let until = Instant::now() + grace;
            late = loop {
                match rx.recv_timeout(until.saturating_duration_since(Instant::now())) {
                    Ok(Msg::Sock(v)) if v.get("id").and_then(Value::as_str) == Some("start") => {
                        // 거절된 시작이면 loginId 가 없다 — 거둘 것도 없다.
                        break v
                            .pointer("/payload/loginId")
                            .and_then(Value::as_str)
                            .map(str::to_string);
                    }
                    Ok(Msg::SockClosed) | Err(_) => break None,
                    Ok(_) => {}
                }
            };
            match late.as_deref() {
                Some(id) => id,
                None => return,
            }
        }
    };
    let _ = send(
        writer,
        &json!({ "id": "cancel", "type": "claudeAccountLoginCancel", "payload": { "loginId": id } }),
    );
}

/// 로그인할 자리.
#[derive(Debug, Clone, Copy)]
pub struct LoginTarget<'a> {
    pub pool: &'a str,
    pub account: &'a str,
    pub reauth: bool,
}

/// 로그인 한 번. 주소는 `out` 에만 쓴다. 돌려주는 것은 (종료 코드, 마지막 줄 — 주소·코드를 싣지 않는다).
pub fn run_login(
    conn: Conn,
    who: LoginTarget<'_>,
    rx: Receiver<Msg>,
    tx: Sender<Msg>,
    out: &mut dyn Write,
    t: LoginTimeouts,
) -> (i32, String) {
    let LoginTarget {
        pool,
        account,
        reauth,
    } = who;
    let Conn { mut writer, reader } = conn;
    // 어느 길로 끝나든 접속을 닫는다 — 읽는 스레드가 소켓을 쥔 채 남지 않게.
    let _hangup = writer.try_clone().ok().map(Hangup);
    // 접속을 여는 동안 쌓인 신호·입력 끝을 먼저 본다 — 시작 요청을 보내고 나면 그 답 전에는 취소할 id 가 없다.
    loop {
        match rx.try_recv() {
            Ok(Msg::Interrupt) => return (130, "로그인을 취소했다".to_string()),
            Ok(Msg::Stdin(None)) => {
                return (1, "입력이 끝났다 — 로그인을 시작하지 않았다".to_string());
            }
            Ok(_) => {}
            Err(_) => break,
        }
    }
    // 읽기 시한을 푼다 — 사람이 코드를 넣는 동안 조용한 것이 정상이다. 시한은 아래 루프가 잰다.
    let _ = reader.get_ref().set_read_timeout(None);
    {
        let mut reader = reader;
        std::thread::spawn(move || {
            while let Some(v) = next_line(&mut reader) {
                if tx.send(Msg::Sock(v)).is_err() {
                    return;
                }
            }
            let _ = tx.send(Msg::SockClosed);
        });
    }
    let mut payload = json!({ "pool": pool, "account": account });
    if reauth {
        payload["reauth"] = Value::Bool(true);
    }
    if let Err(e) = send(
        &mut writer,
        &json!({ "id": "start", "type": "claudeAccountLoginStart", "payload": payload }),
    ) {
        return (1, e);
    }
    let mut login_id: Option<String> = None;
    // 시작 답보다 먼저 온 로그인 이벤트 — id 를 알게 되면 다시 본다.
    let mut early: Vec<Value> = Vec::new();
    let mut url_shown = false;
    let mut submitted = false;
    let mut deadline = Instant::now() + t.url;
    let cancel = |writer: &mut UnixStream, id: &Option<String>| {
        cancel_login(writer, id.as_deref(), &rx, t.grace);
    };
    loop {
        let msg = match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(m) => m,
            Err(RecvTimeoutError::Timeout) => {
                cancel(&mut writer, &login_id);
                let what = if submitted {
                    "로그인 결과"
                } else if url_shown {
                    "코드 입력"
                } else {
                    "로그인 주소"
                };
                return (
                    1,
                    format!("{what}을(를) 기다리다 시한이 지났다 — 로그인을 취소했다"),
                );
            }
            Err(RecvTimeoutError::Disconnected) => return (1, "입력이 모두 닫혔다".to_string()),
        };
        let mut events: Vec<Value> = Vec::new();
        match msg {
            Msg::Interrupt => {
                cancel(&mut writer, &login_id);
                return (130, "로그인을 취소했다".to_string());
            }
            Msg::SockClosed => return (1, "오퍼레이터와의 접속이 끊겼다".to_string()),
            Msg::Stdin(None) if !submitted => {
                cancel(&mut writer, &login_id);
                return (1, "입력이 끝났다 — 로그인을 취소했다".to_string());
            }
            Msg::Stdin(None) => {}
            Msg::Stdin(Some(line)) => {
                let code = line.trim();
                let Some(id) = login_id.as_ref().filter(|_| url_shown && !submitted) else {
                    continue;
                };
                if code.is_empty() {
                    let _ = write!(out, "코드> ");
                    let _ = out.flush();
                    continue;
                }
                if let Err(e) = send(
                    &mut writer,
                    &json!({ "id": "submit", "type": "claudeAccountLoginSubmit",
                             "payload": { "loginId": id, "code": code } }),
                ) {
                    return (1, e);
                }
                submitted = true;
                deadline = Instant::now() + t.done;
                let _ = writeln!(out, "코드를 보냈다. 결과를 기다린다…");
            }
            Msg::Sock(v) => match v.get("id").and_then(Value::as_str) {
                Some("start") => {
                    if v.get("ok") != Some(&Value::Bool(true)) {
                        return (1, error_message(&v));
                    }
                    let Some(id) = v.pointer("/payload/loginId").and_then(Value::as_str) else {
                        return (1, "오퍼레이터가 loginId 를 주지 않았다".to_string());
                    };
                    login_id = Some(id.to_string());
                    events = std::mem::take(&mut early);
                }
                Some("submit") if v.get("ok") != Some(&Value::Bool(true)) => {
                    cancel(&mut writer, &login_id);
                    return (1, error_message(&v));
                }
                Some(_) => {}
                None => {
                    if v.get("event").and_then(Value::as_str) == Some("claudeLoginOutput")
                        && let Some(p) = v.get("payload")
                    {
                        if login_id.is_some() {
                            events.push(p.clone());
                        } else if early.len() < 16 {
                            early.push(p.clone());
                        }
                    }
                }
            },
        }
        for p in events {
            if p.get("loginId").and_then(Value::as_str) != login_id.as_deref() {
                continue;
            }
            if p.get("done") == Some(&Value::Bool(true)) {
                if p.pointer("/status/loggedIn") == Some(&Value::Bool(true)) {
                    let who = p
                        .pointer("/status/email")
                        .and_then(Value::as_str)
                        .map(|e| format!(" ({e})"))
                        .unwrap_or_default();
                    return (0, format!("로그인됐다: {pool}/{account}{who}"));
                }
                return (
                    1,
                    p.get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("로그인이 끝나지 않았다")
                        .to_string(),
                );
            }
            if let Some(url) = p.get("url").and_then(Value::as_str).filter(|_| !url_shown) {
                url_shown = true;
                deadline = Instant::now() + t.code;
                let _ = write!(
                    out,
                    "브라우저에서 아래 주소를 열어 로그인하고, 화면에 나온 코드를 여기에 붙여 넣는다(그만두려면 Ctrl-C):\n\n{url}\n\n코드> "
                );
                let _ = out.flush();
            }
        }
    }
}

/// INT·TERM·HUP(터미널 닫힘)을 이 스레드부터 막고(뒤에 띄우는 스레드가 물려받는다) 전용 스레드가 기다렸다가 알린다.
fn watch_signals(tx: Sender<Msg>) {
    // SAFETY: 초기화한 신호 집합을 넘기는 표준 호출이다. 다른 스레드를 띄우기 전에 부른다.
    let set = unsafe {
        let mut set: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut set);
        libc::sigaddset(&mut set, libc::SIGINT);
        libc::sigaddset(&mut set, libc::SIGTERM);
        libc::sigaddset(&mut set, libc::SIGHUP);
        libc::pthread_sigmask(libc::SIG_BLOCK, &set, std::ptr::null_mut());
        set
    };
    std::thread::spawn(move || {
        let mut sig: libc::c_int = 0;
        // SAFETY: 위에서 막아 둔 집합을 기다린다.
        if unsafe { libc::sigwait(&set, &mut sig) } == 0 {
            let _ = tx.send(Msg::Interrupt);
        }
    });
}

/// `account` 진입점. 주소·표는 `out`, 오류는 `err`. 돌려주는 것은 종료 코드(0 됨 · 1 실패 · 2 인자 틀림 · 130 취소).
pub fn account_main(
    argv: &[String],
    env: &dyn Fn(&str) -> Option<String>,
    mut input: Box<dyn BufRead + Send>,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> i32 {
    let args = match parse_account_args(argv) {
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
    let fail = |err: &mut dyn Write, e: String| {
        let _ = writeln!(err, "{e}");
        1
    };
    let root = match register_root(&home, &args.base_url, &app_data) {
        Ok(r) => r,
        Err(e) => return fail(err, e),
    };
    match args.action {
        Action::List { json } => {
            let snap = match Conn::open(&root, REQUEST_TIMEOUT)
                .and_then(|mut c| c.call("claudeAccountsList", json!({})))
            {
                Ok(s) => s,
                Err(e) => return fail(err, e),
            };
            let _ = writeln!(
                out,
                "{}",
                if json {
                    snap.to_string()
                } else {
                    render_list(&snap)
                }
            );
            0
        }
        Action::Remove { pool, account, yes } => {
            let mut conn = match Conn::open(&root, REQUEST_TIMEOUT) {
                Ok(c) => c,
                Err(e) => return fail(err, e),
            };
            if !yes {
                let _ = write!(
                    out,
                    "계정 {pool}/{account} 의 로그인 자격을 이 기기에서 지운다. 계속하려면 y: "
                );
                let _ = out.flush();
                let mut line = String::new();
                let _ = input.read_line(&mut line);
                if !matches!(line.trim(), "y" | "Y" | "yes") {
                    return fail(err, "지우지 않았다".to_string());
                }
            }
            match conn.call(
                "claudeAccountRemove",
                json!({ "pool": pool, "account": account }),
            ) {
                Ok(_) => {
                    let _ = writeln!(out, "지웠다: {pool}/{account}");
                    0
                }
                Err(e) => fail(err, e),
            }
        }
        Action::Login {
            pool,
            account,
            reauth,
        } => {
            let (tx, rx) = channel();
            watch_signals(tx.clone());
            let conn = match Conn::open(&root, REQUEST_TIMEOUT) {
                Ok(c) => c,
                Err(e) => return fail(err, e),
            };
            pump_stdin(input, tx.clone());
            let (code, line) = run_login(
                conn,
                LoginTarget {
                    pool: &pool,
                    account: &account,
                    reauth,
                },
                rx,
                tx,
                out,
                LoginTimeouts::default(),
            );
            if code == 0 {
                let _ = writeln!(out, "{line}");
            } else {
                let _ = writeln!(err, "\n{line}");
            }
            code
        }
    }
}

#[cfg(test)]
mod tests;
