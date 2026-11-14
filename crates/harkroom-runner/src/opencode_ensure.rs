//! opencode·kilo 러너 홈 마련(o1) — 정본 `packages/agent/src/opencodeHome.ts` 의 `ensureOpencodeHome`·`withConfigLock`.
//! 순수 절반(권한 표·이름·MCP 번역·lane 블록·JSONC)은 [`crate::opencode_home`] 에 있고, 여기는 파일을 만지는 절반이다.
//!
//! - 러너 전용 루트(0700) 아래 XDG 셋(config·data·state)을 만든다. 루트는 [`crate::account_lane::ensure_lane_dir`] 와 같은 검사로
//!   만든다 — 링크·폴더 아님·남의 소유면 거절(정본보다 좁다).
//! - 설정 파일을 늘 새로 쓴다(임시 파일 → rename): 사람 설정에서는 `provider`·`model`·`small_model` 만 물려받고, MCP 는 오퍼레이터 표만,
//!   읽기 전용 에이전트 칸을 적는다. lane 러너는 사람 설정·로그인을 물리지 않고 lane 블록·채널 칸만 쓴다.
//! - 로그인은 사람 `auth.json` 을 **링크**로 빌린다(lane 은 링크를 뗀다). 엉뚱한 곳을 가리키는 링크면 실패한다.
//! - lane 러너는 공유 설정 파일의 읽기-고치기-쓰기를 잠금 안에서 한다(security F1).

use std::fs;
use std::io::{self, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value, json};

use crate::adapter::XdgApp;
use crate::opencode_home::{
    LANE_INSTRUCTIONS_FILE, LANE_REPLY_INSTRUCTIONS, OPENCODE_LANE_AGENT, OPENCODE_READONLY_AGENT,
    lane_opencode_bash_table, lane_skill_permission, opencode_config_file, opencode_dirs,
    opencode_lane_agent_name, opencode_lane_home, opencode_lane_permission,
    previous_lane_channel_agents, previous_lane_models, provider_lane_config, runner_skill_names,
    strip_jsonc, to_opencode_mcp,
};

/// 사람 설정에서 물려받는 칸(정본 `INHERITED_KEYS`). `mcp` 는 물려받지 않는다 — 사람 개인 MCP 가 에이전트 턴에 붙는다.
pub const INHERITED_KEYS: [&str; 3] = ["provider", "model", "small_model"];

/// lane 러너의 그 턴 값.
#[derive(Clone, Debug, Default)]
pub struct LaneHome<'a> {
    /// 그 턴의 모델 칸 값(원문 또는 옛 `harkroom-lane/<id>`, 모르면 `None`).
    pub model: Option<&'a str>,
    pub skills_dir: Option<&'a Path>,
    /// 그 턴의 채널과 그 채널의 승인 규칙 — 주면 그 채널 칸을 지금 규칙으로 다시 쓴다(U2).
    pub channel: Option<(&'a str, &'a [String])>,
}

pub struct EnsureOpencodeHome<'a> {
    pub opencode_home: &'a Path,
    /// 오퍼레이터가 만든 claude 형식 MCP 표(`mcpServers` 의 값).
    pub mcp_servers: &'a Map<String, Value>,
    pub app: &'a XdgApp,
    /// 사람 설정 폴더(`$XDG_CONFIG_HOME/<app>` 또는 `~/.config/<app>`). `user_config_files` 순서로 찾는다.
    pub user_config_dir: &'a Path,
    /// 사람 data 폴더(`$XDG_DATA_HOME/<app>` 또는 `~/.local/share/<app>`) — 로그인 `auth.json` 이 여기 있다.
    pub user_data_dir: &'a Path,
    pub provider_lane: Option<LaneHome<'a>>,
}

#[derive(Debug)]
pub enum EnsureError {
    Io(io::Error),
    /// 러너 홈의 로그인 링크가 사람 로그인이 아닌 곳을 가리킨다 — 사람이 확인해야 한다.
    UnexpectedAuthLink,
    /// lane 설정 잠금을 시한 안에 잡지 못했다.
    LockTimeout,
}

impl std::fmt::Display for EnsureError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(e) => write!(f, "opencode 홈을 마련하지 못했다: {}", e.kind()),
            Self::UnexpectedAuthLink => f.write_str(
                "opencode 홈의 로그인 링크가 예상과 다르다 — 파일을 확인한 뒤 러너를 다시 띄워라",
            ),
            Self::LockTimeout => f.write_str("opencode 설정 잠금을 잡지 못했다"),
        }
    }
}

impl std::error::Error for EnsureError {}

impl From<io::Error> for EnsureError {
    fn from(e: io::Error) -> Self {
        Self::Io(e)
    }
}

/// 정본 `opencodeConfigLockPath`.
pub fn opencode_config_lock_path(opencode_home: &Path) -> PathBuf {
    opencode_home.join(".config.lock")
}

/// 정본 `ensureOpencodeHome` — lane 러너는 잠금 안에서 한다.
pub fn ensure_opencode_home(o: &EnsureOpencodeHome<'_>) -> Result<PathBuf, EnsureError> {
    crate::account_lane::ensure_lane_dir(o.opencode_home)?;
    if o.provider_lane.is_none() {
        return ensure_unlocked(o);
    }
    with_config_lock(
        &opencode_config_lock_path(o.opencode_home),
        Duration::from_secs(5),
        Duration::from_secs(30),
        || ensure_unlocked(o),
    )
}

fn private_dir(dir: &Path) -> io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
}

fn read_json(path: &Path) -> Option<Map<String, Value>> {
    let text = fs::read_to_string(path).ok()?;
    match serde_json::from_str::<Value>(&strip_jsonc(&text)).ok()? {
        Value::Object(m) => Some(m),
        _ => None,
    }
}

fn read_user_config(app: &XdgApp, dir: &Path) -> Map<String, Value> {
    app.user_config_files
        .iter()
        .find_map(|f| read_json(&dir.join(f)))
        .unwrap_or_default()
}

fn write_atomic(path: &Path, text: &str) -> io::Result<()> {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let tmp = PathBuf::from(format!(
        "{}.{}.{ms}.tmp",
        path.to_string_lossy(),
        std::process::id()
    ));
    let res = (|| {
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&tmp)?;
        f.write_all(text.as_bytes())?;
        fs::rename(&tmp, path)
    })();
    if res.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    res
}

fn ensure_unlocked(o: &EnsureOpencodeHome<'_>) -> Result<PathBuf, EnsureError> {
    let home = o.opencode_home;
    fs::set_permissions(home, fs::Permissions::from_mode(0o700))?;
    let dirs = opencode_dirs(home);
    for d in [
        &dirs.xdg_config_home,
        &dirs.xdg_data_home,
        &dirs.xdg_state_home,
    ] {
        private_dir(d)?;
    }
    let config_file = opencode_config_file(home, o.app);
    let previous = fs::read_to_string(&config_file).unwrap_or_default();

    let mut inherited = Map::new();
    if let Some(lane) = &o.provider_lane {
        inherited.extend(provider_lane_config(
            lane.model,
            &previous_lane_models(&previous),
        ));
        if let Some(dir) = lane.skills_dir {
            inherited.insert("skills".into(), json!({ "paths": [dir.to_string_lossy()] }));
        }
        let instructions = home.join(LANE_INSTRUCTIONS_FILE);
        write_atomic(&instructions, &format!("{LANE_REPLY_INSTRUCTIONS}\n"))?;
        inherited.insert(
            "instructions".into(),
            json!([instructions.to_string_lossy()]),
        );
    } else {
        let user = read_user_config(o.app, o.user_config_dir);
        for k in INHERITED_KEYS {
            if let Some(v) = user.get(k) {
                inherited.insert(k.into(), v.clone());
            }
        }
    }
    let model = inherited.get("model").filter(|v| v.is_string()).cloned();
    let agent_of = |permission: Value| {
        let mut a = Map::new();
        a.insert("mode".into(), json!("primary"));
        a.insert("permission".into(), permission);
        if let Some(m) = &model {
            a.insert("model".into(), m.clone());
        }
        Value::Object(a)
    };

    let mut agents = Map::new();
    let mut readonly = Map::new();
    readonly.insert("mode".into(), json!("primary"));
    readonly.insert(
        "permission".into(),
        json!({ "edit": "deny", "bash": "deny", "webfetch": "deny" }),
    );
    if let Some(m) = &model {
        readonly.insert("model".into(), m.clone());
    }
    agents.insert(OPENCODE_READONLY_AGENT.into(), Value::Object(readonly));
    if let Some(lane) = &o.provider_lane {
        let mut perm = match opencode_lane_permission() {
            Value::Object(m) => m,
            _ => Map::new(),
        };
        perm.insert(
            "skill".into(),
            Value::Object(lane_skill_permission(&runner_skill_names(lane.skills_dir))),
        );
        agents.insert(
            OPENCODE_LANE_AGENT.into(),
            agent_of(Value::Object(perm.clone())),
        );
        for (name, bash) in previous_lane_channel_agents(&previous) {
            let mut p = perm.clone();
            p.insert("bash".into(), bash);
            agents.insert(name, agent_of(Value::Object(p)));
        }
        if let Some((id, allows)) = lane.channel
            && let Some(name) = opencode_lane_agent_name(id)
        {
            let mut p = perm.clone();
            p.insert(
                "bash".into(),
                Value::Object(lane_opencode_bash_table(allows)),
            );
            agents.insert(name, agent_of(Value::Object(p)));
        }
    }

    let mut config = Map::new();
    config.insert("$schema".into(), json!(o.app.schema));
    config.extend(inherited);
    config.insert("mcp".into(), Value::Object(to_opencode_mcp(o.mcp_servers)));
    config.insert("agent".into(), Value::Object(agents));
    if let Some(parent) = config_file.parent() {
        private_dir(parent)?;
    }
    let mut text = serde_json::to_string_pretty(&Value::Object(config))
        .map_err(|e| io::Error::other(e.to_string()))?;
    text.push('\n');
    write_atomic(&config_file, &text)?;

    // 로그인 — 자리가 한 단계 깊다(`<data>/<app>/auth.json`).
    let source_auth = o.user_data_dir.join("auth.json");
    let target_dir = dirs.xdg_data_home.join(o.app.dir);
    let target_auth = target_dir.join("auth.json");
    if o.provider_lane.is_some() {
        private_dir(&opencode_lane_home(home))?;
        // lane 에는 사람 로그인을 붙이지 않는다(security ⓒ) — 남은 링크만 뗀다(사람 파일은 안 건드린다).
        if fs::symlink_metadata(&target_auth).is_ok_and(|m| m.file_type().is_symlink()) {
            fs::remove_file(&target_auth)?;
        }
        return Ok(home.to_path_buf());
    }
    if fs::symlink_metadata(&source_auth).is_err() {
        return Ok(home.to_path_buf());
    }
    private_dir(&target_dir)?;
    match fs::symlink_metadata(&target_auth) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            symlink(&source_auth, &target_auth)?;
        }
        Err(e) => return Err(e.into()),
        Ok(m) if m.file_type().is_symlink() => {
            let target = fs::read_link(&target_auth)?;
            let resolved = if target.is_absolute() {
                target
            } else {
                target_dir.join(target)
            };
            if resolved != source_auth {
                return Err(EnsureError::UnexpectedAuthLink);
            }
        }
        // 러너 전용 로그인(일반 파일)은 보존한다.
        Ok(_) => {}
    }
    Ok(home.to_path_buf())
}

fn process_alive(pid: i32) -> bool {
    // SAFETY: 신호 0 은 존재·권한만 본다.
    let rc = unsafe { libc::kill(pid, 0) };
    rc == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// 정본 `withConfigLock` — `O_EXCL` 잠금 파일. 주인 프로세스가 죽었거나 `stale` 이 지난 잠금은 같은 내용일 때만 걷는다.
pub fn with_config_lock<T>(
    lock: &Path,
    timeout: Duration,
    stale: Duration,
    f: impl FnOnce() -> Result<T, EnsureError>,
) -> Result<T, EnsureError> {
    let deadline = Instant::now() + timeout;
    loop {
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(lock)
        {
            Ok(mut fh) => {
                let ms = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|d| d.as_millis())
                    .unwrap_or(0);
                let _ = fh.write_all(format!("{} {ms}\n", std::process::id()).as_bytes());
                break;
            }
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                let body = fs::read_to_string(lock).unwrap_or_default();
                let pid: i32 = body
                    .split(' ')
                    .next()
                    .and_then(|p| p.parse().ok())
                    .unwrap_or(0);
                let owner_gone = pid > 0 && !process_alive(pid);
                let old = fs::metadata(lock)
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.elapsed().ok())
                    .is_some_and(|age| age > stale);
                if owner_gone || old {
                    if fs::read_to_string(lock).ok().as_deref() == Some(body.as_str()) {
                        let _ = fs::remove_file(lock);
                    }
                    continue;
                }
                if Instant::now() > deadline {
                    return Err(EnsureError::LockTimeout);
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(e) => return Err(e.into()),
        }
    }
    let out = f();
    let _ = fs::remove_file(lock);
    out
}

#[cfg(test)]
#[path = "opencode_ensure_tests.rs"]
mod tests;
