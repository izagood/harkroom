//! 하네스가 이 워크스페이스를 **신뢰하도록** 미리 적어 둔다 — 정본 `packages/agent/src/workspaceTrust.ts` 의 이식(s8 B3c-2a).
//!
//! TUI 턴에서는 하네스가 워크스페이스 신뢰를 묻는다. 러너는 답할 수 없어 대화상자가 화면을 덮은 채 한도까지 매달리고,
//! 그 대화상자가 준비 표시(`❯`)를 담고 있어 프롬프트가 모달에 타이핑되기도 했다(2026-09-08). 신뢰가 여는 것은 그
//! 디렉터리의 project-local 설정 로드이고, 그 디렉터리는 **러너가 만들어 에이전트에게 준 워크스페이스**다 — 새 권한이 아니다.
//!
//! 모든 `ensure_*` 는 **실패를 삼킨다**(로그만). 못 적었으면 관문이 뜨고 준비 대기가 상한에서 사람을 부른다 — 그 실패가 이미 사실을 말한다.
//!
//! 이 모듈에 없는 것: 어댑터 표에서 장부 자리를 고르는 일(`TrustTarget` 을 만드는 쪽 — B3d 턴 코어, #1932 의 `adapter.rs` 표),
//! 계정 관문 기록 `markClaudeAccountGates`(오퍼레이터 crate `claude_login::mark_account_gates` 에 있다 — 공유 자리는 B3d 때 정한다).
//! 아직 연결되지 않았다 — 오퍼레이터는 계속 node 러너를 띄운다.

use std::collections::HashMap;
use std::fs;
use std::io::{self, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use serde_json::{Map, Value};

/// 신뢰 장부 하나 — 어느 파일에 어떤 형식으로 적는가. 어댑터 표의 `trust` 칸을 풀어 B3d 가 만든다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TrustTarget {
    /// claude `<config dir>/.claude.json` 의 `projects[dir].hasTrustDialogAccepted`.
    ClaudeJson(PathBuf),
    /// codex `<CODEX_HOME>/config.toml` 의 `[projects."<dir>"] trust_level`.
    CodexToml(PathBuf),
}

/// 0600 제자리 쓰기(TS `writeFile(path, …, { mode: 0o600 })` — 모드는 새로 만들 때만 걸린다).
fn write_0600(path: &Path, text: &str) -> io::Result<()> {
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    f.write_all(text.as_bytes())
}

fn mkdir_parent(path: &Path) -> io::Result<()> {
    match path.parent() {
        Some(p) if !p.as_os_str().is_empty() => fs::create_dir_all(p),
        _ => Ok(()),
    }
}

/// JSON 객체 문서를 읽는다. 없거나 깨졌거나 객체가 아니면 빈 문서(하네스가 나머지를 채운다).
fn read_object(path: &Path) -> Map<String, Value> {
    match fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
    {
        Some(Value::Object(m)) => m,
        _ => Map::new(),
    }
}

fn pretty(doc: Map<String, Value>) -> io::Result<String> {
    serde_json::to_string_pretty(&Value::Object(doc)).map_err(io::Error::other)
}

/// TS `trustForClaude` — **이미 적혀 있으면 쓰지 않는다**(같은 파일을 보는 하네스와 경합하고, 하네스의 다른 상태를 덮을 위험).
pub fn trust_for_claude(workspace_dir: &str, path: &Path) -> io::Result<()> {
    let mut doc = read_object(path);
    // 꺼내지 않고 복사한다 — 같은 키에 다시 넣어야 하네스가 쓴 키 순서가 그대로 남는다.
    let mut projects = match doc.get("projects") {
        Some(Value::Object(m)) => m.clone(),
        _ => Map::new(),
    };
    let mut entry = match projects.get(workspace_dir) {
        Some(Value::Object(m)) => m.clone(),
        _ => Map::new(),
    };
    if entry.get("hasTrustDialogAccepted") == Some(&Value::Bool(true)) {
        return Ok(());
    }
    entry.insert("hasTrustDialogAccepted".into(), Value::Bool(true));
    projects.insert(workspace_dir.to_string(), Value::Object(entry));
    doc.insert("projects".into(), Value::Object(projects));
    mkdir_parent(path)?;
    // 0600 — 이 파일에는 MCP 설정과 사용 통계가 함께 산다.
    write_0600(path, &pretty(doc)?)
}

/// TS `trustForCodex` — TOML 파서 없이 **없으면 덧붙인다**(격리 홈의 파일이라 우리가 적은 것과 하네스의 UI 상태뿐이다).
/// 경로는 TOML 기본 문자열 `"…"` 안에 그대로 들어가므로 `"`·`\`·제어 문자(개행 포함)가 있으면 적지 않고 거절한다 —
/// 그런 경로는 다른 절·키를 끼워 넣을 수 있다(security B3d 낮음, 정본은 거르지 않는다).
pub fn trust_for_codex(workspace_dir: &str, path: &Path) -> io::Result<()> {
    if workspace_dir
        .chars()
        .any(|c| c == '"' || c == '\\' || c.is_control())
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "작업 폴더 경로에 따옴표·역슬래시·제어 문자가 있어 codex 신뢰를 적지 않는다",
        ));
    }
    let header = format!("[projects.\"{workspace_dir}\"]");
    edit_codex_config(path, |text| {
        if text.contains(&header) {
            return None;
        }
        let sep = if text.is_empty() || text.ends_with('\n') {
            ""
        } else {
            "\n"
        };
        Some(format!(
            "{text}{sep}\n{header}\ntrust_level = \"trusted\"\n"
        ))
    })
}

fn config_lock(path: &Path) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();
    let mut map = LOCKS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    // 아무도 안 쥔 자물쇠는 걷는다(TS 가 끝난 약속을 지도에서 지우는 것과 같은 일).
    map.retain(|_, l| Arc::strong_count(l) > 1);
    map.entry(path.to_path_buf()).or_default().clone()
}

/// TS `editCodexConfig` — codex 홈 `config.toml` 고치기를 이 러너 안에서 **한 줄로 세운다**(같은 에이전트의 턴들이 동시에
/// 신뢰·hook 신뢰를 적는다 — 읽고 쓰는 사이에 다른 쓰기가 끼면 앞 턴이 적은 절이 사라진다). 쓰기는 임시 파일 + rename 이라
/// codex 가 반쯤 쓴 파일을 읽지 않는다. `edit` 가 `None` 이거나 같은 글이면 쓰지 않는다.
pub fn edit_codex_config(path: &Path, edit: impl FnOnce(&str) -> Option<String>) -> io::Result<()> {
    let lock = config_lock(path);
    let _held = lock.lock().unwrap_or_else(|p| p.into_inner());
    let text = fs::read_to_string(path).unwrap_or_default();
    let Some(out) = edit(&text) else {
        return Ok(());
    };
    if out == text {
        return Ok(());
    }
    mkdir_parent(path)?;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let tmp = PathBuf::from(format!(
        "{}.{}.{nanos}.tmp",
        path.to_string_lossy(),
        std::process::id()
    ));
    write_0600(&tmp, &out)?;
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

/// TS `acceptDangerousModeForClaude` — bypassPermissions 경고 화면을 미리 지나 둔다. 기본 경로는 아니다(harkroom `auto` 는
/// claude `auto` 로 번역된다); 사람이 터미널에서 bypass 로 올려 쓸 때 세션이 경고 화면에서 멈추지 않게 남긴다.
/// 계정 단위(`settings.json`)다. 이미 적혀 있으면 쓰지 않는다.
pub fn accept_dangerous_mode_for_claude(config_dir: &Path) -> io::Result<()> {
    let path = config_dir.join("settings.json");
    let mut doc = read_object(&path);
    if doc.get("skipDangerousModePermissionPrompt") == Some(&Value::Bool(true)) {
        return Ok(());
    }
    doc.insert(
        "skipDangerousModePermissionPrompt".into(),
        Value::Bool(true),
    );
    mkdir_parent(&path)?;
    write_0600(&path, &pretty(doc)?)
}

/// TS `ACCOUNT_SETTINGS_KEEP_KEYS` — 풀 계정 settings 에서 **남길** 키(허용 목록). 나머지는 지운다.
pub const ACCOUNT_SETTINGS_KEEP_KEYS: [&str; 4] = [
    "theme",
    "tui",
    "skipDangerousModePermissionPrompt",
    "enabledPlugins",
];

/// TS `scrubAccountPermissionSettings` — 풀 계정 config 의 settings 를 허용 목록으로 걷는다(권한은 서버 grant 로만 들어온다).
///
/// - 일반 파일이 아니면(링크·디렉터리) **따라가지 않고** 건너뛴다 — 사람의 `~/.claude/settings.json` 을 가리키는 링크일 수 있다.
/// - 깨진 파일·객체 아닌 문서는 고치지 않는다(claude 도 못 읽는다).
///
/// 지운 것을 `<경로>#<키>` 로 돌려준다(로그·시험용).
pub fn scrub_account_permission_settings(config_dir: &Path) -> io::Result<Vec<String>> {
    let mut removed = Vec::new();
    for name in ["settings.json", "settings.local.json"] {
        let path = config_dir.join(name);
        match fs::symlink_metadata(&path) {
            Ok(m) if m.file_type().is_file() => {}
            Ok(_) => {
                eprintln!(
                    "[workspaceTrust] 계정 설정이 일반 파일이 아니다(링크·디렉터리) — 따라가지 않고 건너뛴다: {}",
                    path.display()
                );
                continue;
            }
            Err(_) => continue,
        }
        let Some(Value::Object(mut rec)) = fs::read_to_string(&path)
            .ok()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        else {
            continue;
        };
        let drop: Vec<String> = rec
            .keys()
            .filter(|k| !ACCOUNT_SETTINGS_KEEP_KEYS.contains(&k.as_str()))
            .cloned()
            .collect();
        if drop.is_empty() {
            continue;
        }
        for k in &drop {
            rec.remove(k);
        }
        write_0600(&path, &pretty(rec)?)?;
        let shown = path.display().to_string();
        removed.extend(drop.iter().map(|k| format!("{shown}#{k}")));
        eprintln!(
            "[workspaceTrust] 계정 설정에서 허용 목록 밖 키를 지웠다({}) — 권한은 서버 승인으로만 들어온다: {shown}",
            drop.join(", ")
        );
    }
    Ok(removed)
}

/// TS `ensureDangerousModeAccepted` 의 앞 두 걸음 — claude 만, PTY 를 띄우기 전에. 실패는 로그만 남긴다.
///
/// `claude_config_dir` 가 `None` 이면 시스템 기본(`~/.claude`) — 사람이 평소 쓰는 설정이라 bypass 기록만 하고 **걷지 않는다.**
/// 세 번째 걸음(계정 관문 `markClaudeAccountGates`)은 B3d 가 이 뒤에 잇는다(모듈 머리 주석).
pub fn ensure_dangerous_mode_accepted(
    harness: &str,
    claude_config_dir: Option<&Path>,
    home: &Path,
) {
    if harness != "claude-code" {
        return;
    }
    let dir = claude_config_dir
        .map(Path::to_path_buf)
        .unwrap_or_else(|| home.join(".claude"));
    if let Err(e) = accept_dangerous_mode_for_claude(&dir) {
        eprintln!(
            "[workspaceTrust] bypassPermissions 수락 기록 실패(턴은 계속한다 — 경고 화면이 뜨면 준비 대기가 상한에서 사람을 부른다): {e}"
        );
    }
    let Some(pool_dir) = claude_config_dir else {
        return;
    };
    if let Err(e) = scrub_account_permission_settings(pool_dir) {
        eprintln!(
            "[workspaceTrust] 계정 설정 권한 키 걷기 실패(턴은 계속한다 — argv 의 Edit deny 와 분류기가 남는다): {e}"
        );
    }
}

/// TS `ensureWorkspaceTrusted` — 이 턴의 워크스페이스를 하네스가 신뢰하게 한다. **PTY 를 띄우기 전에** 부른다.
/// `target` 이 `None` 이면 그 하네스에는 신뢰 관문이 없다(opencode 등) — 아무것도 쓰지 않는다. 실패는 로그만.
pub fn ensure_workspace_trusted(workspace_dir: &str, target: Option<&TrustTarget>) {
    let res = match target {
        None => return,
        Some(TrustTarget::ClaudeJson(p)) => trust_for_claude(workspace_dir, p),
        Some(TrustTarget::CodexToml(p)) => trust_for_codex(workspace_dir, p),
    };
    if let Err(e) = res {
        eprintln!(
            "[workspaceTrust] {workspace_dir} 신뢰 기록 실패(턴은 계속한다 — 대화상자가 뜨면 준비 대기가 상한에서 실패한다): {e}"
        );
    }
}

#[cfg(test)]
#[path = "workspace_trust_tests.rs"]
mod tests;
