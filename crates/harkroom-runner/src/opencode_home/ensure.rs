//! 정본 `opencodeHome.ts` 의 파일을 건드리는 절반 — 공유 설정 잠금(`withConfigLock`)과 `ensureOpencodeHome`.
//! 값 계산은 부모 모듈의 순수 함수를 그대로 쓴다.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value, json};

use super::*;

/// lane 턴에 opencode·kilo 설정 `instructions` 로 덧붙이는 답 규칙(정본 `laneReplyInstructions.ts`).
pub const LANE_REPLY_INSTRUCTIONS: &str = concat!(
    "이 대화의 답은 화면(최종 메시지)에 쓰는 것으로 끝나지 않는다. 사람은 harkroom 스레드만 본다 — 인사·잡담을 포함한 모든 답을 ",
    "반드시 harkroom MCP 의 message_post 도구로 그 스레드(프롬프트 맨 위의 channelId·threadRootId)에 올려라. ",
    "message_post 에는 threadRootId 를 꼭 넣는다 — 빼면 채널 최상위에 올라가 그 스레드에서 답이 안 보인다.",
);

/// 사람 설정에서 물려받는 키. `mcp`·`agent`·`permission` 은 물려받지 않는다(러너가 쓴다).
pub const INHERITED_KEYS: [&str; 3] = ["provider", "model", "small_model"];

const LOCK_TIMEOUT: Duration = Duration::from_secs(5);
const LOCK_STALE: Duration = Duration::from_secs(30);
const LOCK_POLL: Duration = Duration::from_millis(25);

#[derive(Debug)]
pub enum OpencodeHomeError {
    Io(io::Error),
    /// 시한 안에 공유 설정 잠금을 잡지 못했다.
    LockTimeout,
    /// 러너 홈의 auth 링크가 사람 로그인이 아닌 곳을 가리킨다. 경로가 실리므로 **로컬 로그 전용** — 채팅(`message.fail`)에 싣지 않는다.
    UnexpectedAuthLink {
        app_dir: &'static str,
        link: PathBuf,
        target: PathBuf,
        expected: PathBuf,
    },
}

impl std::fmt::Display for OpencodeHomeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(e) => write!(f, "opencode 홈 준비 실패: {e}"),
            Self::LockTimeout => f.write_str("opencode 설정 잠금을 잡지 못했다"),
            Self::UnexpectedAuthLink {
                app_dir,
                link,
                target,
                expected,
            } => write!(
                f,
                "Harkroom {app_dir} auth 링크가 예상과 다르다: {} -> {}. 예상 대상은 {} 이다. 파일을 확인한 뒤 러너를 다시 시작해라.",
                link.display(),
                target.display(),
                expected.display()
            ),
        }
    }
}

impl std::error::Error for OpencodeHomeError {}

impl From<io::Error> for OpencodeHomeError {
    fn from(e: io::Error) -> Self {
        Self::Io(e)
    }
}

/// 공유 설정 잠금 파일 자리(러너 전용 opencode 홈 안, 작업 폴더 밖).
pub fn opencode_config_lock_path(opencode_home: &Path) -> PathBuf {
    opencode_home.join(".config.lock")
}

fn process_alive(pid: i32) -> bool {
    // SAFETY: 신호 0 은 보내지 않고 존재·권한만 본다.
    let rc = unsafe { libc::kill(pid, 0) };
    rc == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// 공유 opencode 설정 파일의 읽기-고치기-쓰기를 감싸는 잠금(정본 security F1). 잠금 파일은 `O_EXCL`(0600)로 만들고,
/// 시한(`stale`)이 지났거나 주인 프로세스가 죽은 것은 걷는다 — 걷기 직전에 다시 읽어 같은 잠금일 때만 지운다(n1).
/// 못 잡으면 `LockTimeout`. `f` 가 끝나면(실패해도) 잠금을 지운다.
pub fn with_config_lock<T>(
    lock_path: &Path,
    timeout: Option<Duration>,
    stale: Option<Duration>,
    f: impl FnOnce() -> Result<T, OpencodeHomeError>,
) -> Result<T, OpencodeHomeError> {
    let deadline = Instant::now() + timeout.unwrap_or(LOCK_TIMEOUT);
    let stale = stale.unwrap_or(LOCK_STALE);
    loop {
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(lock_path)
        {
            Ok(mut fh) => {
                // 정본처럼 쓰기 실패는 잠금 실패가 아니다(주인 표시만 비고, 시한으로 걷힌다).
                let _ = writeln!(fh, "{} {}", std::process::id(), now_ms());
                break;
            }
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                let meta = fs::metadata(lock_path).ok();
                let body = fs::read_to_string(lock_path).unwrap_or_default();
                let owner_gone = body
                    .split(' ')
                    .next()
                    .and_then(|s| s.parse::<i32>().ok())
                    .is_some_and(|pid| pid > 0 && !process_alive(pid));
                let too_old = meta
                    .as_ref()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.elapsed().ok())
                    .is_some_and(|age| age > stale);
                if meta.is_some() && (owner_gone || too_old) {
                    if fs::read_to_string(lock_path).ok().as_deref() == Some(body.as_str()) {
                        let _ = fs::remove_file(lock_path);
                    }
                    continue;
                }
                if Instant::now() > deadline {
                    return Err(OpencodeHomeError::LockTimeout);
                }
                std::thread::sleep(LOCK_POLL);
            }
            Err(e) => return Err(e.into()),
        }
    }
    let out = f();
    let _ = fs::remove_file(lock_path);
    out
}

/// 이 턴의 채널과 그 채널의 승인 규칙.
#[derive(Debug, Clone, Copy)]
pub struct LaneChannel<'a> {
    pub id: &'a str,
    pub tool_allows: &'a [String],
}

/// 전용 제공사(lane) 경로로 뜬 러너의 턴 정보. 주면 사람 설정의 provider·모델을 물리지 않고 lane 블록만 쓰며,
/// 사람 로그인(`auth.json`)도 링크하지 않는다(정본 security ⓒ·ⓕ).
#[derive(Debug, Clone, Copy, Default)]
pub struct ProviderLane<'a> {
    pub model: Option<&'a str>,
    pub skills_dir: Option<&'a Path>,
    pub channel: Option<LaneChannel<'a>>,
}

/// 사람 쪽 자리를 찾을 때 쓰는 환경(정본은 `process.env`·`homedir()` 을 직접 읽는다 — 시험하려고 받는다).
#[derive(Debug, Clone, Copy)]
pub struct HumanEnv<'a> {
    pub home: &'a Path,
    pub xdg_config_home: Option<&'a str>,
    pub xdg_data_home: Option<&'a str>,
}

#[derive(Debug, Clone, Copy)]
pub struct EnsureOpencodeHome<'a> {
    pub opencode_home: &'a Path,
    /// 오퍼레이터가 만든 claude 형식 MCP 표. `harkroom` 브릿지가 여기 들어 있다.
    pub mcp_servers: &'a Map<String, Value>,
    pub source_config: Option<&'a Path>,
    pub source_data: Option<&'a Path>,
    /// 어느 하네스의 이름표로 쓰나(어댑터의 `xdg_app`). 없으면 opencode.
    pub app: Option<&'a XdgApp>,
    pub provider_lane: Option<ProviderLane<'a>>,
    pub env: HumanEnv<'a>,
    pub lock_timeout: Option<Duration>,
}

/// opencode 러너 홈을 마련한다. 매 턴 불러도 되게 멱등이다 — 설정은 늘 새로 쓰고, 링크는 맞으면 두고, 엉뚱한 곳을 가리키면 크게 실패한다.
/// lane 러너는 채널 칸을 다른 턴과 같은 파일에 쓰므로 그 일을 잠금 안에서 한다(F1).
pub fn ensure_opencode_home(opts: &EnsureOpencodeHome<'_>) -> Result<PathBuf, OpencodeHomeError> {
    if opts.provider_lane.is_none() {
        return ensure_unlocked(opts);
    }
    mkdir_0700(opts.opencode_home)?;
    with_config_lock(
        &opencode_config_lock_path(opts.opencode_home),
        opts.lock_timeout,
        None,
        || ensure_unlocked(opts),
    )
}

fn mkdir_0700(dir: &Path) -> io::Result<()> {
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

/// 사람 설정을 `user_config_files` 순서로 찾는다. 하나도 못 읽으면 빈 표다.
fn read_user_config(
    app: &XdgApp,
    source_config: Option<&Path>,
    env: &HumanEnv<'_>,
) -> Map<String, Value> {
    if let Some(p) = source_config {
        return read_json(p).unwrap_or_default();
    }
    let dir = env
        .xdg_config_home
        .map(PathBuf::from)
        .unwrap_or_else(|| env.home.join(".config"))
        .join(app.dir);
    app.user_config_files
        .iter()
        .find_map(|f| read_json(&dir.join(f)))
        .unwrap_or_default()
}

/// 경로를 글자로만 정리한다(`.`·`..` 접기, 링크는 안 따라감) — 정본 `path.resolve` 의 비교와 같은 뜻.
fn lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn agent_of(permission: Value, inherited: &Map<String, Value>) -> Value {
    let mut m = Map::new();
    m.insert("mode".into(), json!("primary"));
    m.insert("permission".into(), permission);
    if let Some(Value::String(model)) = inherited.get("model") {
        m.insert("model".into(), json!(model));
    }
    Value::Object(m)
}

fn with_key(base: &Value, key: &str, v: Value) -> Value {
    let mut m = base.as_object().cloned().unwrap_or_default();
    m.insert(key.into(), v);
    Value::Object(m)
}

fn ensure_unlocked(opts: &EnsureOpencodeHome<'_>) -> Result<PathBuf, OpencodeHomeError> {
    let home = opts.opencode_home;
    let app = opts.app.unwrap_or(&OPENCODE_APP);
    let dirs = opencode_dirs(home);
    mkdir_0700(home)?;
    fs::set_permissions(home, fs::Permissions::from_mode(0o700))?;
    for d in [
        &dirs.xdg_config_home,
        &dirs.xdg_data_home,
        &dirs.xdg_state_home,
    ] {
        mkdir_0700(d)?;
    }
    let config_file = opencode_config_file(home, app);
    let previous_text = fs::read_to_string(&config_file).unwrap_or_default();

    let mut inherited = Map::new();
    if let Some(lane) = &opts.provider_lane {
        inherited.extend(provider_lane_config(
            lane.model,
            &previous_lane_models(&previous_text),
        ));
        if let Some(dir) = lane.skills_dir {
            inherited.insert("skills".into(), json!({ "paths": [dir.to_string_lossy()] }));
        }
        // 기본 지시를 지우지 않고 덧붙이는 `instructions` 칸. 파일은 이 홈 안에만 둔다(턴 파일에는 키 경로만).
        let instructions = home.join(LANE_INSTRUCTIONS_FILE);
        write_0600(
            &instructions,
            format!("{LANE_REPLY_INSTRUCTIONS}\n").as_bytes(),
        )?;
        inherited.insert(
            "instructions".into(),
            json!([instructions.to_string_lossy()]),
        );
    } else {
        let user = read_user_config(app, opts.source_config, &opts.env);
        for key in INHERITED_KEYS {
            if let Some(v) = user.get(key).filter(|v| !v.is_null()) {
                inherited.insert(key.into(), v.clone());
            }
        }
    }

    // lane 에이전트들: 기본 하나 + 채널 칸들. 다른 채널 칸은 지난 파일 그대로, 이 턴의 채널 칸만 지금 규칙으로(U2). 모두 primary(U1).
    let mut lane_agents: Option<Map<String, Value>> = None;
    if let Some(lane) = &opts.provider_lane {
        let skills = runner_skill_names(lane.skills_dir);
        let lane_permission = with_key(
            &opencode_lane_permission(),
            "skill",
            Value::Object(lane_skill_permission(&skills)),
        );
        let mut agents = Map::new();
        agents.insert(
            OPENCODE_LANE_AGENT.into(),
            agent_of(lane_permission.clone(), &inherited),
        );
        for (name, prev) in previous_lane_channel_agents(&previous_text) {
            agents.insert(
                name,
                agent_of(with_key(&lane_permission, "bash", prev), &inherited),
            );
        }
        if let Some(ch) = lane.channel
            && let Some(name) = opencode_lane_agent_name(ch.id)
        {
            let bash = Value::Object(lane_opencode_bash_table(ch.tool_allows));
            agents.insert(
                name,
                agent_of(with_key(&lane_permission, "bash", bash), &inherited),
            );
        }
        lane_agents = Some(agents);
    }

    // 읽기 전용 멘션 턴의 에이전트 — 보증은 이 권한 표가 한다.
    let mut agent = Map::new();
    agent.insert(
        OPENCODE_READONLY_AGENT.into(),
        agent_of(
            json!({ "edit": "deny", "bash": "deny", "webfetch": "deny" }),
            &inherited,
        ),
    );
    agent.extend(lane_agents.unwrap_or_default());

    let mut config = Map::new();
    config.insert("$schema".into(), json!(app.schema));
    config.extend(inherited);
    config.insert(
        "mcp".into(),
        Value::Object(to_opencode_mcp(opts.mcp_servers)),
    );
    config.insert("agent".into(), Value::Object(agent));

    mkdir_0700(&dirs.xdg_config_home.join(app.dir))?;
    // 임시 파일 → rename(F2) — opencode 는 잠금 없이 읽으므로 읽는 쪽은 늘 옛 파일 아니면 새 파일 전체를 본다.
    let body = serde_json::to_string_pretty(&Value::Object(config)).map_err(io::Error::other)?;
    let tmp = PathBuf::from(format!(
        "{}.{}.{}.tmp",
        config_file.display(),
        std::process::id(),
        now_ms()
    ));
    let swapped = write_0600(&tmp, format!("{body}\n").as_bytes())
        .and_then(|()| fs::rename(&tmp, &config_file));
    if let Err(e) = swapped {
        let _ = fs::remove_file(&tmp);
        return Err(e.into());
    }

    // 로그인은 링크로 재사용한다 — 자리가 한 단계 깊다(`<data>/<app>/auth.json`).
    let source_data = opts
        .source_data
        .map(Path::to_path_buf)
        .unwrap_or_else(|| source_opencode_data(opts.env.xdg_data_home, opts.env.home, app));
    let source_auth = source_data.join("auth.json");
    let target_dir = dirs.xdg_data_home.join(app.dir);
    let target_auth = target_dir.join("auth.json");
    if opts.provider_lane.is_some() {
        // 홈 표지 자리는 비워 둔 채로 — 만들기만 한다.
        mkdir_0700(&opencode_lane_home(home))?;
        // lane 에는 사람 로그인을 붙이지 않는다(ⓒ). 남은 링크가 있으면 **링크만** 뗀다.
        if fs::symlink_metadata(&target_auth).is_ok_and(|m| m.file_type().is_symlink()) {
            fs::remove_file(&target_auth)?;
        }
        return Ok(home.to_path_buf());
    }
    if fs::symlink_metadata(&source_auth).is_err() {
        return Ok(home.to_path_buf());
    }
    mkdir_0700(&target_dir)?;
    let Ok(meta) = fs::symlink_metadata(&target_auth) else {
        std::os::unix::fs::symlink(&source_auth, &target_auth)?;
        return Ok(home.to_path_buf());
    };
    // 러너 전용 로그인(일반 파일)은 보존하고, 엉뚱한 곳을 가리키는 링크만 크게 실패시킨다.
    if meta.file_type().is_symlink() {
        let target = fs::read_link(&target_auth)?;
        if lexical(&target_dir.join(&target)) != lexical(&source_auth) {
            return Err(OpencodeHomeError::UnexpectedAuthLink {
                app_dir: app.dir,
                link: target_auth,
                target,
                expected: source_auth,
            });
        }
    }
    Ok(home.to_path_buf())
}

fn write_0600(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut f = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    f.write_all(bytes)
}

#[cfg(test)]
#[path = "ensure_tests.rs"]
mod tests;
