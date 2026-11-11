//! codex 계정의 파일시스템 연산(s21c3c) — TS `operator/src/codexAccounts.ts` 의 목록·지우기·활성 이식.
//!
//! `<root>/<이름>/` 하나가 계정 하나 = 그 계정의 `CODEX_HOME` 이다. 풀은 없고 `active.json`
//! (커뮤니티마다 프로세스 모드면 `<operatorRoot>/codex-active.json`)이 지금 쓸 계정 하나를 가리킨다.
//! writer 는 이 파일 하나이고 러너는 읽기만 한다.
//!
//! 정체(이메일·플랜)는 `auth.json` 의 `id_token` 페이로드에서 읽는다(서명 검증 없음 — 화면 이름표로만 쓴다).
//! 토큰 자체는 이 모듈 밖으로 나가지 않는다. 이메일은 로그에 적지 않는다(계정 이름만).
//!
//! 로그인(`codexAccountLoginStart`·`Cancel`)은 `codex_login`(c3c-2), 사용량은 뒤 PR(c3d).
use base64::Engine;
use serde_json::{Map, Value, json};
use std::fs;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

/// TS `CODEX_ACCOUNT_NAME_PATTERN` = `/^[a-z0-9-]{1,32}$/`. 이 이름은 경로 칸이 된다.
pub fn is_account_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 32
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// TS `parseCodexActive` — 객체가 아니거나 문법이 틀리면 `None`(= 시스템 기본). 던지지 않는다.
pub fn parse_codex_active(raw: &Value) -> Option<String> {
    raw.get("active")
        .and_then(Value::as_str)
        .filter(|s| is_account_name(s))
        .map(str::to_string)
}

/// 러너의 `codexAccountsRoot()` 와 같은 값.
pub fn codex_accounts_root(get: impl Fn(&str) -> Option<String>, home: &str) -> PathBuf {
    match get("HARKROOM_CODEX_ACCOUNTS_DIR") {
        Some(d) => normalize(Path::new(&d)),
        None => Path::new(home)
            .join(".harkroom-agent")
            .join("codex-accounts"),
    }
}

/// 시스템 기본 codex 홈 — 러너의 `sourceCodexHome()` 과 같은 규칙.
pub fn system_codex_home(get: impl Fn(&str) -> Option<String>, home: &str) -> PathBuf {
    match get("CODEX_HOME") {
        Some(d) => normalize(Path::new(&d)),
        None => Path::new(home).join(".codex"),
    }
}

/// TS `codexActiveFilePath`(shared `operatorRoots.ts`) — 스위치가 켜지면 커뮤니티 뿌리 아래 `codex-active.json`.
pub fn active_file_path(
    codex_root: &Path,
    get: impl Fn(&str) -> Option<String>,
) -> Result<PathBuf, String> {
    if get("HARKROOM_OPERATOR_PER_COMMUNITY").as_deref() != Some("1") {
        return Ok(codex_root.join("active.json"));
    }
    match get("HARKROOM_OPERATOR_ROOT") {
        Some(r) if r.starts_with('/') => Ok(normalize(Path::new(&r)).join("codex-active.json")),
        _ => Err(
            "HARKROOM_OPERATOR_PER_COMMUNITY=1 인데 HARKROOM_OPERATOR_ROOT 가 절대 경로가 아니다"
                .into(),
        ),
    }
}

/// `path.resolve` 와 같은 글자 정규화(심링크를 풀지 않는다).
fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// TS `under` — 이름 문법 + 조립 결과가 뿌리 **아래**인지 두 겹으로 잰다.
pub fn under(root: &Path, name: &str) -> Result<PathBuf, String> {
    if !is_account_name(name) {
        return Err(format!(
            "이름이 문법에 맞지 않는다: {} (/^[a-z0-9-]{{1,32}}$/)",
            Value::from(name)
        ));
    }
    let base = normalize(root);
    let target = normalize(&base.join(name));
    if target == base || !target.starts_with(&base) {
        return Err(format!("뿌리 밖의 경로다: {}", target.display()));
    }
    Ok(target)
}

/// 지우기 자리 — `under` 에 더해 계정 칸이 **심링크가 아닌지** 디스크로 본다(#1908 security 지적과 같은 규율,
/// TS 보다 좁다). 심링크면 `rm -rf` 가 뿌리 밖을 지울 수 있다.
pub fn under_no_symlink(root: &Path, name: &str) -> Result<PathBuf, String> {
    let target = under(root, name)?;
    if fs::symlink_metadata(&target).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(format!("심링크 경로는 지우지 않는다: {}", target.display()));
    }
    Ok(target)
}

/// 하위 디렉터리 이름(사전순, 문법에 맞는 것만). 심링크를 따라간다(`stat`) — TS `subdirs` 와 같다.
pub fn subdirs(dir: &Path) -> Vec<String> {
    let Ok(rd) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut names: Vec<String> = rd
        .filter_map(|e| e.ok())
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| is_account_name(n))
        .collect();
    names.sort();
    names
        .into_iter()
        .filter(|n| fs::metadata(dir.join(n)).is_ok_and(|m| m.is_dir()))
        .collect()
}

fn jwt_payload(token: Option<&Value>) -> Option<Map<String, Value>> {
    let part = token?.as_str()?.split('.').nth(1)?;
    if part.is_empty() {
        return None;
    }
    // Buffer.from(_, 'base64url') 처럼 꼬리 `=` 를 받아 준다.
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(part.trim_end_matches('='))
        .ok()?;
    match serde_json::from_slice::<Value>(&bytes).ok()? {
        Value::Object(m) => Some(m),
        _ => None,
    }
}

/// TS `codexStatusFromDisk` — 던지지 않는다. 파일이 있다 ≠ 토큰이 유효하다(화면은 네트워크를 타지 않는다).
pub fn status_from_disk(codex_home: &Path) -> Value {
    let auth_path = codex_home.join("auth.json");
    let not = || json!({ "loggedIn": false });
    let Ok(text) = fs::read_to_string(&auth_path) else {
        return not();
    };
    let Ok(Value::Object(raw)) = serde_json::from_str::<Value>(&text) else {
        return not();
    };
    let Ok(mtime) = fs::metadata(&auth_path).and_then(|m| m.modified()) else {
        return not();
    };
    let tokens = raw.get("tokens").filter(|v| v.is_object());
    let api_key = raw
        .get("OPENAI_API_KEY")
        .and_then(Value::as_str)
        .is_some_and(|s| !s.is_empty());
    if tokens.is_none() && !api_key {
        return not();
    }
    let claims = jwt_payload(tokens.and_then(|t| t.get("id_token")));
    let auth = claims
        .as_ref()
        .and_then(|c| c.get("https://api.openai.com/auth"))
        .filter(|v| v.is_object());
    let email = claims
        .as_ref()
        .and_then(|c| c.get("email"))
        .and_then(Value::as_str);
    let plan = auth
        .and_then(|a| a.get("chatgpt_plan_type"))
        .and_then(Value::as_str);
    let mut out = Map::new();
    out.insert("loggedIn".into(), json!(true));
    out.insert(
        "authMode".into(),
        json!(if tokens.is_some() {
            "chatgpt"
        } else {
            "apikey"
        }),
    );
    if let Some(e) = email {
        out.insert("email".into(), json!(e));
    }
    if let Some(p) = plan {
        out.insert("plan".into(), json!(p));
    }
    if let Ok(d) = mtime.duration_since(UNIX_EPOCH) {
        out.insert(
            "signedInAtMs".into(),
            json!((d.as_secs_f64() * 1000.0).round() as u64),
        );
    }
    Value::Object(out)
}

fn logged_in(status: &Value) -> bool {
    status["loggedIn"].as_bool() == Some(true)
}

fn mkdir_700(p: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    fs::DirBuilder::new().recursive(true).mode(0o700).create(p)
}

/// 상태 읽기를 끼울 수 있다(시험).
pub type StatusFn = Box<dyn Fn(&Path) -> Value + Send + Sync>;

pub struct CodexAccounts {
    root: PathBuf,
    system_home: PathBuf,
    active_path: PathBuf,
    status: StatusFn,
}

impl CodexAccounts {
    pub fn new(root: PathBuf, system_home: PathBuf, active_path: PathBuf) -> Self {
        Self::with(root, system_home, active_path, Box::new(status_from_disk))
    }

    pub fn with(
        root: PathBuf,
        system_home: PathBuf,
        active_path: PathBuf,
        status: StatusFn,
    ) -> Self {
        Self {
            root,
            system_home,
            active_path,
            status,
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// 시스템 기본 로그인(`~/.codex`) — 사용량 요청의 `''` 계정.
    pub fn system_home(&self) -> &Path {
        &self.system_home
    }

    /// 깨졌거나 없으면 `None`(러너와 같은 판정).
    pub fn read_active(&self) -> Option<String> {
        let text = fs::read_to_string(&self.active_path).ok()?;
        parse_codex_active(&serde_json::from_str::<Value>(&text).ok()?)
    }

    /// 임시 파일(O_EXCL·0600) + rename. 실패하면 임시 파일을 지운다.
    fn write_active(&self, active: Option<&str>) -> std::io::Result<()> {
        if let Some(dir) = self.active_path.parent() {
            mkdir_700(dir)?;
        }
        let suffix = crate::endpoint::random_hex(16)?;
        let mut tmp = self.active_path.as_os_str().to_owned();
        tmp.push(format!(".tmp-{suffix}"));
        let tmp = PathBuf::from(tmp);
        let mut text = serde_json::to_string_pretty(&json!({ "active": active }))
            .map_err(|e| std::io::Error::other(e.to_string()))?;
        text.push('\n');
        let res = (|| {
            let mut f = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&tmp)?;
            f.write_all(text.as_bytes())?;
            f.sync_all()?;
            fs::rename(&tmp, &self.active_path)
        })();
        if res.is_err() {
            let _ = fs::remove_file(&tmp);
        }
        res
    }

    /// TS `list` — 가리킨 계정이 없거나 로그인이 없으면 `active: null`(러너도 그때 시스템으로 떨어진다).
    pub fn list(&self) -> Value {
        let accounts: Vec<(String, Value)> = subdirs(&self.root)
            .into_iter()
            .map(|n| {
                let s = (self.status)(&self.root.join(&n));
                (n, s)
            })
            .collect();
        let active = self
            .read_active()
            .filter(|a| accounts.iter().any(|(n, s)| n == a && logged_in(s)));
        json!({
            "root": self.root.to_string_lossy(),
            "active": active,
            "system": (self.status)(&self.system_home),
            "accounts": accounts
                .into_iter()
                .map(|(name, status)| json!({ "name": name, "status": status }))
                .collect::<Vec<_>>(),
        })
    }

    /// TS `removeAccount` — 활성이면 **먼저** 시스템 기본으로 돌린 뒤 지운다(순서가 반대면 그 사이 뜬 턴이 사라진 계정을 가리킨다).
    pub fn remove_account(&self, account: &str) -> Result<(), String> {
        let dir = under_no_symlink(&self.root, account)?;
        if !fs::symlink_metadata(&dir).is_ok_and(|m| m.is_dir()) {
            return Err(format!("계정이 없다: {account}"));
        }
        if self.read_active().as_deref() == Some(account) {
            self.write_active(None).map_err(|e| e.to_string())?;
        }
        match fs::remove_dir_all(&dir) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }

    /// TS `activate` — 로그인이 없는 계정은 활성으로 만들지 않는다. `None` = 시스템 기본.
    pub fn activate(&self, account: Option<&str>) -> Result<(), String> {
        if let Some(a) = account {
            let s = (self.status)(&under_no_symlink(&self.root, a)?);
            if !logged_in(&s) {
                return Err(format!("로그인되지 않은 계정이다: {a}"));
            }
        }
        self.write_active(account).map_err(|e| e.to_string())
    }
}

fn payload_obj(payload: Option<&Value>) -> Result<&Map<String, Value>, String> {
    payload
        .and_then(Value::as_object)
        .ok_or_else(|| "payload 가 객체가 아니다".to_string())
}

/// TS `readCodexAccountRef`.
pub fn read_account_ref(payload: Option<&Value>) -> Result<String, String> {
    match payload_obj(payload)?.get("account").and_then(Value::as_str) {
        Some(a) if !a.is_empty() => Ok(a.to_string()),
        _ => Err("account 가 없다".into()),
    }
}

/// TS `readCodexActivate` — `account` 가 **빠진 것은 거절**한다(실수로 비운 요청이 활성을 지우면 안 된다).
pub fn read_activate(payload: Option<&Value>) -> Result<Option<String>, String> {
    let obj = payload
        .and_then(Value::as_object)
        .ok_or_else(|| "account 가 없다".to_string())?;
    match obj.get("account") {
        None => Err("account 가 없다".into()),
        Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if !s.is_empty() => Ok(Some(s.clone())),
        Some(_) => Err("account 가 문자열도 null 도 아니다".into()),
    }
}

#[cfg(test)]
mod tests;
