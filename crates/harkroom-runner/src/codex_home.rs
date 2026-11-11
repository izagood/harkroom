//! 러너의 격리 `CODEX_HOME` — 정본 `packages/agent/src/codexHome.ts` 의 이식(s8 B3c-2a).
//!
//! codex 의 `CODEX_HOME` 은 config·auth·sessions 를 한꺼번에 바꾼다. 개인 config.toml/MCP 를 물려받지 않도록
//! 러너는 에이전트 상태 디렉터리 아래 별도 홈을 쓰고, **로그인(`auth.json`)만 심볼릭 링크로 빌린다.**
//! 어느 로그인을 빌릴지는 오퍼레이터가 쓰는 `active.json`(커뮤니티마다면 `codex-active.json`)이 정한다.
//!
//! 아직 연결되지 않았다 — 오퍼레이터는 계속 node 러너를 띄운다(B4 스위치).

use std::fmt;
use std::fs;
use std::io;
use std::os::unix::fs::{DirBuilderExt, PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::config::{Env, OPERATOR_ROOT_ENV, PER_COMMUNITY_ENV, resolve_abs};

/// TS `CODEX_ACCOUNT_NAME_PATTERN` = `/^[a-z0-9-]{1,32}$/`. 이 이름은 경로 칸이 된다 — 오퍼레이터
/// `codex_accounts::is_account_name` 과 같은 문법이어야 한다(쓰는 쪽과 읽는 쪽).
pub fn is_account_name(s: &str) -> bool {
    (1..=32).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// node `path.resolve(p)` — 상대 경로는 현재 디렉터리에 붙인다.
fn resolve(p: &str) -> String {
    if p.starts_with('/') {
        return resolve_abs(p);
    }
    let cwd = std::env::current_dir()
        .map(|d| d.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "/".into());
    resolve_abs(&format!("{cwd}/{p}"))
}

/// node `path.resolve(base, p)`.
fn resolve_from(base: &Path, p: &Path) -> PathBuf {
    if p.is_absolute() {
        PathBuf::from(resolve_abs(&p.to_string_lossy()))
    } else {
        PathBuf::from(resolve(&base.join(p).to_string_lossy()))
    }
}

fn home(env: &Env) -> String {
    env.get("HOME").cloned().unwrap_or_default()
}

/// TS `sourceCodexHome` — codex 가 기본으로 쓰는 사용자 상태 루트. 러너가 받은 `CODEX_HOME` 도 존중한다.
pub fn source_codex_home(env: &Env) -> PathBuf {
    match env.get("CODEX_HOME") {
        Some(h) => PathBuf::from(resolve(h)),
        None => PathBuf::from(resolve(&format!("{}/.codex", home(env)))),
    }
}

/// TS `codexAccountsRoot` — 오퍼레이터 `codex_accounts::codex_accounts_root` 와 **같은 값**이어야 한다.
pub fn codex_accounts_root(env: &Env) -> PathBuf {
    match env.get("HARKROOM_CODEX_ACCOUNTS_DIR") {
        Some(d) => PathBuf::from(resolve(d)),
        None => PathBuf::from(resolve(&format!(
            "{}/.harkroom-agent/codex-accounts",
            home(env)
        ))),
    }
}

/// TS `codexActiveFilePath`(`@harkroom/shared/operatorRoots`). 스위치가 켜졌는데 뿌리가 절대 경로가 아니면 `Err`
/// (TS 는 던진다 — 기계에 하나인 자리로 물러서면 커뮤니티끼리 계정 선택이 섞인다).
pub fn codex_active_file_path(codex_root: &Path, env: &Env) -> Result<PathBuf, String> {
    if env.get(PER_COMMUNITY_ENV).map(String::as_str) != Some("1") {
        return Ok(codex_root.join("active.json"));
    }
    match env.get(OPERATOR_ROOT_ENV) {
        Some(root) if root.starts_with('/') => {
            Ok(PathBuf::from(resolve_abs(root)).join("codex-active.json"))
        }
        _ => Err(format!(
            "{PER_COMMUNITY_ENV}=1 인데 {OPERATOR_ROOT_ENV} 가 절대 경로가 아니다"
        )),
    }
}

/// 이번 턴이 쓸 로그인의 자리(`auth.json` 이 있는 디렉터리). `account` 가 `None` 이면 시스템 기본.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthSource {
    pub home: PathBuf,
    pub account: Option<String>,
}

/// TS `codexAuthSource` — **실패하지 않는다.** 턴마다 부르므로 파일 하나가 깨졌다고 codex 턴 전부가 죽으면 안 되고,
/// 가리킨 계정에 로그인이 없으면 시스템으로 떨어진다(로그인 안 된 홈을 주면 codex 가 로그인 안내를 찍고 턴이 멈춘다).
pub fn codex_auth_source(env: &Env) -> AuthSource {
    let root = codex_accounts_root(env);
    let system = AuthSource {
        home: source_codex_home(env),
        account: None,
    };
    let active = codex_active_file_path(&root, env)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v.get("active").and_then(|a| a.as_str()).map(str::to_owned))
        .filter(|a| is_account_name(a));
    let Some(active) = active else {
        return system;
    };
    let home = root.join(&active);
    if fs::symlink_metadata(home.join("auth.json")).is_ok() {
        AuthSource {
            home,
            account: Some(active),
        }
    } else {
        system
    }
}

/// `ensure_codex_home` 의 실패.
#[derive(Debug)]
pub enum CodexHomeError {
    Io(io::Error),
    /// 격리 홈의 `auth.json` 링크가 우리가 모르는 자리를 가리킨다 — 자동으로 고치지 않는다(사람이 로그인한 파일일 수 있다).
    UnexpectedAuthLink {
        link: PathBuf,
        target: PathBuf,
        expected: PathBuf,
    },
}

impl From<io::Error> for CodexHomeError {
    fn from(e: io::Error) -> Self {
        Self::Io(e)
    }
}

impl fmt::Display for CodexHomeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(e) => write!(f, "{e}"),
            Self::UnexpectedAuthLink {
                link,
                target,
                expected,
            } => write!(
                f,
                "Harkroom Codex auth 링크가 예상과 다르다: {} -> {}. 예상 대상은 {} 이다. 파일을 확인한 뒤 러너를 다시 시작해라.",
                link.display(),
                target.display(),
                expected.display()
            ),
        }
    }
}

impl std::error::Error for CodexHomeError {}

/// 링크를 돌려도 되는 "우리가 아는 자리"(TS `ensureCodexHome` 의 `opts`).
#[derive(Debug, Clone, Default)]
pub struct KnownHomes {
    /// 보통 시스템 기본 홈.
    pub homes: Vec<PathBuf>,
    /// 이 아래 계정 홈을 가리키는 링크도 돌려도 된다(`codex_accounts_root`).
    pub accounts_root: Option<PathBuf>,
}

static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

fn tmp_suffix() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!(
        "{}-{nanos}-{}",
        std::process::id(),
        TMP_SEQ.fetch_add(1, Ordering::Relaxed)
    )
}

/// TS `ensureCodexHome` — 격리 홈을 0700 으로 만들고, `source_home/auth.json` 이 있으면 그리로 링크한다.
///
/// - 원본 로그인이 없으면 아무것도 만들지 않는다(codex 자신의 로그인 안내가 보이게).
/// - 격리 홈에 일반 파일 `auth.json` 이 있으면 Harkroom 전용 로그인이다 — 보존한다.
/// - 링크가 아는 자리(시스템 기본·계정 뿌리 아래)를 가리키면 활성 계정이 바뀐 것이다 — 임시 링크 + rename 으로
///   **원자적으로** 돌린다(unlink→symlink 사이에 도는 codex 가 "로그인 없음"을 보는 틈이 없게). 파일은 건드리지 않는다.
/// - 모르는 자리면 `UnexpectedAuthLink`.
pub fn ensure_codex_home(
    codex_home: &Path,
    source_home: &Path,
    known: &KnownHomes,
) -> Result<PathBuf, CodexHomeError> {
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(codex_home)?;
    fs::set_permissions(codex_home, fs::Permissions::from_mode(0o700))?;

    let source_auth = source_home.join("auth.json");
    let target_auth = codex_home.join("auth.json");
    if fs::symlink_metadata(&source_auth).is_err() {
        return Ok(codex_home.to_path_buf());
    }
    let target_stat = match fs::symlink_metadata(&target_auth) {
        Ok(m) => m,
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            symlink(&source_auth, &target_auth)?;
            return Ok(codex_home.to_path_buf());
        }
        Err(e) => return Err(e.into()),
    };
    if !target_stat.file_type().is_symlink() {
        return Ok(codex_home.to_path_buf());
    }
    let target = fs::read_link(&target_auth)?;
    let current = resolve_from(codex_home, &target);
    if current == resolve_from(Path::new("/"), &source_auth) {
        return Ok(codex_home.to_path_buf());
    }
    let current_home = current.parent().map(Path::to_path_buf).unwrap_or_default();
    let in_known = known
        .homes
        .iter()
        .any(|h| resolve_from(Path::new("/"), h) == current_home);
    let in_accounts = known.accounts_root.as_ref().is_some_and(|root| {
        current_home.parent() == Some(resolve_from(Path::new("/"), root).as_path())
    });
    if in_known || in_accounts {
        let tmp = PathBuf::from(format!(
            "{}.tmp-{}",
            target_auth.to_string_lossy(),
            tmp_suffix()
        ));
        symlink(&source_auth, &tmp)?;
        if let Err(e) = fs::rename(&tmp, &target_auth) {
            let _ = fs::remove_file(&tmp);
            return Err(e.into());
        }
        return Ok(codex_home.to_path_buf());
    }
    Err(CodexHomeError::UnexpectedAuthLink {
        link: target_auth,
        target,
        expected: source_auth,
    })
}

/// TS `syncCodexAuth` — 격리 홈을 **지금 활성인 codex 계정**에 맞춘다. 기동 때 한 번, codex 턴을 띄우기 직전마다 부른다.
/// 돌려주는 계정 이름은 로그용이다(`None` = 시스템 기본).
pub fn sync_codex_auth(codex_home: &Path, env: &Env) -> Result<Option<String>, CodexHomeError> {
    let source = codex_auth_source(env);
    ensure_codex_home(
        codex_home,
        &source.home,
        &KnownHomes {
            homes: vec![source_codex_home(env)],
            accounts_root: Some(codex_accounts_root(env)),
        },
    )?;
    Ok(source.account)
}

/// TS `codexSessionsDir`.
pub fn codex_sessions_dir(codex_home: &Path) -> PathBuf {
    codex_home.join("sessions")
}

#[cfg(test)]
#[path = "codex_home_tests.rs"]
mod tests;
