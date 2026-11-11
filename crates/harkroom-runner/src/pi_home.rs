//! pi 의 러너 전용 상태 루트(`PI_CODING_AGENT_DIR`) — 정본 `packages/agent/src/piHome.ts` 의 이식(s8 B3c-2c-1).
//!
//! codex 의 `CODEX_HOME`, opencode 의 XDG 루트와 같은 자리이고 같은 이유다: 사람의 설정·세션과 갈라 두지 않으면
//! 운영자 개인 MCP·확장이 에이전트 턴에 붙는다.
//!
//! - `auth.json`·`models.json` 은 **링크**한다(사람이 키를 바꾸면 다음 턴에 닿는다). 없으면 만들지 않는다.
//! - `settings.json` 에서는 기본 제공자·모델만 고른다. 확장(`packages`) 등은 들이지 않는다 — pi 프로세스 안에서 도는 코드다.
//! - `mcp.json` 은 물려받지 않고 오퍼레이터의 표만으로 새로 쓴다.
//!
//! API 키 연결(lane) 턴의 스레드 홈·`models.json` 은 `pi_lane`(B3c-2c-2).
//!
//! 정본과 다른 점(모두 좁히는 쪽):
//! - `settings.json`·`mcp.json` 은 임시 파일 → rename 으로 쓴다. 그 자리에 링크가 있어도 링크 대상을 덮지 않는다
//!   (정본 `writeFile` 은 링크를 따라간다). 이미 있던 파일도 0600 으로 맞춘다(정본은 새로 만들 때만).
//! - 엉뚱한 곳을 가리키는 링크 오류의 `Display` 에는 파일 이름만 싣는다. 경로는 `local_detail()`(로컬 로그 전용)에만.
//!
//! 아직 연결되지 않았다 — 오퍼레이터는 계속 node 러너를 띄운다(B4 스위치).

use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::io::{self, Read};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use crate::adapter::ReadonlyTools;
use crate::config::Env;

/// 사람 설정에서 물려받을 키. 목록을 늘릴 때는 머리말의 판단을 다시 읽어라.
pub const INHERITED_SETTINGS: [&str; 2] = ["defaultProvider", "defaultModel"];
/// 링크로 재사용하는 사람 파일.
pub const LINKED_FILES: [&str; 2] = ["auth.json", "models.json"];
/// `pi mcp list --json` 의 시한·출력 상한(정본 `execFile` 의 `timeout`·`maxBuffer`).
pub const MCP_LIST_TIMEOUT: Duration = Duration::from_secs(30);
pub const MCP_LIST_MAX_BYTES: usize = 4 * 1024 * 1024;

/// 정본 `sourcePiDir` — 사람이 쓰는 pi 상태 루트.
pub fn source_pi_dir(env: &Env) -> PathBuf {
    match env.get("PI_CODING_AGENT_DIR").filter(|s| !s.is_empty()) {
        Some(d) => PathBuf::from(d),
        None => PathBuf::from(env.get("HOME").cloned().unwrap_or_default())
            .join(".pi")
            .join("agent"),
    }
}

/// 러너 루트 안의 세션 자리 — 매 턴 `--session-dir` 로 못박는다(저장소의 `.pi/settings.json` `sessionDir` 를 이긴다).
pub fn pi_sessions_dir(pi_home: &Path) -> PathBuf {
    pi_home.join("sessions")
}

/// 이 세션 id 의 기록 파일(`<시각>_<id>.jsonl`, 이름순 마지막). 없으면 `None`.
pub fn pi_session_file(pi_home: &Path, session_id: &str) -> Option<PathBuf> {
    let dir = pi_sessions_dir(pi_home);
    let suffix = format!("_{session_id}.jsonl");
    let mut hits: Vec<String> = fs::read_dir(&dir)
        .ok()?
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .filter(|n| n.ends_with(&suffix))
        .collect();
    hits.sort();
    hits.pop().map(|n| dir.join(n))
}

/// 정본 `toPiMcp` — 오퍼레이터의 표(claude 형식) → pi `mcp.json` 항목. 모든 서버를 `exposure: direct` 로 둔다.
/// 모르는 갈래는 버린다(잘못 만든 항목 하나가 설정 전체를 거절시킬 수 있다).
pub fn to_pi_mcp(servers: &Map<String, Value>) -> Map<String, Value> {
    let mut out = Map::new();
    for (name, def) in servers {
        if let Some(url) = def.get("url").and_then(Value::as_str) {
            let mut e = Map::new();
            e.insert("url".into(), json!(url));
            e.insert("exposure".into(), json!("direct"));
            if let Some(h) = def.get("headers").filter(|h| !h.is_null()) {
                e.insert("headers".into(), h.clone());
            }
            out.insert(name.clone(), Value::Object(e));
            continue;
        }
        if let Some(cmd) = def.get("command").and_then(Value::as_str) {
            let mut e = Map::new();
            e.insert("command".into(), json!(cmd));
            for k in ["args", "env"] {
                if let Some(v) = def.get(k).filter(|v| !v.is_null()) {
                    e.insert(k.into(), v.clone());
                }
            }
            e.insert("exposure".into(), json!("direct"));
            out.insert(name.clone(), Value::Object(e));
        }
    }
    out
}

/// 정본 `piToolName` — `mcp__<server>__<tool>`, 영숫자·`_` 밖은 `_`(UTF-16 단위가 아니라 글자 단위 — 정본 정규식도 `u` 없이 BMP 밖은 둘로 센다).
pub fn pi_tool_name(server: &str, tool: &str) -> String {
    fn clean(s: &str) -> String {
        s.encode_utf16()
            .map(|u| {
                if u < 0x80 && ((u as u8).is_ascii_alphanumeric() || u == b'_' as u16) {
                    u as u8 as char
                } else {
                    '_'
                }
            })
            .collect()
    }
    format!("mcp__{}__{}", clean(server), clean(tool))
}

/// 정본 `parsePiMcpList` — `pi mcp list --json` 출력 → 서버별 도구 이름. 모양이 다르면 `None`.
pub fn parse_pi_mcp_list(stdout: &str) -> Option<BTreeMap<String, Vec<String>>> {
    let parsed: Value = serde_json::from_str(stdout).ok()?;
    let servers = parsed.get("servers")?.as_array()?;
    let mut out = BTreeMap::new();
    for s in servers {
        let (Some(name), Some(tools)) = (
            s.get("name").and_then(Value::as_str),
            s.get("tools").and_then(Value::as_array),
        ) else {
            continue;
        };
        out.insert(
            name.to_string(),
            tools
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect(),
        );
    }
    Some(out)
}

/// 정본 `readonlyToolList` — 읽기 전용 턴의 `--tools` 값(닫힌 목록). 서버 도구를 못 받았으면 내장만 남긴다.
pub fn readonly_tool_list(
    spec: &ReadonlyTools,
    discovered: Option<&BTreeMap<String, Vec<String>>>,
) -> String {
    let mut names: Vec<String> = spec.builtins.iter().map(|s| s.to_string()).collect();
    for server in spec.mcp_servers {
        for tool in discovered
            .and_then(|d| d.get(*server))
            .into_iter()
            .flatten()
        {
            names.push(pi_tool_name(server, tool));
        }
    }
    names.join(",")
}

/// 정본 `listPiMcpTools` — 턴 직전에 하네스에게 MCP 도구 이름을 묻는다. `env` 는 통째로 준 것만 쓴다(러너 env 를
/// 물려주지 않는다). 시한·출력 상한을 넘거나 실패하면 `None` — 경고 한 줄은 명령 이름만 싣는다.
pub fn list_pi_mcp_tools(
    command: &Path,
    args: &[String],
    env: &Env,
    cwd: &Path,
) -> Option<BTreeMap<String, Vec<String>>> {
    let name = command
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    match run_capped(command, args, env, cwd) {
        Ok(out) => parse_pi_mcp_list(&out),
        Err(e) => {
            eprintln!("[piHome] MCP 도구 목록 실패 ({name}): {e}");
            None
        }
    }
}

fn run_capped(command: &Path, args: &[String], env: &Env, cwd: &Path) -> io::Result<String> {
    let mut child = Command::new(command)
        .args(args)
        .env_clear()
        .envs(env.iter())
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let mut stdout = child.stdout.take().expect("piped");
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let r = (&mut stdout)
            .take(MCP_LIST_MAX_BYTES as u64 + 1)
            .read_to_end(&mut buf);
        r.map(|_| buf)
    });
    let deadline = Instant::now() + MCP_LIST_TIMEOUT;
    let status = loop {
        if let Some(s) = child.try_wait()? {
            break s;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(io::Error::new(io::ErrorKind::TimedOut, "시한을 넘었다"));
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let buf = reader
        .join()
        .map_err(|_| io::Error::other("읽기 스레드가 죽었다"))??;
    if buf.len() > MCP_LIST_MAX_BYTES {
        return Err(io::Error::other("출력이 상한을 넘었다"));
    }
    if !status.success() {
        return Err(io::Error::other(format!("종료 코드 {status}")));
    }
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

/// `ensure_pi_home` 의 실패. `Display` 는 채팅으로 갈 수 있는 문구라 **로컬 경로를 싣지 않는다** — 경로는 `local_detail()`.
#[derive(Debug)]
pub enum PiHomeError {
    Io {
        what: &'static str,
        path: PathBuf,
        err: io::Error,
    },
    UnexpectedLink {
        file: &'static str,
        at: PathBuf,
        points_to: PathBuf,
        expected: PathBuf,
    },
}

impl fmt::Display for PiHomeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io { what, err, .. } => {
                write!(f, "Harkroom pi 홈 준비 실패({what}): {}", err.kind())
            }
            Self::UnexpectedLink { file, .. } => write!(
                f,
                "Harkroom pi {file} 링크가 예상과 다르다. 파일을 확인한 뒤 러너를 다시 시작해라."
            ),
        }
    }
}

impl std::error::Error for PiHomeError {}

impl PiHomeError {
    /// 로컬 로그 전용 — 경로까지 싣는다.
    pub fn local_detail(&self) -> String {
        match self {
            Self::Io { what, path, err } => {
                format!("pi 홈 {what} 실패: {} ({err})", path.display())
            }
            Self::UnexpectedLink {
                file,
                at,
                points_to,
                expected,
            } => format!(
                "Harkroom pi {file} 링크가 예상과 다르다: {} -> {}. 예상 대상은 {} 이다.",
                at.display(),
                points_to.display(),
                expected.display()
            ),
        }
    }
}

pub(crate) fn io_err(
    what: &'static str,
    path: &Path,
) -> impl FnOnce(io::Error) -> PiHomeError + use<> {
    let path = path.to_path_buf();
    move |err| PiHomeError::Io { what, path, err }
}

pub(crate) fn ensure_private_dir(dir: &Path) -> Result<(), PiHomeError> {
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
        .map_err(io_err("폴더 만들기", dir))?;
    fs::set_permissions(dir, fs::Permissions::from_mode(0o700)).map_err(io_err("폴더 권한", dir))
}

fn tmp_suffix() -> String {
    static N: AtomicU64 = AtomicU64::new(0);
    format!(
        ".{}.{}.tmp",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    )
}

/// 0600 임시 파일(`create_new`·`O_NOFOLLOW`) → rename. 그 자리의 링크는 링크째 바뀐다(대상을 덮지 않는다).
pub(crate) fn write_private(path: &Path, body: &str) -> Result<(), PiHomeError> {
    let tmp = PathBuf::from(format!("{}{}", path.display(), tmp_suffix()));
    let res = (|| {
        use std::io::Write;
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&tmp)?;
        f.write_all(body.as_bytes())?;
        f.sync_all()?;
        fs::rename(&tmp, path)
    })();
    if res.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    res.map_err(io_err("파일 쓰기", path))
}

fn read_json_object(path: &Path) -> Map<String, Value> {
    fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| match v {
            Value::Object(m) => Some(m),
            _ => None,
        })
        .unwrap_or_default()
}

pub(crate) fn pretty(v: &Value) -> String {
    format!("{}\n", serde_json::to_string_pretty(v).unwrap_or_default())
}

/// node `path.resolve(base, p)` — 절대면 그대로, 상대면 `base` 에 붙인다. `.`·`..` 칸을 접는다.
fn resolve_from(base: &Path, p: &Path) -> PathBuf {
    let joined = if p.is_absolute() {
        p.to_path_buf()
    } else {
        base.join(p)
    };
    let mut out = PathBuf::from("/");
    for c in joined.components() {
        match c {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::Normal(s) => out.push(s),
            _ => {}
        }
    }
    out
}

pub(crate) fn is_symlink(p: &Path) -> bool {
    fs::symlink_metadata(p).is_ok_and(|m| m.file_type().is_symlink())
}

/// 정본 `ensurePiHome` — 러너 전용 pi 루트를 만들고 로그인·제공자를 링크하고 설정·MCP 를 쓴다. **멱등**이다.
/// `lane` 이면 사람 설정·로그인·제공자를 하나도 물려받지 않고, 전에 걸어 둔 **링크만** 뗀다(사람 파일은 안 건드린다).
pub fn ensure_pi_home(
    pi_home: &Path,
    mcp_servers: &Map<String, Value>,
    source_dir: &Path,
    lane: bool,
) -> Result<PathBuf, PiHomeError> {
    ensure_private_dir(pi_home)?;
    ensure_private_dir(&pi_sessions_dir(pi_home))?;

    let user = if lane {
        Map::new()
    } else {
        read_json_object(&source_dir.join("settings.json"))
    };
    let mut settings = Map::new();
    for key in INHERITED_SETTINGS {
        if let Some(v) = user.get(key) {
            settings.insert(key.into(), v.clone());
        }
    }
    write_private(
        &pi_home.join("settings.json"),
        &pretty(&Value::Object(settings)),
    )?;
    write_private(
        &pi_home.join("mcp.json"),
        &pretty(&json!({"mcpServers": to_pi_mcp(mcp_servers)})),
    )?;

    for file in LINKED_FILES {
        let to = pi_home.join(file);
        if lane {
            if is_symlink(&to) {
                fs::remove_file(&to).map_err(io_err("링크 떼기", &to))?;
            }
            continue;
        }
        let from = source_dir.join(file);
        if fs::symlink_metadata(&from).is_err() {
            continue;
        }
        match fs::symlink_metadata(&to) {
            Err(_) => symlink(&from, &to).map_err(io_err("링크 걸기", &to))?,
            // 러너 전용 파일이 이미 있으면 보존한다. 엉뚱한 곳을 가리키는 링크만 크게 실패시킨다.
            Ok(m) if m.file_type().is_symlink() => {
                let target = fs::read_link(&to).map_err(io_err("링크 읽기", &to))?;
                if resolve_from(pi_home, &target) != resolve_from(pi_home, &from) {
                    return Err(PiHomeError::UnexpectedLink {
                        file,
                        at: to,
                        points_to: target,
                        expected: from,
                    });
                }
            }
            Ok(_) => {}
        }
    }
    Ok(pi_home.to_path_buf())
}

/// 정본 `piLaneLoginPresent` — lane 홈에 로그인이 들어 있는가. 빈 `{}` 는 로그인이 아니다(pi 가 첫 기동 때 만든다).
/// 링크이거나 못 읽거나 JSON 이 아니면 있다고 본다(띄우지 않는 쪽).
pub fn pi_lane_login_present(pi_home: &Path) -> bool {
    let path = pi_home.join("auth.json");
    let Ok(m) = fs::symlink_metadata(&path) else {
        return false;
    };
    if m.file_type().is_symlink() {
        return true;
    }
    match fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
    {
        Some(Value::Object(o)) => !o.is_empty(),
        _ => true,
    }
}

#[cfg(test)]
mod tests;
