//! 계정 터미널 열기 — TS `claudeAccounts.ts` 의 `openTerminal`·`terminalScript`·`nodeOpenInTerminal` 과
//! 공유 `claudeGates.ts` 의 `markClaudeWorkspaceTrusted` 이식(s9 G8, 요청 `claudeAccountOpenTerminal`).
//!
//! 그 계정의 `CLAUDE_CONFIG_DIR` 로 **사람에게** Terminal.app 의 `claude` 를 연다. 사람이 로그인·관문 화면을
//! 직접 지나게 하는 길이다.
//!
//! - **경로는 우리가 조립한 값뿐이다**(`under` 로 잰 계정 디렉터리) — 웹뷰가 넘긴 문자열이 셸에 들어가지 않는다.
//!   풀·계정 이름은 `under` 가 문법(`[a-z0-9-]`)으로 거른다.
//! - 작업 폴더는 **열 때마다 새로 만든 빈 폴더**다(TS `mkdtemp`, security 권고 10-01). 신뢰한 폴더의
//!   `.claude/settings.json`(훅)·`.mcp.json`·`CLAUDE.md` 는 확인 없이 읽히므로, 남아 있는 폴더를 계속 신뢰해 두면
//!   파일 하나로 사람의 대화 세션에 훅을 심을 수 있다. 막 만든 빈 폴더에는 그런 것이 없다.
//! - 스크립트는 그 폴더 **밖**(`.terminal/` 바로 밑)에 둔다. 뿌리의 점 디렉터리라 풀·계정 문법에 안 걸린다.
//! - `.command` 파일은 `open -a Terminal` 로 연다 — AppleScript 권한(자동화 승인)이 필요 없다.
use crate::claude_accounts::under;
use crate::claude_login::{ATTENTION_FILE, GLOBAL_CONFIG_FILE, mark_account_gates};
use serde_json::{Map, Value};
use std::fs;
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

/// `.command` 파일을 여는 함수. 시험은 가짜를 끼운다 — 진짜 창을 띄우지 않게.
pub type OpenInTerminal<'a> = dyn Fn(&Path) -> Result<(), String> + 'a;

/// 셸 단일따옴표 인용(TS `shQuote`). 경로에 `'` 가 들어 있어도 깨지지 않는다.
pub fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// 사람에게 여는 터미널의 스크립트(TS `terminalScript`). `claude` 가 끝나면 관문 표식을 지운다 — 사람이 그 화면을
/// 지났든 아니든 다음 턴이 다시 재 보고, 아직 막혀 있으면 러너가 표식을 다시 세운다.
pub fn terminal_script(config_dir: &Path, work_dir: &Path, label: &str) -> String {
    let config = config_dir.to_string_lossy();
    let work = work_dir.to_string_lossy();
    let attention = config_dir.join(ATTENTION_FILE);
    [
        "#!/bin/zsh -l".to_string(),
        format!("cd {} || exit 1", sh_quote(&work)),
        format!("export CLAUDE_CONFIG_DIR={}", sh_quote(&config)),
        format!(
            "echo {}",
            sh_quote(&format!(
                "harkroom: {label} 계정의 Claude Code 다. 뜨는 화면을 직접 고르고, 끝나면 /exit 로 나온다."
            ))
        ),
        "claude".to_string(),
        format!("rm -f {}", sh_quote(&attention.to_string_lossy())),
        // 막 만든 작업 폴더를 치운다. 비었을 때만 지워진다(`rmdir`) — 사람이 무언가 남겼으면 그대로 둔다.
        format!("cd / && rmdir {} 2>/dev/null", sh_quote(&work)),
        format!(
            "echo {}",
            sh_quote("harkroom: 끝났다. 이 창은 닫아도 된다 — 다음 턴부터 이 계정을 다시 쓴다.")
        ),
        String::new(),
    ]
    .join("\n")
}

/// TS `markClaudeWorkspaceTrusted` — 이 디렉터리를 그 계정이 **신뢰한 작업 폴더**로 적는다(없을 때만). 썼으면 참.
/// 깨졌거나 객체가 아니면 **쓰지 않는다**(하네스 상태를 덮지 않는다, `mark_account_gates` 와 같은 규율).
pub fn mark_workspace_trusted(config_dir: &Path, workspace_dir: &Path) -> Result<bool, String> {
    let path = config_dir.join(GLOBAL_CONFIG_FILE);
    let mut doc = match fs::read_to_string(&path) {
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
    let key = workspace_dir.to_string_lossy().into_owned();
    let mut projects = doc
        .get("projects")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut entry = projects
        .get(&key)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if entry.get("hasTrustDialogAccepted") == Some(&Value::Bool(true)) {
        return Ok(false);
    }
    entry.insert("hasTrustDialogAccepted".into(), Value::Bool(true));
    projects.insert(key, Value::Object(entry));
    doc.insert("projects".into(), Value::Object(projects));
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(config_dir)
        .map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(&Value::Object(doc)).map_err(|e| e.to_string())?;
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

/// `base` 아래 `session-<무작위>` 빈 폴더를 0700 으로 새로 만든다(TS `mkdtemp`). 있던 폴더는 쓰지 않는다 — `create_dir`
/// 가 이미 있으면 실패하므로 다른 이름으로 다시 한다.
fn make_session_dir(base: &Path) -> Result<PathBuf, String> {
    for _ in 0..8 {
        let name = format!(
            "session-{}",
            crate::endpoint::random_hex(6).map_err(|e| e.to_string())?
        );
        let dir = base.join(name);
        match fs::DirBuilder::new().mode(0o700).create(&dir) {
            Ok(()) => return Ok(dir),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.to_string()),
        }
    }
    Err("터미널 작업 폴더를 만들지 못했다".into())
}

/// 계정 터미널을 연다(TS `ClaudeAccountsPort.openTerminal`). 없는 계정은 거절한다.
pub fn open_terminal(
    root: &Path,
    pool: &str,
    account: &str,
    open: &OpenInTerminal<'_>,
) -> Result<(), String> {
    let dir = under(root, &[pool, account])?;
    if !fs::metadata(&dir).map(|m| m.is_dir()).unwrap_or(false) {
        return Err(format!("계정이 없다: {pool}/{account}"));
    }
    let base = root.join(".terminal");
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&base)
        .map_err(|e| e.to_string())?;
    let work_dir = make_session_dir(&base)?;
    // 폴더 신뢰 화면·첫 실행 화면이 먼저 뜨면 사람이 고쳐야 할 관문이 그 뒤에 가린다 — 미리 지난다.
    // 못 적었어도 터미널은 연다(TS `.catch(() => undefined)`).
    let _ = mark_account_gates(&dir);
    let _ = mark_workspace_trusted(&dir, &work_dir);
    let script = base.join(format!("{pool}-{account}.command"));
    let body = terminal_script(&dir, &work_dir, &format!("{pool}/{account}"));
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o700)
        .open(&script)
        .map_err(|e| e.to_string())?;
    f.write_all(body.as_bytes()).map_err(|e| e.to_string())?;
    drop(f);
    // 이미 있던 스크립트면 `mode` 가 안 먹는다 — 실행 권한을 다시 못박는다.
    fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    open(&script)
}

/// 운영 배선: `open -a Terminal <스크립트>`(TS `nodeOpenInTerminal`).
pub fn os_open_in_terminal(script: &Path) -> Result<(), String> {
    let status = std::process::Command::new("open")
        .arg("-a")
        .arg("Terminal")
        .arg(script)
        .status()
        .map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("open -a Terminal 실패: {status}"))
    }
}

#[cfg(test)]
#[path = "claude_terminal_tests.rs"]
mod tests;
