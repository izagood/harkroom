//! 머지 래퍼의 gh 계정(S2 A5b) — `operatorMergeGet`·`operatorMergeSet`·`operatorMergeCheck`.
//! 정본은 `packages/operator/src/localMerge.ts`, 요청 검사는 `packages/shared/src/daemonProtocol.ts`
//! (`readOperatorMergeSetPayload`·`readOperatorMergeCheckPayload`), gh env 는 `turnMerge.ts::ghEnv` 다.
//!
//! 값은 커뮤니티 뿌리의 `operator/operator.json` 의 `merge`(`ghUser` 옛 기기 기본값 · `byScope` 줄별 계정)에 둔다.
//! 파일 읽기·쓰기는 A5a 의 `LocalAgents` 와 같은 길(P5 잠금 + 0600 임시 파일 rename)이다.
//!
//! 지키는 것(TS 와 같다):
//! - **자동으로 정하지 않는다** — 처음 값은 비어 있고 사람이 고른다(security P1).
//! - **목록에 있는 이름만 받는다**(C7) — set 할 때 `gh auth status` 를 다시 물어 그 순간 로그인된 이름인지 본다.
//! - gh 에는 인자 배열로만 넘기고 env 는 상속하지 않는다(`gh_env`). `--show-token` 은 쓰지 않는다.
//! - 닿음 확인은 10분 캐시. 캐시에는 결과만 두고 토큰은 담지 않는다.
//!
//! TS 와 다른 곳(일부러):
//! - 고르기(`set`)의 읽고-고치고-쓰기를 잠금 안에서 한다. gh 로그인 확인은 잠금 **밖에서 먼저** 한다(gh 를 기다리며
//!   잠금을 쥐지 않게).
//! - 깨진 `operator.json` 에는 쓰지 않는다(A5a 와 같다) — `internal` 로 거절한다. TS 는 빈 설정으로 덮는다.
//!   설정 파일 읽기·쓰기 실패는 `internal`, gh 확인 실패·목록에 없는 이름은 TS 처럼 `bad-payload` 다.
//! - 닿음 확인(`check`)에서 한 계정의 토큰은 그 요청 안에서 한 번만 꺼낸다(TS 는 범위마다 꺼낸다). 요청이 끝나면 버린다.
//!   동시에 도는 gh 는 8개까지다.
use crate::local_agents::LocalAgents;
use harkroom_proto::p3::{DaemonError, DaemonErrorCode};
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// 닿음 확인 캐시 수명(TS `REACH_TTL_MS`).
pub const REACH_TTL_MS: u64 = 10 * 60_000;
/// gh 한 번의 시간 제한·출력 상한(TS `defaultExec` 의 `timeout`·`maxBuffer`).
const EXEC_TIMEOUT: Duration = Duration::from_secs(120);
const EXEC_MAX_BYTES: usize = 4 * 1024 * 1024;
/// `check` 에서 동시에 도는 gh 수.
const CHECK_PARALLEL: usize = 8;

/// TS `GH_PATH` 와 같은 순서. 셸 PATH 를 믿지 않는다.
pub fn default_gh_path() -> String {
    ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"]
        .into_iter()
        .find(|p| std::path::Path::new(p).exists())
        .unwrap_or("/usr/local/bin/gh")
        .to_string()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecResult {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// gh 를 부르는 길(시험에서 바꾼다). 인자는 (실행 파일, 인자, env).
pub type Exec = Arc<dyn Fn(&str, &[String], &[(String, String)]) -> ExecResult + Send + Sync>;

/// TS `defaultExec`: env 를 비우고 받은 것만 넣는다. 실행 못 하면 code 1 과 까닭.
pub fn default_exec() -> Exec {
    Arc::new(|file: &str, args: &[String], env: &[(String, String)]| {
        let mut cmd = Command::new(file);
        cmd.args(args)
            .env_clear()
            .envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                return ExecResult {
                    code: 1,
                    stdout: String::new(),
                    stderr: format!("spawn {file}: {e}"),
                };
            }
        };
        let read = |r: Option<Box<dyn Read + Send>>| {
            std::thread::spawn(move || {
                let mut buf = Vec::new();
                if let Some(r) = r {
                    let _ = r.take(EXEC_MAX_BYTES as u64).read_to_end(&mut buf);
                }
                String::from_utf8_lossy(&buf).into_owned()
            })
        };
        let out = read(
            child
                .stdout
                .take()
                .map(|s| Box::new(s) as Box<dyn Read + Send>),
        );
        let err = read(
            child
                .stderr
                .take()
                .map(|s| Box::new(s) as Box<dyn Read + Send>),
        );
        let deadline = Instant::now() + EXEC_TIMEOUT;
        let status = loop {
            match child.try_wait() {
                Ok(Some(s)) => break Some(s),
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(20))
                }
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break None;
                }
            }
        };
        let stdout = out.join().unwrap_or_default();
        let mut stderr = err.join().unwrap_or_default();
        let code = match status {
            Some(s) => s.code().unwrap_or(1),
            None => {
                stderr.push_str("\n(timed out)");
                1
            }
        };
        ExecResult {
            code,
            stdout,
            stderr,
        }
    })
}

/// TS `ghEnv` — 대상을 바꾸는 변수(`GH_REPO`·`GH_HOST`)는 들어올 자리가 없다.
pub fn gh_env(home: &str, token: Option<&str>) -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = [
        ("HOME", home),
        ("PATH", "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin"),
        ("GH_PROMPT_DISABLED", "1"),
        ("GH_NO_UPDATE_NOTIFIER", "1"),
        ("NO_COLOR", "1"),
        ("GH_PAGER", "cat"),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect();
    if let Some(t) = token.filter(|t| !t.is_empty()) {
        env.push(("GH_TOKEN".into(), t.to_string()));
    }
    env
}

/// `GH_LOGIN_RE` = `^[A-Za-z0-9-]{1,39}$`.
pub fn is_gh_login(s: &str) -> bool {
    (1..=39).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// `MERGE_SCOPE_RE` = `^[a-z0-9][a-z0-9._-]{0,99}\/(?:\*|[a-z0-9._-]{1,100})$`(소문자로 바꾼 뒤 잰다).
pub fn is_merge_scope(s: &str) -> bool {
    let Some((owner, name)) = s.split_once('/') else {
        return false;
    };
    let part =
        |b: u8| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'_' | b'-');
    let ob = owner.as_bytes();
    let owner_ok = (1..=100).contains(&ob.len())
        && (ob[0].is_ascii_lowercase() || ob[0].is_ascii_digit())
        && ob.iter().all(|&b| part(b));
    let name_ok = name == "*" || ((1..=100).contains(&name.len()) && name.bytes().all(part));
    owner_ok && name_ok
}

/// TS `readMergeScope`.
fn read_merge_scope(v: &Value) -> Option<String> {
    let s = v.as_str()?.to_lowercase();
    is_merge_scope(&s).then_some(s)
}

fn bad(message: impl Into<String>) -> DaemonError {
    DaemonError {
        code: DaemonErrorCode::BadPayload,
        message: message.into(),
    }
}

/// TS `OperatorMergeSetPayload`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MergeSet {
    /// 옛 기기 기본값(`merge.ghUser`).
    Legacy(Option<String>),
    /// 줄 하나의 계정. `None` 은 그 줄의 지정을 지운다.
    Scope(String, Option<String>),
    /// 옛 `merge.ghUser` 를 이 줄들에 한 번 복사하고 지운다.
    Migrate(Vec<String>),
}

fn read_scopes(v: Option<&Value>, what: &str, label: &str) -> Result<Vec<String>, DaemonError> {
    let Some(Value::Array(items)) = v else {
        return Err(bad(what));
    };
    if items.len() > 200 {
        return Err(bad(what));
    }
    let mut out: Vec<String> = Vec::new();
    for item in items {
        let s = read_merge_scope(item).ok_or_else(|| {
            bad(format!(
                "{label} 의 항목은 owner/name 이나 owner/* 여야 한다"
            ))
        })?;
        if !out.contains(&s) {
            out.push(s);
        }
    }
    Ok(out)
}

/// TS `readOperatorMergeSetPayload`.
pub fn read_set_payload(payload: Option<&Value>) -> Result<MergeSet, DaemonError> {
    let Some(Value::Object(p)) = payload else {
        return Err(bad("operatorMergeSet 에는 ghUser 나 migrate 가 필요하다"));
    };
    if p.contains_key("migrate") {
        return read_scopes(
            p.get("migrate"),
            "migrate 는 범위 배열이어야 한다(200개까지)",
            "migrate",
        )
        .map(MergeSet::Migrate);
    }
    let Some(gh) = p.get("ghUser") else {
        return Err(bad(
            "operatorMergeSet 에는 ghUser 가 필요하다(지우려면 null)",
        ));
    };
    let gh_user = match gh {
        Value::Null => None,
        Value::String(s) if is_gh_login(s) => Some(s.clone()),
        _ => return Err(bad("ghUser 는 GitHub 로그인 이름이어야 한다")),
    };
    match p.get("scope") {
        None => Ok(MergeSet::Legacy(gh_user)),
        Some(v) => read_merge_scope(v)
            .map(|s| MergeSet::Scope(s, gh_user))
            .ok_or_else(|| bad("scope 는 owner/name 이나 owner/* 여야 한다")),
    }
}

/// TS `readOperatorMergeCheckPayload`.
pub fn read_check_payload(payload: Option<&Value>) -> Result<Vec<String>, DaemonError> {
    let what = "operatorMergeCheck 에는 scopes 배열이 필요하다(200개까지)";
    match payload {
        Some(Value::Object(p)) => read_scopes(p.get("scopes"), what, "scopes"),
        _ => Err(bad(what)),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reach {
    Ok,
    No,
    Unknown,
}

impl Reach {
    pub fn as_str(self) -> &'static str {
        match self {
            Reach::Ok => "ok",
            Reach::No => "no",
            Reach::Unknown => "unknown",
        }
    }
}

/// TS `reachFromGh` — 한 계정이 한 범위에 닿는가(머지에는 쓰기 권한이 필요하다).
pub fn reach_from_gh(scope: &str, login: &str, r: &ExecResult) -> Reach {
    let (owner, name) = scope.split_once('/').unwrap_or((scope, ""));
    if name == "*" && owner == login.to_lowercase() {
        return Reach::Ok;
    }
    if r.code != 0 {
        let e = r.stderr.to_lowercase();
        return if e.contains("http 404") || e.contains("not found") {
            Reach::No
        } else {
            Reach::Unknown
        };
    }
    let Ok(body) = serde_json::from_str::<Value>(&r.stdout) else {
        return Reach::Unknown;
    };
    if name == "*" {
        return if body.get("state").and_then(Value::as_str) == Some("active") {
            Reach::Ok
        } else {
            Reach::No
        };
    }
    let Some(perms) = body.get("permissions").and_then(Value::as_object) else {
        return Reach::Unknown;
    };
    let yes = |k: &str| perms.get(k) == Some(&Value::Bool(true));
    if yes("push") || yes("maintain") || yes("admin") {
        Reach::Ok
    } else {
        Reach::No
    }
}

/// TS `parseGhAccounts` — `gh auth status --json hosts` 의 github.com 항목에서 이름·활성 여부만 뽑는다.
pub fn parse_gh_accounts(stdout: &str) -> Option<Vec<(String, bool)>> {
    let parsed: Value = serde_json::from_str(stdout).ok()?;
    let hosts = parsed.get("hosts")?.as_object()?;
    let Some(list) = hosts.get("github.com") else {
        return Some(Vec::new());
    };
    let list = list.as_array()?;
    let mut out: Vec<(String, bool)> = Vec::new();
    for a in list {
        let Some(login) = a.get("login").and_then(Value::as_str) else {
            continue;
        };
        if !is_gh_login(login) || out.iter().any(|(l, _)| l == login) {
            continue;
        }
        out.push((
            login.to_string(),
            a.get("active") == Some(&Value::Bool(true)),
        ));
    }
    Some(out)
}

/// TS `legacyOf`.
pub fn legacy_of(merge: Option<&Value>) -> Option<String> {
    let v = merge?.get("ghUser")?.as_str()?;
    is_gh_login(v).then(|| v.to_string())
}

/// TS `byScopeOf` — 모양이 아닌 항목은 버린다. 칸이 없으면 `None`(아직 옮기기 전).
pub fn by_scope_of(merge: Option<&Value>) -> Option<Map<String, Value>> {
    let v = merge?.get("byScope")?.as_object()?;
    let mut out = Map::new();
    for (k, login) in v {
        let sc = k.to_lowercase();
        if let Some(l) = login.as_str()
            && is_merge_scope(&sc)
            && is_gh_login(l)
        {
            out.insert(sc, Value::String(l.to_string()));
        }
    }
    Some(out)
}

/// 바뀐 줄 하나 — 소켓 쪽이 로그에 남긴다(security C8). 이름뿐이다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MergeChange {
    pub scope: Option<String>,
    pub from: Option<String>,
    pub to: Option<String>,
}

type Accounts = Result<Vec<(String, bool)>, String>;

pub struct LocalMerge {
    config: LocalAgents,
    gh_path: String,
    home: String,
    host: String,
    exec: Exec,
    now_ms: Arc<dyn Fn() -> u64 + Send + Sync>,
    /// 키는 (scope, login). 토큰은 담지 않는다.
    reach_cache: Mutex<HashMap<(String, String), (Reach, u64)>>,
}

fn system_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// TS `os.hostname()`.
pub fn hostname() -> String {
    let mut buf = [0u8; 256];
    // SAFETY: 버퍼 길이를 함께 넘긴다. 실패하면 빈 이름.
    let rc = unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) };
    if rc != 0 {
        return String::new();
    }
    let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
    String::from_utf8_lossy(&buf[..end]).into_owned()
}

/// `new Date(ms).toISOString()` 꼴(`2026-11-10T15:37:29.123Z`).
pub fn iso_from_ms(ms: u64) -> String {
    let secs = ms / 1000;
    let (days, rem) = (secs / 86_400, secs % 86_400);
    // Howard Hinnant 의 civil_from_days.
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60,
        ms % 1000
    )
}

impl LocalMerge {
    pub fn new(config: LocalAgents, gh_path: String, home: String) -> Self {
        Self::with_deps(
            config,
            gh_path,
            home,
            hostname(),
            default_exec(),
            Arc::new(system_now_ms),
        )
    }

    pub fn with_deps(
        config: LocalAgents,
        gh_path: String,
        home: String,
        host: String,
        exec: Exec,
        now_ms: Arc<dyn Fn() -> u64 + Send + Sync>,
    ) -> Self {
        LocalMerge {
            config,
            gh_path,
            home,
            host,
            exec,
            now_ms,
            reach_cache: Mutex::new(HashMap::new()),
        }
    }

    pub fn host(&self) -> &str {
        &self.host
    }

    fn gh(&self, args: &[&str], token: Option<&str>) -> ExecResult {
        let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
        (self.exec)(&self.gh_path, &args, &gh_env(&self.home, token))
    }

    fn accounts(&self) -> Accounts {
        // 토큰 없는 env — 상속한 GH_TOKEN 이 목록에 끼어들면 고를 수 없는 가짜 항목이 생긴다.
        let r = self.gh(&["auth", "status", "--json", "hosts"], None);
        // 로그인 하나가 만료돼도 gh 는 0 이 아닌 코드로 끝나며 JSON 은 낸다 — 코드보다 JSON 을 믿는다.
        if let Some(list) = parse_gh_accounts(&r.stdout) {
            return Ok(list);
        }
        let trimmed = r.stderr.trim();
        let why: String = if trimmed.is_empty() {
            format!("exit {}", r.code)
        } else {
            trimmed.chars().take(200).collect()
        };
        Err(format!("gh auth status failed: {why}"))
    }

    fn state(&self, merge: Option<&Value>, a: &Accounts) -> Value {
        let mut out = Map::new();
        out.insert(
            "ghUser".into(),
            legacy_of(merge).map_or(Value::Null, Value::String),
        );
        out.insert(
            "byScope".into(),
            by_scope_of(merge).map_or(Value::Null, Value::Object),
        );
        out.insert("host".into(), Value::String(self.host.clone()));
        match a {
            Ok(list) => {
                let accts: Vec<Value> = list
                    .iter()
                    .map(|(login, active)| json!({ "login": login, "active": active }))
                    .collect();
                out.insert("accounts".into(), Value::Array(accts));
            }
            Err(e) => {
                out.insert("accounts".into(), Value::Null);
                out.insert("accountsError".into(), Value::String(e.clone()));
            }
        }
        Value::Object(out)
    }

    /// `operatorMergeGet`.
    pub fn get(&self) -> Result<Value, DaemonError> {
        let config = self.config.read_config()?;
        let a = self.accounts();
        Ok(self.state(config.get("merge"), &a))
    }

    /// `operatorMergeSet`. 목록에 없는 이름·gh 실패는 `bad-payload`(TS 와 같은 문구).
    pub fn set(&self, p: &MergeSet) -> Result<(Value, Vec<MergeChange>), DaemonError> {
        let want = match p {
            MergeSet::Legacy(Some(u)) | MergeSet::Scope(_, Some(u)) => Some(u.as_str()),
            _ => None,
        };
        let mut a: Option<Accounts> = None;
        if let Some(login) = want {
            let got = self.accounts();
            match &got {
                Err(e) => return Err(bad(e.clone())),
                Ok(list) if !list.iter().any(|(l, _)| l == login) => {
                    return Err(bad(format!(
                        "{login} is not logged in to gh on this machine"
                    )));
                }
                Ok(_) => {}
            }
            a = Some(got);
        }
        let mut changes = Vec::new();
        let mut after: Option<Value> = None;
        self.config.modify_config(|config| {
            let before = config.get("merge").cloned();
            let mut next = match &before {
                Some(Value::Object(m)) => m.clone(),
                _ => Map::new(),
            };
            match p {
                MergeSet::Migrate(scopes) => {
                    // 한 번만: byScope 가 이미 있으면 옮긴 것이다.
                    if by_scope_of(before.as_ref()).is_none() {
                        let legacy = legacy_of(before.as_ref());
                        let mut by_scope = Map::new();
                        if let Some(l) = &legacy {
                            for sc in scopes {
                                by_scope.insert(sc.clone(), Value::String(l.clone()));
                                changes.push(MergeChange {
                                    scope: Some(sc.clone()),
                                    from: None,
                                    to: Some(l.clone()),
                                });
                            }
                        }
                        next.insert("byScope".into(), Value::Object(by_scope));
                        next.shift_remove("ghUser");
                        if let Some(l) = legacy {
                            changes.push(MergeChange {
                                scope: None,
                                from: Some(l),
                                to: None,
                            });
                        }
                    }
                }
                MergeSet::Scope(scope, gh_user) => {
                    // 줄을 고르는 것 자체가 옮김이다 — byScope 가 생기면 옛 기본값은 더 읽지 않는다.
                    let mut by_scope = by_scope_of(before.as_ref()).unwrap_or_default();
                    let from = by_scope
                        .get(scope)
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    match gh_user {
                        None => {
                            by_scope.shift_remove(scope);
                        }
                        Some(u) => {
                            by_scope.insert(scope.clone(), Value::String(u.clone()));
                        }
                    }
                    next.insert("byScope".into(), Value::Object(by_scope));
                    if from != *gh_user {
                        changes.push(MergeChange {
                            scope: Some(scope.clone()),
                            from,
                            to: gh_user.clone(),
                        });
                    }
                }
                MergeSet::Legacy(gh_user) => {
                    let from = legacy_of(before.as_ref());
                    match gh_user {
                        None => {
                            next.shift_remove("ghUser");
                        }
                        Some(u) => {
                            next.insert("ghUser".into(), Value::String(u.clone()));
                        }
                    }
                    if from != *gh_user {
                        changes.push(MergeChange {
                            scope: None,
                            from,
                            to: gh_user.clone(),
                        });
                    }
                }
            }
            let next = Value::Object(next);
            let empty = next.as_object().is_some_and(Map::is_empty);
            let changed = before.clone().unwrap_or_else(|| json!({})) != next;
            if empty {
                config.shift_remove("merge");
            } else {
                config.insert("merge".into(), next.clone());
            }
            after = (!empty).then_some(next);
            Ok(changed)
        })?;
        let a = a.unwrap_or_else(|| self.accounts());
        Ok((self.state(after.as_ref(), &a), changes))
    }

    fn reach_of(
        &self,
        scope: &str,
        login: &str,
        token: &dyn Fn() -> Option<String>,
    ) -> (Reach, u64) {
        let key = (scope.to_string(), login.to_string());
        let now = (self.now_ms)();
        if let Some(&(r, at)) = self
            .reach_cache
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(&key)
            && now.saturating_sub(at) < REACH_TTL_MS
        {
            return (r, at);
        }
        let (owner, name) = scope.split_once('/').unwrap_or((scope, ""));
        let status = if name == "*" && owner == login.to_lowercase() {
            Reach::Ok
        } else {
            match token() {
                None => Reach::Unknown,
                Some(t) => {
                    // 경로는 MERGE_SCOPE_RE 를 지난 범위로만 짓는다 — 웹뷰가 다른 API 를 고를 자리가 없다.
                    let path = if name == "*" {
                        format!("user/memberships/orgs/{owner}")
                    } else {
                        format!("repos/{owner}/{name}")
                    };
                    reach_from_gh(scope, login, &self.gh(&["api", &path], Some(&t)))
                }
            }
        };
        let v = (status, (self.now_ms)());
        self.reach_cache
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(key, v);
        v
    }

    /// `operatorMergeCheck` — 범위마다, 지금 로그인된 계정마다 닿는지. gh 목록을 못 읽으면 빈 `reach`.
    pub fn check(&self, scopes: &[String]) -> Value {
        let Ok(accounts) = self.accounts() else {
            return json!({ "reach": {} });
        };
        // 계정마다 토큰을 이 요청 안에서 한 번만 꺼낸다(캐시가 받치면 아예 꺼내지 않는다).
        let tokens: HashMap<String, Mutex<Option<Option<String>>>> = accounts
            .iter()
            .map(|(l, _)| (l.clone(), Mutex::new(None)))
            .collect();
        let token_for = |login: &str| -> Option<String> {
            let slot = tokens.get(login)?;
            let mut g = slot.lock().unwrap_or_else(|p| p.into_inner());
            if g.is_none() {
                let r = self.gh(&["auth", "token", "-u", login], None);
                let t = r.stdout.trim().to_string();
                *g = Some((r.code == 0 && !t.is_empty()).then_some(t));
            }
            g.clone().flatten()
        };
        let pairs: Vec<(&String, &String)> = scopes
            .iter()
            .flat_map(|s| accounts.iter().map(move |(l, _)| (s, l)))
            .collect();
        let mut results: Vec<(String, String, Reach, u64)> = Vec::with_capacity(pairs.len());
        for chunk in pairs.chunks(CHECK_PARALLEL) {
            std::thread::scope(|sc| {
                let handles: Vec<_> = chunk
                    .iter()
                    .map(|&(scope, login)| {
                        let token_for = &token_for;
                        sc.spawn(move || {
                            let (r, at) = self.reach_of(scope, login, &|| token_for(login));
                            (scope.clone(), login.clone(), r, at)
                        })
                    })
                    .collect();
                for h in handles {
                    if let Ok(v) = h.join() {
                        results.push(v);
                    }
                }
            });
        }
        let mut reach = Map::new();
        for (scope, login, r, at) in results {
            let row = reach
                .entry(scope)
                .or_insert_with(|| Value::Object(Map::new()));
            if let Some(m) = row.as_object_mut() {
                m.insert(
                    login,
                    json!({ "status": r.as_str(), "checkedAt": iso_from_ms(at) }),
                );
            }
        }
        json!({ "reach": reach })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn ok(stdout: &str) -> ExecResult {
        ExecResult {
            code: 0,
            stdout: stdout.into(),
            stderr: String::new(),
        }
    }

    const STATUS: &str = r#"{"hosts":{"github.com":[{"login":"alice","active":true,"token":"x"},{"login":"bob","active":false},{"login":"bad name"},{"login":"alice"}],"ghe.example.com":[{"login":"carol"}]}}"#;

    type Calls = Arc<Mutex<Vec<(Vec<String>, Option<String>)>>>;

    struct Fake {
        calls: Calls,
        now: Arc<AtomicU64>,
    }

    fn fake(root: &std::path::Path) -> (LocalMerge, Fake) {
        let calls: Calls = Arc::default();
        let now = Arc::new(AtomicU64::new(1_700_000_000_000));
        let c = calls.clone();
        let exec: Exec = Arc::new(move |_f, args, env| {
            let tok = env
                .iter()
                .find(|(k, _)| k == "GH_TOKEN")
                .map(|(_, v)| v.clone());
            c.lock().unwrap().push((args.to_vec(), tok.clone()));
            let a: Vec<&str> = args.iter().map(String::as_str).collect();
            match a.as_slice() {
                ["auth", "status", ..] => ok(STATUS),
                ["auth", "token", "-u", u] => ok(&format!("tok-{u}\n")),
                ["api", "repos/acme/app"] if tok.as_deref() == Some("tok-alice") => {
                    ok(r#"{"permissions":{"pull":true,"push":true}}"#)
                }
                ["api", "repos/acme/app"] => ok(r#"{"permissions":{"pull":true}}"#),
                ["api", "user/memberships/orgs/acme"] => ExecResult {
                    code: 1,
                    stdout: String::new(),
                    stderr: "gh: Not Found (HTTP 404)".into(),
                },
                _ => ExecResult {
                    code: 1,
                    stdout: String::new(),
                    stderr: "boom".into(),
                },
            }
        });
        let n = now.clone();
        let m = LocalMerge::with_deps(
            LocalAgents::new(root.to_str().unwrap(), "https://a.example.com"),
            "/x/gh".into(),
            "/h".into(),
            "mac-1".into(),
            exec,
            Arc::new(move || n.load(Ordering::SeqCst)),
        );
        (m, Fake { calls, now })
    }

    fn tmp() -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!(
            "hk-lm-{}-{}",
            std::process::id(),
            crate::endpoint::random_hex(6).unwrap()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn file(root: &std::path::Path) -> Value {
        serde_json::from_str(&std::fs::read_to_string(root.join("operator/operator.json")).unwrap())
            .unwrap()
    }

    #[test]
    fn regexes_match_ts() {
        assert!(is_gh_login("rebel-jaebin"));
        assert!(!is_gh_login(""));
        assert!(!is_gh_login(&"a".repeat(40)));
        assert!(!is_gh_login("a_b"));
        assert!(is_merge_scope("izagood/*"));
        assert!(is_merge_scope("a.b/c_d-e.f"));
        assert!(!is_merge_scope(".x/y"));
        assert!(!is_merge_scope("x/"));
        assert!(!is_merge_scope("x/y/z"));
        assert!(!is_merge_scope("X/y"));
        assert!(!is_merge_scope("x/**"));
    }

    #[test]
    fn payloads_match_ts() {
        let rd = |v: Value| read_set_payload(Some(&v));
        assert_eq!(rd(json!({"ghUser": null})), Ok(MergeSet::Legacy(None)));
        assert_eq!(
            rd(json!({"scope": "IzaGood/*", "ghUser": "bob"})),
            Ok(MergeSet::Scope("izagood/*".into(), Some("bob".into())))
        );
        assert_eq!(
            rd(json!({"migrate": ["A/b", "a/b", "c/*"]})),
            Ok(MergeSet::Migrate(vec!["a/b".into(), "c/*".into()]))
        );
        assert!(rd(json!({})).is_err());
        assert!(rd(json!({"migrate": null})).is_err());
        assert!(rd(json!({"ghUser": "a b"})).is_err());
        assert!(rd(json!({"ghUser": "a", "scope": null})).is_err());
        assert!(read_set_payload(None).is_err());
        assert!(read_check_payload(Some(&json!({"scopes": ["x/y", "nope"]}))).is_err());
        let many: Vec<String> = (0..201).map(|i| format!("o/r{i}")).collect();
        assert!(read_check_payload(Some(&json!({ "scopes": many }))).is_err());
    }

    #[test]
    fn reach_and_accounts_parsing() {
        let fail = |e: &str| ExecResult {
            code: 1,
            stdout: String::new(),
            stderr: e.into(),
        };
        assert_eq!(reach_from_gh("alice/*", "Alice", &fail("x")), Reach::Ok);
        assert_eq!(reach_from_gh("o/r", "a", &fail("HTTP 404")), Reach::No);
        assert_eq!(reach_from_gh("o/r", "a", &fail("HTTP 403")), Reach::Unknown);
        assert_eq!(
            reach_from_gh("o/*", "a", &ok(r#"{"state":"active"}"#)),
            Reach::Ok
        );
        assert_eq!(
            reach_from_gh("o/*", "a", &ok(r#"{"state":"pending"}"#)),
            Reach::No
        );
        assert_eq!(
            reach_from_gh("o/r", "a", &ok(r#"{"permissions":{"maintain":true}}"#)),
            Reach::Ok
        );
        assert_eq!(reach_from_gh("o/r", "a", &ok(r#"{}"#)), Reach::Unknown);
        assert_eq!(reach_from_gh("o/r", "a", &ok("nope")), Reach::Unknown);
        assert_eq!(
            parse_gh_accounts(STATUS),
            Some(vec![("alice".into(), true), ("bob".into(), false)])
        );
        assert_eq!(parse_gh_accounts(r#"{"hosts":{}}"#), Some(vec![]));
        assert_eq!(parse_gh_accounts("x"), None);
        assert_eq!(iso_from_ms(1_700_000_000_123), "2023-11-14T22:13:20.123Z");
        assert_eq!(iso_from_ms(951_782_400_000), "2000-02-29T00:00:00.000Z");
    }

    #[test]
    fn get_set_migrate_roundtrip() {
        let root = tmp();
        let (m, f) = fake(&root);
        let g = m.get().unwrap();
        assert_eq!(
            g,
            json!({"ghUser":null,"byScope":null,"host":"mac-1","accounts":[{"login":"alice","active":true},{"login":"bob","active":false}]})
        );
        // 목록에 없는 이름은 거절하고 파일을 만들지 않는다.
        let e = m.set(&MergeSet::Legacy(Some("carol".into()))).unwrap_err();
        assert_eq!(e.code, DaemonErrorCode::BadPayload);
        assert_eq!(e.message, "carol is not logged in to gh on this machine");
        assert!(!root.join("operator/operator.json").exists());
        // 옛 기본값 → 옮기기.
        let (_, ch) = m.set(&MergeSet::Legacy(Some("alice".into()))).unwrap();
        assert_eq!(
            ch,
            vec![MergeChange {
                scope: None,
                from: None,
                to: Some("alice".into())
            }]
        );
        let (s, ch) = m
            .set(&MergeSet::Migrate(vec!["acme/app".into(), "acme/*".into()]))
            .unwrap();
        assert_eq!(ch.len(), 3);
        assert_eq!(s["ghUser"], Value::Null);
        assert_eq!(s["byScope"], json!({"acme/app":"alice","acme/*":"alice"}));
        // 두 번째 migrate 는 아무것도 안 한다.
        let (_, ch) = m.set(&MergeSet::Migrate(vec!["x/y".into()])).unwrap();
        assert!(ch.is_empty());
        // 줄 지우기는 gh 를 묻지 않고 바로 쓴다.
        let before = f.calls.lock().unwrap().len();
        let (s, ch) = m.set(&MergeSet::Scope("acme/*".into(), None)).unwrap();
        assert_eq!(
            ch,
            vec![MergeChange {
                scope: Some("acme/*".into()),
                from: Some("alice".into()),
                to: None
            }]
        );
        assert_eq!(s["byScope"], json!({"acme/app":"alice"}));
        let calls = f.calls.lock().unwrap();
        // 그 뒤 state 에 실을 목록 한 번만.
        assert_eq!(calls.len(), before + 1);
        assert!(calls.iter().all(|(a, t)| a[0] == "auth" && t.is_none()));
        drop(calls);
        assert_eq!(
            file(&root)["merge"],
            json!({"byScope":{"acme/app":"alice"}})
        );
        let mode = {
            use std::os::unix::fs::PermissionsExt;
            std::fs::metadata(root.join("operator/operator.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777
        };
        assert_eq!(mode, 0o600);
        // 다른 칸(communities)은 그대로 둔다.
        assert_eq!(file(&root)["communities"], json!({}));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn broken_config_is_not_overwritten() {
        let root = tmp();
        let (m, _f) = fake(&root);
        std::fs::create_dir_all(root.join("operator")).unwrap();
        std::fs::write(root.join("operator/operator.json"), "{oops").unwrap();
        assert_eq!(m.get().unwrap()["byScope"], Value::Null);
        let e = m.set(&MergeSet::Legacy(None)).unwrap_err();
        assert_eq!(e.code, DaemonErrorCode::Internal);
        assert_eq!(
            std::fs::read_to_string(root.join("operator/operator.json")).unwrap(),
            "{oops"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn check_reach_and_cache() {
        let root = tmp();
        let (m, f) = fake(&root);
        let scopes = vec![
            "acme/app".to_string(),
            "acme/*".to_string(),
            "alice/*".to_string(),
        ];
        let r = m.check(&scopes);
        assert_eq!(r["reach"]["acme/app"]["alice"]["status"], "ok");
        assert_eq!(r["reach"]["acme/app"]["bob"]["status"], "no");
        assert_eq!(r["reach"]["acme/*"]["alice"]["status"], "no");
        assert_eq!(r["reach"]["alice/*"]["alice"]["status"], "ok");
        assert_eq!(r["reach"]["alice/*"]["bob"]["status"], "unknown");
        assert_eq!(
            r["reach"]["acme/app"]["alice"]["checkedAt"],
            "2023-11-14T22:13:20.000Z"
        );
        {
            let calls = f.calls.lock().unwrap();
            // 토큰은 계정마다 한 번.
            let tok = calls.iter().filter(|(a, _)| a[1] == "token").count();
            assert_eq!(tok, 2);
            // 토큰은 api 에만 실린다.
            assert!(calls.iter().all(|(a, t)| (a[0] == "api") == t.is_some()));
        }
        // 10분 안은 캐시 — gh 는 목록만 다시 묻는다.
        let n0 = f.calls.lock().unwrap().len();
        f.now.fetch_add(REACH_TTL_MS - 1, Ordering::SeqCst);
        let r2 = m.check(&scopes);
        assert_eq!(
            r2["reach"]["acme/app"]["alice"]["checkedAt"],
            "2023-11-14T22:13:20.000Z"
        );
        assert_eq!(f.calls.lock().unwrap().len(), n0 + 1);
        f.now.fetch_add(1, Ordering::SeqCst);
        let r3 = m.check(&scopes);
        assert_eq!(
            r3["reach"]["acme/app"]["alice"]["checkedAt"],
            "2023-11-14T22:23:20.000Z"
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}
