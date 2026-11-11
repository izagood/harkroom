//! codex 계정 로그인(s21c3c-2). 정본은 `packages/operator/src/codexAccounts.ts` 의 `loginStart`·`loginCancel`·
//! `shutdownLogins`·`onLoginEvent` 다.
//!
//! - `codex login` 을 그 계정의 `CODEX_HOME` 으로 띄운다. codex 는 로컬 콜백 서버를 띄우고 브라우저가 localhost 로
//!   돌아오므로 코드를 붙여 넣는 단계가 **없다** — claude 와 달리 `submit` 이 없다.
//! - 콜백 포트가 하나라 **계정이 달라도 동시에 하나만** 진행한다.
//! - stdout·stderr 를 한 버퍼로 모아 `https://auth.openai.com/…` 을 **끝난 증거(공백·BEL·ESC)가 있을 때만** 한 번 낸다.
//! - 끝나면 종료 코드가 아니라 **디스크 상태를 다시 재서** 성패를 정한다. TS 와 같이 실패해도 디렉터리는 지우지 않는다.
//! - 성공이면 `on_signed_in`(사용량 캐시 잊기 — c3d 에서 잇는다)을 부른다.
//!
//! 자식은 표 잠금 안에서 `try_wait` 로 거두고, 신호도 같은 잠금 안에서 `settled` 를 본 뒤에만 보낸다(claude_login 과 같은 꼴).
//! **URL 은 로그에 적지 않는다.** 앱 소켓 이벤트(`codexLoginOutput`)로만 나가고 서버로는 가지 않는다.
use crate::codex_accounts::under_no_symlink;
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Child;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

/// SIGTERM → SIGKILL 유예(TS `LOGIN_KILL_GRACE_MS`).
pub const LOGIN_KILL_GRACE: Duration = Duration::from_secs(5);
const REAP_POLL: Duration = Duration::from_millis(50);
/// URL 을 찾는 동안 모으는 상한.
const URL_BUFFER_CAP: usize = 64 * 1024;
const URL_PREFIX: &str = "https://auth.openai.com/";

pub type SpawnLogin = Box<dyn Fn(&Path) -> std::io::Result<Child> + Send + Sync>;
pub type StatusOf = Arc<dyn Fn(&Path) -> Value + Send + Sync>;
pub type Listener = Box<dyn Fn(Value) + Send + Sync>;
pub type SignedIn = Box<dyn Fn(&Path) + Send + Sync>;

/// 운영 `spawnLogin` — PATH 의 `codex login` 을 그 계정의 `CODEX_HOME` 으로. TS 와 같이 stdin 은 닫고 두 출력을 읽는다.
pub fn os_spawn_login(codex_home: &Path) -> std::io::Result<Child> {
    std::process::Command::new("codex")
        .arg("login")
        .env("CODEX_HOME", codex_home)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
}

/// TS 정규식 `(https:\/\/auth\.openai\.com\/[^\s\u0007\u001b]+)[\s\u0007\u001b]`.
pub fn find_login_url(buf: &str) -> Option<String> {
    let mut from = 0;
    while let Some(i) = buf[from..].find(URL_PREFIX) {
        let start = from + i;
        let rest = &buf[start + URL_PREFIX.len()..];
        match rest.find(|c: char| c.is_whitespace() || c == '\u{7}' || c == '\u{1b}') {
            // `+` — 접두 뒤에 한 글자 이상. 없으면 정규식처럼 다음 자리에서 다시 찾는다.
            Some(0) => from = start + URL_PREFIX.len(),
            Some(end) => return Some(format!("{URL_PREFIX}{}", &rest[..end])),
            None => return None,
        }
    }
    None
}

struct Login {
    child: Child,
    account: String,
    settled: bool,
}

struct Inner {
    root: PathBuf,
    spawn: SpawnLogin,
    status: StatusOf,
    kill_grace: Duration,
    logins: Mutex<HashMap<String, Login>>,
    listeners: Mutex<Vec<Listener>>,
    on_signed_in: OnceLock<SignedIn>,
}

/// 진행 중인 codex 로그인 표(TS `logins` Map) + 이벤트 듣는 쪽.
#[derive(Clone)]
pub struct CodexLogins {
    inner: Arc<Inner>,
}

/// URL 찾기 상태 — 두 출력이 한 버퍼를 나눠 쓴다(TS `state.buffer`·`urlSent`).
struct UrlScan {
    raw: Vec<u8>,
    sent: bool,
}

fn new_login_id() -> Result<String, String> {
    let mut b = [0u8; 16];
    let hex = crate::endpoint::random_hex(16).map_err(|e| format!("loginId 난수: {e}"))?;
    for (i, x) in b.iter_mut().enumerate() {
        *x = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).unwrap_or(0);
    }
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &h[0..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..32]
    ))
}

fn signal(child: &Child, sig: i32) {
    if let Ok(pid) = i32::try_from(child.id()) {
        // SAFETY: 아직 거두지 않은 내 자식의 pid 다(표 잠금 안에서 `settled` 를 본 뒤에만 부른다).
        unsafe {
            libc::kill(pid, sig);
        }
    }
}

impl CodexLogins {
    pub fn new(root: PathBuf, spawn: SpawnLogin, status: StatusOf, kill_grace: Duration) -> Self {
        Self {
            inner: Arc::new(Inner {
                root,
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

    /// 성공 때 부른다 — TS `usageCache.forget(codexHome)` 자리(c3d 에서 잇는다).
    pub fn set_on_signed_in(&self, cb: SignedIn) {
        let _ = self.inner.on_signed_in.set(cb);
    }

    fn emit(inner: &Inner, e: Value) {
        let ls = inner.listeners.lock().unwrap_or_else(|p| p.into_inner());
        for cb in ls.iter() {
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| cb(e.clone())));
        }
    }

    fn table(&self) -> std::sync::MutexGuard<'_, HashMap<String, Login>> {
        self.inner.logins.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// TS `loginStart`. 돌려주는 것은 `loginId`.
    pub fn start(&self, account: &str) -> Result<String, String> {
        // TS 는 `under`(글자 판정)다. 여기는 계정 칸이 심링크면 거절한다(만들고 자식에게 넘길 자리라 좁힌다).
        let codex_home = under_no_symlink(&self.inner.root, account)?;
        let mut table = self.table();
        if let Some(live) = table.values().find(|l| !l.settled) {
            // 콜백 포트가 하나다 — 계정이 달라도 둘을 동시에 띄우면 뒤의 것이 포트를 못 잡는다.
            return Err(format!("codex 로그인이 이미 진행 중이다: {}", live.account));
        }
        {
            use std::os::unix::fs::DirBuilderExt;
            fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(&codex_home)
                .map_err(|e| format!("계정 디렉터리를 만들지 못했다: {e}"))?;
        }
        let login_id = new_login_id()?;
        let mut child = (self.inner.spawn)(&codex_home)
            .map_err(|e| format!("codex 로그인을 띄우지 못했다: {e}"))?;
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        table.insert(
            login_id.clone(),
            Login {
                child,
                account: account.to_string(),
                settled: false,
            },
        );
        drop(table);

        // 거두는 스레드를 **먼저** 띄운다.
        {
            let me = self.clone();
            let id = login_id.clone();
            std::thread::spawn(move || me.reap(&id, &codex_home));
        }
        let scan = Arc::new(Mutex::new(UrlScan {
            raw: Vec::new(),
            sent: false,
        }));
        if let Some(out) = stdout {
            let (me, id, scan) = (self.clone(), login_id.clone(), scan.clone());
            std::thread::spawn(move || me.watch_url(&id, out, &scan));
        }
        if let Some(err) = stderr {
            let (me, id, scan) = (self.clone(), login_id.clone(), scan);
            std::thread::spawn(move || me.watch_url(&id, err, &scan));
        }
        Ok(login_id)
    }

    fn watch_url(&self, id: &str, mut out: impl Read, scan: &Mutex<UrlScan>) {
        let mut chunk = [0u8; 4096];
        loop {
            let n = match out.read(&mut chunk) {
                Ok(0) | Err(_) => return,
                Ok(n) => n,
            };
            // 낸 뒤에도 끝까지 읽어 버린다 — 파이프가 차서 자식이 서지 않게.
            let url = {
                let mut s = scan.lock().unwrap_or_else(|p| p.into_inner());
                if s.sent || s.raw.len() > URL_BUFFER_CAP {
                    continue;
                }
                s.raw.extend_from_slice(&chunk[..n]);
                let found = find_login_url(&String::from_utf8_lossy(&s.raw));
                if found.is_some() {
                    s.sent = true;
                    s.raw.clear();
                }
                found
            };
            if let Some(url) = url {
                Self::emit(&self.inner, json!({ "loginId": id, "url": url }));
            }
        }
    }

    fn reap(&self, id: &str, codex_home: &Path) {
        let code = loop {
            {
                let mut table = self.table();
                let Some(l) = table.get_mut(id) else { return };
                match l.child.try_wait() {
                    Ok(Some(st)) => {
                        l.settled = true;
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
        let status = (self.inner.status)(codex_home);
        let logged_in = status.get("loggedIn") == Some(&Value::Bool(true));
        if logged_in && let Some(cb) = self.inner.on_signed_in.get() {
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| cb(codex_home)));
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

    /// TS `loginCancel` — 끝난 것은 조용히 지나간다. TERM 뒤 유예가 지나면 KILL.
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

    /// TS `shutdownLogins` — 우리가 죽으면 콜백을 받아 줄 쪽이 없다. 살려 두지 않는다.
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

/// TS `readLoginRef`(claude 와 같은 함수).
pub fn read_login_ref(payload: Option<&Value>) -> Result<String, String> {
    let obj = payload
        .and_then(Value::as_object)
        .ok_or("payload 가 객체가 아니다")?;
    match obj.get("loginId").and_then(Value::as_str) {
        Some(s) if !s.is_empty() => Ok(s.to_string()),
        _ => Err("loginId 가 없다".into()),
    }
}

#[cfg(test)]
mod tests;
