//! claude 계정 로그인(s21c3b). 정본은 `packages/operator/src/claudeAccounts.ts` 의 `loginStart`·`loginSubmit`·
//! `loginCancel`·`shutdownLogins`·`onLoginEvent` 다.
//!
//! - `claude auth login --claudeai` 를 그 계정의 `CLAUDE_CONFIG_DIR` 로 **파이프**에 띄운다(TS 실측: 파이프에서도
//!   URL 을 찍고 stdin 에서 코드를 읽는다).
//! - stdout 에서 URL 을 **끝난 증거(공백·BEL·ESC)가 있을 때만** 한 번 낸다 — 청크가 URL 중간에서 잘릴 수 있다.
//! - 끝나면 종료 코드가 아니라 **디스크 상태를 다시 재서** 성패를 정한다. 이 로그인이 만든 디렉터리만 실패 때 치운다.
//! - 성공이면 새 계정은 그 풀 `order` 끝에 붙이고, 관문·로그인 풀림 표식을 지우고, 첫 실행 관문을 미리 지나 둔다.
//!
//! 오퍼레이터는 스레드 구조라(tokio 없음) 자식은 표 잠금 안에서 `try_wait` 로 거둔다. 신호도 같은 잠금 안에서
//! `settled` 를 보고 보낸다 — 거둔 뒤의 pid(재사용될 수 있다)에 신호가 가는 틈이 없다.
//!
//! **코드·URL 은 로그에 적지 않는다.** URL 은 앱 소켓 이벤트(`claudeLoginOutput`)로만 나가고 서버로는 가지 않는다.
use crate::claude_accounts::{under, under_no_symlink, update_pool_order};
use indexmap::IndexMap;
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

/// SIGTERM → SIGKILL 유예(TS `LOGIN_KILL_GRACE_MS`).
pub const LOGIN_KILL_GRACE: Duration = Duration::from_secs(5);
/// 코드 상한(TS `readLoginSubmit` 4096).
pub const MAX_CODE_LEN: usize = 4096;
/// 자식 거두기 폴링 간격.
const REAP_POLL: Duration = Duration::from_millis(50);
/// URL 을 찾는 동안 모으는 상한. 넘기면 더 모으지 않는다(URL 없이 끝나는 로그인도 `done` 은 온다).
const URL_BUFFER_CAP: usize = 64 * 1024;

pub const ATTENTION_FILE: &str = ".harkroom-attention.json";
pub const AUTH_FILE: &str = ".harkroom-auth.json";
pub const GLOBAL_CONFIG_FILE: &str = ".claude.json";

/// 띄운 로그인 자식. 시험이 가짜(`sh -c …`)를 끼운다.
pub type SpawnLogin = Box<dyn Fn(&Path) -> std::io::Result<Child> + Send + Sync>;
/// 디렉터리의 로그인 상태(TS `runStatus` → `readStatus`). 운영은 `account_status_from_disk`.
pub type StatusOf = Arc<dyn Fn(&Path) -> Value + Send + Sync>;
pub type Listener = Box<dyn Fn(Value) + Send + Sync>;
pub type SignedIn = Box<dyn Fn(&Path) + Send + Sync>;

/// 운영 `spawnLogin` — PATH 의 `claude` 를 그 계정 디렉터리로.
pub fn os_spawn_login(config_dir: &Path) -> std::io::Result<Child> {
    std::process::Command::new("claude")
        .args(["auth", "login", "--claudeai"])
        .env("CLAUDE_CONFIG_DIR", config_dir)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        // TS 는 stderr 를 파이프로 받고 읽지 않는다. 읽지 않는 파이프는 차면 자식을 세우므로 버린다.
        .stderr(std::process::Stdio::null())
        .spawn()
}

/// TS URL 정규식 `https://([^\s\u0007\u001b]+)[\s\u0007\u001b]` — 끝 표식까지 와야 낸다.
pub fn find_login_url(buf: &str) -> Option<String> {
    let start = buf.find("https://")?;
    let rest = &buf[start + "https://".len()..];
    let end = rest.find(|c: char| c.is_whitespace() || c == '\u{7}' || c == '\u{1b}')?;
    if end == 0 {
        return None;
    }
    Some(format!("https://{}", &rest[..end]))
}

/// 붙여 넣기에 개행이 섞이면 그 뒤가 다음 프롬프트의 답이 된다 — 첫 줄만(TS `code.split(/\r?\n/)[0]`).
pub fn first_line(code: &str) -> &str {
    let line = code.split('\n').next().unwrap_or("");
    line.strip_suffix('\r').unwrap_or(line)
}

/// TS `withClaudeAccountGates` — 바뀐 것이 없으면 `None`. 다른 키는 그대로 둔다.
pub fn with_account_gates(doc: &Map<String, Value>) -> Option<Map<String, Value>> {
    let mut next = doc.clone();
    let mut changed = false;
    if next.get("hasCompletedOnboarding") != Some(&Value::Bool(true)) {
        next.insert("hasCompletedOnboarding".into(), Value::Bool(true));
        changed = true;
    }
    let mut setup = next
        .get("autoModeEnvSetup")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if setup.get("dismissed") != Some(&Value::Bool(true)) {
        setup.insert("dismissed".into(), Value::Bool(true));
        next.insert("autoModeEnvSetup".into(), Value::Object(setup));
        changed = true;
    }
    changed.then_some(next)
}

/// TS `markClaudeAccountGates` — 깨졌거나 객체가 아니면 **쓰지 않는다**(하네스 상태를 덮지 않는다). 썼으면 참.
pub fn mark_account_gates(config_dir: &Path) -> Result<bool, String> {
    let path = config_dir.join(GLOBAL_CONFIG_FILE);
    let doc = match fs::read_to_string(&path) {
        Ok(text) => match serde_json::from_str::<Value>(&text) {
            Ok(Value::Object(m)) => m,
            Ok(_) => {
                return Err(format!(
                    "{GLOBAL_CONFIG_FILE} 가 객체가 아니다 — 덮어쓰지 않는다"
                ));
            }
            Err(_) => return Err(format!("{GLOBAL_CONFIG_FILE} 가 깨졌다 — 덮어쓰지 않는다")),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Map::new(),
        Err(e) => return Err(e.to_string()),
    };
    let Some(next) = with_account_gates(&doc) else {
        return Ok(false);
    };
    let text = serde_json::to_string_pretty(&Value::Object(next)).map_err(|e| e.to_string())?;
    // 0600 — 이 파일에는 MCP 설정과 사용 통계가 함께 산다. TS 와 같은 제자리 쓰기(writeFile)다.
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&path)
        .map_err(|e| e.to_string())?;
    f.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
    Ok(true)
}

/// TS `appendTo` — 이미 있으면 그대로.
pub fn append_to(
    order: &IndexMap<String, Vec<String>>,
    pool: &str,
    account: &str,
) -> IndexMap<String, Vec<String>> {
    let mut next = order.clone();
    let list = next.entry(pool.to_string()).or_default();
    if !list.iter().any(|n| n == account) {
        list.push(account.to_string());
    }
    next
}

struct Login {
    child: Child,
    stdin: Option<ChildStdin>,
    slot: String,
    settled: bool,
}

struct Inner {
    root: PathBuf,
    pools_path: PathBuf,
    spawn: SpawnLogin,
    status: StatusOf,
    kill_grace: Duration,
    logins: Mutex<HashMap<String, Login>>,
    listeners: Mutex<Vec<Listener>>,
    on_signed_in: OnceLock<SignedIn>,
}

/// 진행 중인 로그인 표(TS `logins` Map) + 이벤트 듣는 쪽.
#[derive(Clone)]
pub struct ClaudeLogins {
    inner: Arc<Inner>,
}

fn new_login_id() -> String {
    let mut b = [0u8; 16];
    // ring 난수 — 이미 lock 에 있다. 실패하면 시각·pid 로 대신한다(유일성만 필요하다).
    if ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut b).is_err() {
        let n = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        b = (n ^ (u128::from(std::process::id()) << 64)).to_le_bytes();
    }
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &h[0..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..32]
    )
}

fn signal(child: &Child, sig: i32) {
    if let Ok(pid) = i32::try_from(child.id()) {
        // SAFETY: 아직 거두지 않은 내 자식의 pid 다(표 잠금 안에서 `settled` 를 본 뒤에만 부른다).
        unsafe {
            libc::kill(pid, sig);
        }
    }
}

impl ClaudeLogins {
    pub fn new(
        root: PathBuf,
        pools_path: PathBuf,
        spawn: SpawnLogin,
        status: StatusOf,
        kill_grace: Duration,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                root,
                pools_path,
                spawn,
                status,
                kill_grace,
                logins: Mutex::new(HashMap::new()),
                listeners: Mutex::new(Vec::new()),
                on_signed_in: OnceLock::new(),
            }),
        }
    }

    /// TS `onLoginEvent`.
    pub fn on_event(&self, cb: Listener) {
        self.inner
            .listeners
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .push(cb);
    }

    /// TS `opts.onSignedIn` — 사용량 폴러가 그 계정을 다시 잰다(c3d 에서 잇는다).
    pub fn set_on_signed_in(&self, cb: SignedIn) {
        let _ = self.inner.on_signed_in.set(cb);
    }

    fn emit(inner: &Inner, e: Value) {
        let ls = inner.listeners.lock().unwrap_or_else(|p| p.into_inner());
        for cb in ls.iter() {
            // 듣는 쪽 하나가 로그인을 죽이지 않는다.
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| cb(e.clone())));
        }
    }

    fn table(&self) -> std::sync::MutexGuard<'_, HashMap<String, Login>> {
        self.inner.logins.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// TS `loginStart`. 돌려주는 것은 `loginId`.
    pub fn start(&self, pool: &str, account: &str, reauth: bool) -> Result<String, String> {
        let config_dir = under(&self.inner.root, &[pool, account])?;
        let slot = format!("{pool}/{account}");
        let is_dir = |p: &Path| fs::metadata(p).map(|m| m.is_dir()).unwrap_or(false);
        // 다시 로그인은 있는 계정에만 — 낡은 화면이 지운 계정을 되살리지 않게(2026-09-29).
        if reauth && !is_dir(&config_dir) {
            return Err(format!("다시 로그인할 계정이 없다: {slot}"));
        }
        let mut table = self.table();
        if table.values().any(|l| l.slot == slot && !l.settled) {
            return Err(format!("이 계정에 로그인이 이미 진행 중이다: {slot}"));
        }
        // 이 로그인이 디렉터리를 만드는가 — 실패 때 치우는 것은 이 로그인이 만든 것뿐이다.
        let created = fs::symlink_metadata(&config_dir).is_err();
        {
            use std::os::unix::fs::DirBuilderExt;
            fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(&config_dir)
                .map_err(|e| format!("계정 디렉터리를 만들지 못했다: {e}"))?;
        }
        let mut child = match (self.inner.spawn)(&config_dir) {
            Ok(c) => c,
            Err(e) => {
                if created {
                    let _ = fs::remove_dir_all(&config_dir);
                }
                return Err(format!("claude 로그인을 띄우지 못했다: {e}"));
            }
        };
        let login_id = new_login_id();
        let stdin = child.stdin.take();
        let stdout = child.stdout.take();
        table.insert(
            login_id.clone(),
            Login {
                child,
                stdin,
                slot,
                settled: false,
            },
        );
        drop(table);

        // 거두는 스레드를 **먼저** 띄운다 — 그 뒤 무엇이 실패해도 자식이 아무도 안 지켜보는 채로 남지 않는다.
        {
            let me = self.clone();
            let id = login_id.clone();
            let (pool, account) = (pool.to_string(), account.to_string());
            std::thread::spawn(move || me.reap(&id, &config_dir, created, &pool, &account));
        }
        if let Some(out) = stdout {
            let me = self.clone();
            let id = login_id.clone();
            std::thread::spawn(move || me.watch_url(&id, out));
        }
        Ok(login_id)
    }

    fn watch_url(&self, id: &str, mut out: ChildStdout) {
        let mut buf = String::new();
        let mut raw = Vec::new();
        let mut chunk = [0u8; 4096];
        let mut sent = false;
        loop {
            let n = match out.read(&mut chunk) {
                Ok(0) | Err(_) => return,
                Ok(n) => n,
            };
            // URL 을 낸 뒤에도 끝까지 읽어 버린다 — 파이프가 차서 자식이 서지 않게.
            if sent || raw.len() > URL_BUFFER_CAP {
                continue;
            }
            raw.extend_from_slice(&chunk[..n]);
            buf.clear();
            buf.push_str(&String::from_utf8_lossy(&raw));
            if let Some(url) = find_login_url(&buf) {
                sent = true;
                raw.clear();
                Self::emit(&self.inner, json!({ "loginId": id, "url": url }));
            }
        }
    }

    fn reap(&self, id: &str, config_dir: &Path, created: bool, pool: &str, account: &str) {
        let code = loop {
            {
                let mut table = self.table();
                let Some(l) = table.get_mut(id) else { return };
                match l.child.try_wait() {
                    Ok(Some(st)) => {
                        l.settled = true;
                        l.stdin = None;
                        break st.code();
                    }
                    Ok(None) => {}
                    Err(_) => {
                        l.settled = true;
                        break None;
                    }
                }
            }
            std::thread::sleep(REAP_POLL);
        };
        // 종료 코드만으로는 성패를 모른다 — 다시 잰다.
        let status = (self.inner.status)(config_dir);
        let logged_in = status.get("loggedIn") == Some(&Value::Bool(true));
        if !logged_in && created {
            // 뿌리 아래이고 심링크를 지나지 않는 경로만 지운다.
            if let Ok(p) = under_no_symlink(&self.inner.root, &[pool, account]) {
                let _ = fs::remove_dir_all(p);
            }
        }
        if logged_in
            && created
            && let Err(e) =
                update_pool_order(&self.inner.pools_path, |o| append_to(o, pool, account))
        {
            eprintln!("[claudeAccounts] 순서 기록 실패(로그인은 성공): {e}");
        }
        if logged_in {
            let _ = fs::remove_file(config_dir.join(ATTENTION_FILE));
            let _ = fs::remove_file(config_dir.join(AUTH_FILE));
            if let Err(e) = mark_account_gates(config_dir) {
                eprintln!("[claudeAccounts] 계정 관문 기록 실패(로그인은 성공): {e}");
            }
            if let Some(cb) = self.inner.on_signed_in.get() {
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| cb(config_dir)));
            }
        }
        let mut ev = Map::new();
        ev.insert("loginId".into(), Value::from(id));
        ev.insert("done".into(), Value::Bool(true));
        ev.insert("status".into(), status);
        if !logged_in {
            let c = code.map_or_else(|| "없음".to_string(), |c| c.to_string());
            ev.insert(
                "error".into(),
                Value::from(format!(
                    "로그인이 끝나지 않았다 (종료 코드 {c}) — 다시 시도해라"
                )),
            );
        }
        Self::emit(&self.inner, Value::Object(ev));
        self.table().remove(id);
    }

    /// TS `loginSubmit` — 진행 중이 아니면 거절(조용히 무시하면 사람이 영원히 기다린다). 첫 줄만 보낸다.
    pub fn submit(&self, id: &str, code: &str) -> Result<(), String> {
        let mut table = self.table();
        let Some(l) = table.get_mut(id).filter(|l| !l.settled) else {
            return Err(format!("진행 중인 로그인이 아니다: {id}"));
        };
        if let Some(stdin) = l.stdin.as_mut() {
            let line = format!("{}\n", first_line(code));
            let _ = stdin.write_all(line.as_bytes());
            let _ = stdin.flush();
        }
        Ok(())
    }

    /// TS `loginCancel` — 끝난 것은 조용히 지나간다(브라우저 닫기와 경합하는 정상 상황). TERM 뒤 유예가 지나면 KILL.
    pub fn cancel(&self, id: &str) {
        {
            let table = self.table();
            let Some(l) = table.get(id).filter(|l| !l.settled) else {
                return;
            };
            signal(&l.child, libc::SIGTERM);
        }
        let me = self.clone();
        let id = id.to_string();
        let grace = self.inner.kill_grace;
        std::thread::spawn(move || {
            std::thread::sleep(grace);
            let table = me.table();
            if let Some(l) = table.get(&id).filter(|l| !l.settled) {
                signal(&l.child, libc::SIGKILL);
            }
        });
    }

    /// TS `shutdownLogins` — 러너와 달리 살려 두지 않는다(코드를 받을 프로세스가 없으면 고아가 된다).
    pub fn shutdown(&self) {
        let mut table = self.table();
        for l in table.values_mut() {
            if l.settled {
                continue;
            }
            signal(&l.child, libc::SIGTERM);
            signal(&l.child, libc::SIGKILL);
            let _ = l.child.wait();
            l.settled = true;
        }
        table.clear();
    }

    /// 시험용 — 진행 중인 로그인 수.
    pub fn live(&self) -> usize {
        self.table().values().filter(|l| !l.settled).count()
    }
}

/// TS `readLoginRef`.
pub fn read_login_ref(payload: Option<&Value>) -> Result<String, String> {
    let obj = payload
        .and_then(Value::as_object)
        .ok_or("payload 가 객체가 아니다")?;
    match obj.get("loginId").and_then(Value::as_str) {
        Some(s) if !s.is_empty() => Ok(s.to_string()),
        _ => Err("loginId 가 없다".into()),
    }
}

/// TS `readLoginSubmit` — 코드는 짧다. 4096 을 넘기면 코드가 아니다.
pub fn read_login_submit(payload: Option<&Value>) -> Result<(String, String), String> {
    let id = read_login_ref(payload)?;
    let code = match payload.and_then(|p| p.get("code")).and_then(Value::as_str) {
        Some(s) if !s.is_empty() => s,
        _ => return Err("code 가 없다".into()),
    };
    // TS `code.length` 는 UTF-16 단위다. 코드는 ASCII 라 바이트로 재도 같은 자리에서 끊긴다.
    if code.encode_utf16().count() > MAX_CODE_LEN {
        return Err("code 가 너무 길다".into());
    }
    Ok((id, code.to_string()))
}

#[cfg(test)]
mod tests;
