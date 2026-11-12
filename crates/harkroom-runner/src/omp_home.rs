//! omp(oh-my-pi)의 러너 전용 상태 루트 — 정본 `packages/agent/src/ompHome.ts` 의 이식(s8 B3c-2c-3).
//!
//! pi 의 `pi_home` 과 같은 자리이고 같은 이유다. 다른 점은 omp 가 **저장소 설정을 신뢰를 묻지 않고 읽는다**는 것이다
//! (security B4·C1~C6·G1·K1~K3b). 모양:
//!
//! ```text
//! <ompHome>/home/              HOME — 로그·`run/session-owners`·natives 캐시(C3)
//! <ompHome>/agent/             PI_CODING_AGENT_DIR — config.yml·mcp.json·sessions(600/700)
//! <ompHome>/overlay.yml        `--config` 오버레이(C4)
//! <ompHome>/cwd/<스레드 해시>/   턴의 cwd(`git init` 한 빈 폴더, B4·G1)와 스레드 agentDir
//! <ompHome>/leftovers/<해시>/  스레드 cwd 에서 옮겨 둔 파일
//! ```
//!
//! omp 는 API 키 연결(lane)로만 돈다 — `models.yml` 의 `baseUrl` 은 러너만 정하고(K2), 키는 `!cat '<턴 키 파일>'` 로만
//! 가리킨다(K1·K3). 주소·경로·모델 검사는 `pi_lane` 의 것을 그대로 쓴다.
//!
//! 정본과 다른 점(모두 좁히는 쪽):
//! - 바이너리 해시(C1)는 **연 파일 하나**에서 잰다 — 메타데이터(`fstat`)와 내용이 같은 파일에서 나온다. 캐시 키에
//!   장치·inode·크기·mtime(ns)·ctime(ns)을 넣는다(정본은 경로·크기·mtime ms). 검사와 실행 사이의 바꿔치기는 정본과 같이
//!   남는다 — 실행은 고정 판 표시만 하고 막지 않는다(G2).
//! - 파일은 0600 임시 파일 → rename 으로 쓴다(링크를 따라가지 않는다). 세션 헤더는 `O_NOFOLLOW`·`create_new`.
//! - 세션 id 는 `[A-Za-z0-9_-]{1,128}` 만 받는다(경로 칸이다). 기록 시각은 `toISOString` 꼴(`…Z`)만 읽는다 — 못 읽으면
//!   정본의 `NaN` 처럼 건너뛴다. 기록 오류 문구는 4 KiB 에서 자른다.
//! - `git init` 은 env 를 비우고 PATH 만 넘긴다(시한 15초는 같다).
//! - 오류 `Display` 에는 경로를 싣지 않는다 — 경로는 `local_detail()`(로컬 로그 전용).
//!
//! 아직 연결되지 않았다 — 오퍼레이터는 계속 node 러너를 띄운다(B4 스위치).

use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fmt;
use std::fs;
use std::io::Read;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::adapter::ReadonlyTools;
use crate::pi_home::{PiHomeError, ensure_private_dir, io_err, pretty, write_private};
use crate::pi_lane::{
    LaneConfigError, lane_base_url_ok, lane_key_path_ok, lane_model_ok, thread_hash,
};
use crate::pty_record::iso_utc;

/// omp 가 받는 판(security C1). 넓히려면 심은 파일 회귀 시험(`ompPlanted.real.test.ts`)을 그 판으로 다시 돌린다.
pub const OMP_VERSIONS: [&str; 1] = ["18.12.6"];

/// 공식 릴리스 바이너리의 SHA256(C1) — 정본 표와 같다. 키는 node `${process.platform}-${process.arch}` 꼴.
pub const OMP_BINARY_SHA256: [(&str, &str, &str); 4] = [
    (
        "18.12.6",
        "darwin-arm64",
        "cfbb5e38cd8f8a3be55e710700be587d287deaacdc58c9b0a661c5086bccfe58",
    ),
    (
        "18.12.6",
        "darwin-x64",
        "62d6e6fd88b6fa5de2ca82842906f152bf1aa227559b1d0bb386f25f6d606123",
    ),
    (
        "18.12.6",
        "linux-arm64",
        "eee8e586274cef2e725c218b2b28b48ca9965d46dd58f60998cb347eca4ad0cf",
    ),
    (
        "18.12.6",
        "linux-x64",
        "85d9daf3a05fc76e8cd425ae1904eb576af8d21cc85fcf4690742626e07ccfa4",
    ),
];

/// 러너가 쓰는 omp 제공자 이름(`models.yml` `providers.<이름>`).
pub const OMP_LANE_PROVIDER: &str = "harkroom-lane";

/// `git init` 시한(정본 `timeout: 15_000`).
pub const GIT_INIT_TIMEOUT: Duration = Duration::from_secs(15);

/// 기록 오류 문구 상한 — 채팅 한 줄 몫(security B3c 낮음 「omp 기록 오류 문구 짧게」, 정본은 자르지 않는다).
pub const RECORDED_ERROR_MAX_BYTES: usize = 1024;

/// 기록 오류 문구에서 가릴 토큰 모양 — `Bearer <값>`·알려진 키 머리(`sk-`·`ghp_` 등)·32자 넘는 열쇠 같은 낱말.
static RECORDED_ERROR_SECRET: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(
        r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]+|\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}|\b(?:ghp|gho|ghu|ghs|ghr|github_pat|xox[abpr])[-_][A-Za-z0-9_-]{8,}|[A-Za-z0-9_-]{32,}",
    )
    .expect("고정 정규식")
});

/// 기록 오류 문구의 토큰 모양을 `***` 로 가린다.
pub fn mask_recorded_error(msg: &str) -> String {
    RECORDED_ERROR_SECRET.replace_all(msg, "***").into_owned()
}

/// 빈 cwd 와 그 위 폴더에 있으면 안 되는 이름(C2).
pub const OMP_CWD_FORBIDDEN: [&str; 7] = [
    ".omp",
    ".mcp.json",
    ".claude",
    ".env",
    ".agents",
    "AGENTS.md",
    "CLAUDE.md",
];

/// 이 머신의 node 꼴 플랫폼 키(`darwin-arm64` 등).
pub fn platform_key() -> String {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        o => o,
    };
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        a => a,
    };
    format!("{os}-{arch}")
}

/// 정본 `findOmpBinary` — PATH 에서 `omp` 정규 파일을 찾는다(앞의 것이 이긴다). 실제 경로로 돌려준다.
pub fn find_omp_binary(path: Option<&str>) -> Option<PathBuf> {
    for dir in path.unwrap_or("").split(':').filter(|s| !s.is_empty()) {
        let candidate = Path::new(dir).join("omp");
        if fs::metadata(&candidate).is_ok_and(|m| m.is_file()) {
            return fs::canonicalize(&candidate).ok();
        }
    }
    None
}

/// 고정한 판의 공식 바이너리가 아닐 때 스레드에 남기는 한 줄(security G2 — 막지 않는다). 경로는 싣지 않는다.
pub fn omp_unverified_binary_notice() -> String {
    format!(
        "⚠ omp — 실행 파일이 확인한 공식 바이너리가 아니다(확인한 판: {}). 턴은 그대로 진행한다.",
        OMP_VERSIONS.join(" · ")
    )
}

/// (장치·inode·크기·mtime 초·ns·ctime 초·ns).
type FileKey = (u64, u64, u64, i64, i64, i64, i64);

static HASH_CACHE: LazyLock<Mutex<HashMap<FileKey, String>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// 정본 `ompBinaryOk` — 그 실행 파일이 고정한 판의 공식 바이너리인가(C1). 표에 없는 판·플랫폼은 거절한다(fail-closed).
/// 한 번 연 파일에서 `fstat` 과 내용을 같이 읽는다. (장치·inode·크기·mtime·ctime)이 같으면 다시 재지 않는다.
pub fn omp_binary_ok(binary: &Path, platform: &str) -> bool {
    let want: Vec<&str> = OMP_BINARY_SHA256
        .iter()
        .filter(|(v, p, _)| OMP_VERSIONS.contains(v) && *p == platform)
        .map(|(_, _, h)| *h)
        .collect();
    if want.is_empty() {
        return false;
    }
    let Ok(mut f) = fs::File::open(binary) else {
        return false;
    };
    let Ok(m) = f.metadata() else {
        return false;
    };
    if !m.is_file() {
        return false;
    }
    let key = (
        m.dev(),
        m.ino(),
        m.size(),
        m.mtime(),
        m.mtime_nsec(),
        m.ctime(),
        m.ctime_nsec(),
    );
    if let Some(got) = HASH_CACHE.lock().ok().and_then(|c| c.get(&key).cloned()) {
        return want.contains(&got.as_str());
    }
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    loop {
        match f.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => h.update(&buf[..n]),
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return false,
        }
    }
    let got = hex(&h.finalize());
    if let Ok(mut c) = HASH_CACHE.lock() {
        c.insert(key, got.clone());
    }
    want.contains(&got.as_str())
}

/// 정본 `OmpDirs`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OmpDirs {
    pub home: PathBuf,
    pub agent_dir: PathBuf,
    pub sessions_dir: PathBuf,
    pub overlay: PathBuf,
    pub cwd_root: PathBuf,
}

pub fn omp_dirs(omp_home: &Path) -> OmpDirs {
    OmpDirs {
        home: omp_home.join("home"),
        agent_dir: omp_home.join("agent"),
        sessions_dir: omp_home.join("agent").join("sessions"),
        overlay: omp_home.join("overlay.yml"),
        cwd_root: omp_home.join("cwd"),
    }
}

/// `--config` 오버레이(C4). 배열은 덧붙지 않고 갈아끼워진다 — 막을 목록을 다 적는다. 항목별 이유는 정본 주석을 본다.
/// `native` 는 끄지 않는다(agentdir 의 우리 `mcp.json` 도 native 다).
pub const OMP_OVERLAY: &str = "disabledProviders:
  - claude
  - claude-plugins
  - codex
  - gemini
  - github
  - opencode
  - cursor
  - windsurf
  - agents-md
  - mcp-json
enabledProviders: []
tools:
  xdev: false
startup:
  setupWizard: false
  checkUpdate: false
paste:
  largeMenuThreshold: 0
";

/// 정본 `toOmpMcp` — 오퍼레이터의 표(claude 형식) → omp `mcp.json` 항목. 모르는 갈래는 버린다.
/// 원격 항목의 `type` 은 문자열일 때만 옮기고 아니면 `http` 다(정본은 null 이 아닌 값을 그대로 옮긴다).
pub fn to_omp_mcp(servers: &Map<String, Value>) -> Map<String, Value> {
    let mut out = Map::new();
    for (name, def) in servers {
        if let Some(url) = def.get("url").and_then(Value::as_str) {
            let mut e = Map::new();
            let ty = def.get("type").and_then(Value::as_str).unwrap_or("http");
            e.insert("type".into(), json!(ty));
            e.insert("url".into(), json!(url));
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
            out.insert(name.clone(), Value::Object(e));
        }
    }
    out
}

/// 정본 `ompReadonlyToolList` — 내장 읽기 도구 + 우리 서버의 글롭 `mcp__<서버>_*`(밑줄 하나). `mcp__*` 는 쓰지 않는다(R).
/// 영숫자·`_` 밖은 UTF-16 단위마다 `_`(정본 정규식과 같은 셈).
pub fn omp_readonly_tool_list(spec: &ReadonlyTools) -> String {
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
    spec.builtins
        .iter()
        .map(|s| s.to_string())
        .chain(
            spec.mcp_servers
                .iter()
                .map(|s| format!("mcp__{}_*", clean(s))),
        )
        .collect::<Vec<_>>()
        .join(",")
}

/// 정본 `OmpThreadDirs`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OmpThreadDirs {
    pub cwd: PathBuf,
    pub agent_dir: PathBuf,
    pub leftovers: PathBuf,
}

/// 정본 `ompThreadDirs` — 스레드(세션 레코드 키)마다 고정한 자리. 해시는 `pi_lane::thread_hash`(sha256 앞 24자).
pub fn omp_thread_dirs(omp_home: &Path, thread_key: &str) -> OmpThreadDirs {
    let hash = thread_hash(thread_key);
    let root = omp_dirs(omp_home).cwd_root.join(&hash);
    OmpThreadDirs {
        cwd: root.join("cwd"),
        agent_dir: root.join("agent"),
        leftovers: omp_home.join("leftovers").join(hash),
    }
}

/// omp 홈 준비의 실패. `Display` 는 채팅으로 갈 수 있는 문구라 경로·입력 값을 싣지 않는다.
#[derive(Debug)]
pub enum OmpHomeError {
    Home(PiHomeError),
    Config(LaneConfigError),
    /// `git init` 이 실패했거나 시한을 넘겼다.
    GitInit {
        cwd: PathBuf,
        detail: String,
    },
    /// 검사할 cwd 가 멈출 폴더 안에 없다.
    CwdOutsideStop {
        dir: PathBuf,
        stop_at: PathBuf,
    },
    /// 세션 id 꼴이 아니다.
    SessionId,
}

impl fmt::Display for OmpHomeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Home(e) => write!(f, "Harkroom omp 홈 준비 실패: {e}"),
            Self::Config(e) => write!(f, "omp lane models.yml: {}", config_reason(*e)),
            Self::GitInit { .. } => f.write_str("Harkroom omp 스레드 폴더 git init 실패"),
            Self::CwdOutsideStop { .. } => {
                f.write_str("ompCwdViolations: 검사할 폴더가 러너 상태 폴더 안에 없다")
            }
            Self::SessionId => f.write_str("omp 세션 id 꼴이 아니다"),
        }
    }
}

fn config_reason(e: LaneConfigError) -> &'static str {
    match e {
        LaneConfigError::BaseUrl => "https 또는 로컬 주소만 받는다",
        LaneConfigError::KeyPath => "키 파일 경로가 이상하다",
        LaneConfigError::ModelName => "모델 이름이 이상하다",
    }
}

impl std::error::Error for OmpHomeError {}

impl OmpHomeError {
    /// 로컬 로그 전용 — 경로까지 싣는다.
    pub fn local_detail(&self) -> String {
        match self {
            Self::Home(e) => e.local_detail(),
            Self::Config(_) | Self::SessionId => self.to_string(),
            Self::GitInit { cwd, detail } => {
                format!("omp git init 실패: {} ({detail})", cwd.display())
            }
            Self::CwdOutsideStop { dir, stop_at } => format!(
                "ompCwdViolations: {} 가 {} 안에 없다",
                dir.display(),
                stop_at.display()
            ),
        }
    }
}

impl From<PiHomeError> for OmpHomeError {
    fn from(e: PiHomeError) -> Self {
        Self::Home(e)
    }
}

/// `git init -q <cwd>` — env 는 PATH 만, 출력은 버린다, 시한을 넘기면 죽인다.
fn git_init(cwd: &Path, path_env: Option<&str>) -> Result<(), OmpHomeError> {
    let fail = |detail: String| OmpHomeError::GitInit {
        cwd: cwd.to_path_buf(),
        detail,
    };
    let mut cmd = Command::new("git");
    cmd.arg("init")
        .arg("-q")
        .arg(cwd)
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(p) = path_env {
        cmd.env("PATH", p);
    }
    let mut child = cmd.spawn().map_err(|e| fail(e.to_string()))?;
    let deadline = Instant::now() + GIT_INIT_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(st)) if st.success() => return Ok(()),
            Ok(Some(st)) => return Err(fail(format!("종료 {st}"))),
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(fail("시한 초과".into()));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(e) => return Err(fail(e.to_string())),
        }
    }
}

/// 정본 `ensureOmpThread` — 스레드 자리를 만든다(멱등). cwd 는 `git init` 한다(G1). agentDir 에는 공유 루트의
/// `config.yml`·`mcp.json` 을 턴마다 다시 쓴다. `path_env` 는 `git` 을 찾을 PATH 다.
pub fn ensure_omp_thread(
    omp_home: &Path,
    thread_key: &str,
    path_env: Option<&str>,
) -> Result<OmpThreadDirs, OmpHomeError> {
    let t = omp_thread_dirs(omp_home, thread_key);
    let parent = t.cwd.parent().map(Path::to_path_buf).unwrap_or_default();
    for dir in [&parent, &t.cwd, &t.agent_dir] {
        ensure_private_dir(dir)?;
    }
    if fs::symlink_metadata(t.cwd.join(".git")).is_err() {
        git_init(&t.cwd, path_env)?;
    }
    let shared = omp_dirs(omp_home).agent_dir;
    for name in ["config.yml", "mcp.json"] {
        let from = shared.join(name);
        let body = fs::read_to_string(&from).map_err(io_err("omp 공유 설정 읽기", &from))?;
        write_private(&t.agent_dir.join(name), &body)?;
    }
    Ok(t)
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn random_hex8() -> String {
    let mut b = [0u8; 4];
    let _ = fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut b));
    hex(&b)
}

fn list_names(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .map(|it| {
            it.filter_map(|e| e.ok()?.file_name().into_string().ok())
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names
}

/// 정본 `sweepOmpThreadCwd` — `.git` 말고 전부를 `leftovers/<시각>-<난수>/` 로 옮긴다. 턴을 띄우기 전에 부른다.
/// 못 옮긴 것은 그 자리에 남고 뒤따르는 `omp_cwd_violations` 가 잡는다. 옮긴 뒤의 경로를 돌려준다.
/// `now_ms` 는 UNIX 밀리초(시험용 — 보통은 `None`).
pub fn sweep_omp_thread_cwd(
    thread: &OmpThreadDirs,
    now_ms_override: Option<u128>,
) -> Result<Vec<PathBuf>, OmpHomeError> {
    let names: Vec<String> = list_names(&thread.cwd)
        .into_iter()
        .filter(|n| n != ".git")
        .collect();
    if names.is_empty() {
        return Ok(Vec::new());
    }
    let stamp = iso_utc(now_ms_override.unwrap_or_else(now_ms)).replace([':', '.'], "-");
    let dest = thread.leftovers.join(format!("{stamp}-{}", random_hex8()));
    ensure_private_dir(&dest)?;
    ensure_private_dir(&thread.leftovers)?;
    if let Some(p) = thread.leftovers.parent() {
        ensure_private_dir(p)?;
    }
    let mut moved = Vec::new();
    for name in names {
        let to = dest.join(&name);
        if fs::rename(thread.cwd.join(&name), &to).is_ok() {
            moved.push(to);
        }
    }
    Ok(moved)
}

/// node `path.resolve` 의 절대 경로 접기(`.`·`..`). 상대 경로는 현재 폴더에 붙인다.
fn resolve_abs(p: &Path) -> PathBuf {
    let joined = if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(p)
    };
    let mut out = PathBuf::from("/");
    for c in joined.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(s) => out.push(s),
            _ => {}
        }
    }
    out
}

/// 정본 `ompCwdViolations` — cwd 안의 `.git` 밖 모든 것 + 그 위 폴더(`stop_at` 까지)의 금지 이름(C2). 비면 통과.
pub fn omp_cwd_violations(dir: &Path, stop_at: &Path) -> Result<Vec<PathBuf>, OmpHomeError> {
    let mut found: Vec<PathBuf> = list_names(dir)
        .into_iter()
        .filter(|n| n != ".git")
        .map(|n| dir.join(n))
        .collect();
    let stop = resolve_abs(stop_at);
    let resolved = resolve_abs(dir);
    let mut cur = resolved.parent().map(Path::to_path_buf).unwrap_or_default();
    if !cur.starts_with(&stop) {
        return Err(OmpHomeError::CwdOutsideStop {
            dir: dir.to_path_buf(),
            stop_at: stop_at.to_path_buf(),
        });
    }
    loop {
        for name in OMP_CWD_FORBIDDEN {
            let p = cur.join(name);
            if fs::symlink_metadata(&p).is_ok() {
                found.push(p);
            }
        }
        if cur == stop {
            break;
        }
        match cur.parent() {
            Some(p) => cur = p.to_path_buf(),
            None => break,
        }
    }
    Ok(found)
}

/// 세션 id 가 경로 칸에 넣어도 되는 꼴인가.
pub fn omp_session_id_ok(id: &str) -> bool {
    (1..=128).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn session_name_matches(name: &str, session_id: &str) -> bool {
    name == format!("{session_id}.jsonl") || name.ends_with(&format!("_{session_id}.jsonl"))
}

/// 정본 `writeOmpSessionHeader` — 세션 헤더 한 줄 파일을 미리 쓴다(omp 에는 `--session-id` 가 없다). 있으면 건드리지 않는다.
pub fn write_omp_session_header(
    sessions_dir: &Path,
    session_id: &str,
    cwd: &Path,
    now_ms_override: Option<u128>,
) -> Result<PathBuf, OmpHomeError> {
    if !omp_session_id_ok(session_id) {
        return Err(OmpHomeError::SessionId);
    }
    ensure_private_dir(sessions_dir)?;
    if let Some(hit) = list_names(sessions_dir)
        .into_iter()
        .find(|n| session_name_matches(n, session_id))
    {
        return Ok(sessions_dir.join(hit));
    }
    let iso = iso_utc(now_ms_override.unwrap_or_else(now_ms));
    let path = sessions_dir.join(format!(
        "{}_{session_id}.jsonl",
        iso.replace([':', '.'], "-")
    ));
    let header = json!({
        "type": "session",
        "version": 3,
        "id": session_id,
        "timestamp": iso,
        "cwd": cwd.to_string_lossy(),
    });
    let res = (|| {
        use std::io::Write;
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&path)?;
        f.write_all(format!("{header}\n").as_bytes())
    })();
    res.map_err(io_err("세션 헤더 쓰기", &path))?;
    Ok(path)
}

/// 정본 `ompSessionFile` — 이 세션 id 의 기록 파일(이름순 마지막). 없거나 id 꼴이 아니면 `None`.
pub fn omp_session_file(omp_home: &Path, session_id: &str) -> Option<PathBuf> {
    if !omp_session_id_ok(session_id) {
        return None;
    }
    let dir = omp_dirs(omp_home).sessions_dir;
    list_names(&dir)
        .into_iter()
        .rfind(|n| session_name_matches(n, session_id))
        .map(|n| dir.join(n))
}

/// 정본 `newOmpSessionId` — v4.
pub fn new_omp_session_id() -> String {
    crate::link::random_uuid()
}

/// `toISOString` 꼴(`YYYY-MM-DDTHH:MM:SS(.f+)?Z`) → UNIX 밀리초. 다른 꼴은 `None`.
pub fn parse_iso_utc_ms(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 20 || *b.last()? != b'Z' {
        return None;
    }
    let num = |r: std::ops::Range<usize>| -> Option<i64> {
        let t = s.get(r)?;
        if !t.bytes().all(|c| c.is_ascii_digit()) {
            return None;
        }
        t.parse().ok()
    };
    if b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let (y, mo, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (h, mi, se) = (num(11..13)?, num(14..16)?, num(17..19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || se > 59 {
        return None;
    }
    let ms = match &s[19..s.len() - 1] {
        "" => 0,
        frac if frac.starts_with('.') && frac.len() >= 2 => {
            let digits = &frac[1..];
            if !digits.bytes().all(|c| c.is_ascii_digit()) {
                return None;
            }
            let mut three: String = digits.chars().take(3).collect();
            while three.len() < 3 {
                three.push('0');
            }
            three.parse::<i64>().ok()?
        }
        _ => return None,
    };
    // days_from_civil(Howard Hinnant)
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 86_400 + h * 3600 + mi * 60 + se) * 1000) + ms)
}

fn truncate_bytes(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].to_string()
}

/// 정본 `readOmpRecordedApiError` — 이 턴에 omp 가 **자기 기록에 남긴** API 오류(`stopReason: "error"`·`errorMessage`).
/// `since_ms` 뒤의 마지막 것만 본다. 화면이 아니라 기록으로 보는 이유는 정본 주석(security F1)을 본다.
pub fn read_omp_recorded_api_error(
    omp_home: &Path,
    session_id: Option<&str>,
    since_ms: i64,
) -> Option<String> {
    let path = omp_session_file(omp_home, session_id?)?;
    let text = fs::read_to_string(path).unwrap_or_default();
    let mut found = None;
    for line in text.split('\n') {
        if !line.contains("\"stopReason\":\"error\"") {
            continue;
        }
        let Ok(row) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(m) = row.get("message") else {
            continue;
        };
        if row.get("type").and_then(Value::as_str) != Some("message")
            || m.get("role").and_then(Value::as_str) != Some("assistant")
            || m.get("stopReason").and_then(Value::as_str) != Some("error")
        {
            continue;
        }
        let Some(msg) = m.get("errorMessage").and_then(Value::as_str) else {
            continue;
        };
        let at = row
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(parse_iso_utc_ms);
        if at.is_none_or(|at| at < since_ms) {
            continue;
        }
        // 가린 뒤에 자른다 — 자르는 자리에 토큰 앞부분이 남지 않게.
        found = Some(truncate_bytes(
            &mask_recorded_error(msg),
            RECORDED_ERROR_MAX_BYTES,
        ));
    }
    found
}

/// lane 한 턴의 연결 값.
#[derive(Debug, Clone)]
pub struct OmpLane<'a> {
    pub base_url: &'a str,
    pub key_path: &'a str,
    pub models: &'a [String],
}

/// 정본 `ompLaneModelsYml` — 주소는 https 또는 루프백 http, 키는 `!cat '<경로>'` 로만(K1·K2·K3).
/// `!` 로 시작하는 값은 omp 가 `/bin/sh -c` 로 실행한다 — 검사는 `pi_lane` 과 같다.
pub fn omp_lane_models_yml(lane: &OmpLane<'_>) -> Result<String, LaneConfigError> {
    if !lane_base_url_ok(lane.base_url) {
        return Err(LaneConfigError::BaseUrl);
    }
    if !lane_key_path_ok(lane.key_path) {
        return Err(LaneConfigError::KeyPath);
    }
    if !lane.models.iter().all(|m| lane_model_ok(m)) {
        return Err(LaneConfigError::ModelName);
    }
    let q = |s: String| serde_json::to_string(&s).unwrap_or_default();
    let mut lines = vec![
        "providers:".to_string(),
        format!("  {OMP_LANE_PROVIDER}:"),
        // gateway 의 OpenAI 꼴 경로는 `/v1/chat/completions` 다 — lane 주소는 뿌리라 `/v1` 을 붙인다(pi 와 같다).
        format!("    baseUrl: {}", q(format!("{}/v1", lane.base_url))),
        "    api: openai-completions".to_string(),
        "    auth: apiKey".to_string(),
        format!("    apiKey: {}", q(format!("!cat '{}'", lane.key_path))),
        "    models:".to_string(),
    ];
    for m in lane.models {
        lines.push(format!("      - id: {}", q(m.clone())));
    }
    lines.push(String::new());
    Ok(lines.join("\n"))
}

/// 정본 `ensureOmpHome` — 러너 전용 omp 루트를 만들고 오버레이·MCP 를 쓴다(멱등). `models.yml` 은 lane 이 턴마다 쓴다.
pub fn ensure_omp_home(
    omp_home: &Path,
    mcp_servers: &Map<String, Value>,
) -> Result<PathBuf, OmpHomeError> {
    let d = omp_dirs(omp_home);
    for dir in [
        omp_home,
        &d.home,
        &d.agent_dir,
        &d.sessions_dir,
        &d.cwd_root,
    ] {
        ensure_private_dir(dir)?;
    }
    write_private(&d.overlay, OMP_OVERLAY)?;
    // agentdir 의 config.yml 도 같은 값을 둔다 — 오버레이가 빠진 기동에도 마법사·xdev 가 같다.
    write_private(&d.agent_dir.join("config.yml"), OMP_OVERLAY)?;
    write_private(
        &d.agent_dir.join("mcp.json"),
        &pretty(&json!({ "mcpServers": to_omp_mcp(mcp_servers) })),
    )?;
    Ok(omp_home.to_path_buf())
}

/// 정본 `writeOmpLaneModels` — 그 스레드의 agentDir 에 `models.yml` 을 0600 으로 쓴다(K1). 링크는 링크째 바뀐다.
pub fn write_omp_lane_models(
    agent_dir: &Path,
    lane: &OmpLane<'_>,
) -> Result<PathBuf, OmpHomeError> {
    let body = omp_lane_models_yml(lane).map_err(OmpHomeError::Config)?;
    let path = agent_dir.join("models.yml");
    write_private(&path, &body)?;
    Ok(path)
}

#[cfg(test)]
mod tests;
