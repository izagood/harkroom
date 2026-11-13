//! 계정 표식 파일 쓰기·지우기(정본 `shared/claudeGates.ts` — `markAccountNeedsAttention`·`clearAccountAttention`·
//! `markAccountCredentialFailed`·`clearAccountCredentialFailure`). 읽기는 `account_assign::shared` 다.
//!
//! 표식은 **그 계정의 config 디렉터리 안**에 있다(`.harkroom-attention.json` 관문, `.harkroom-auth.json` 로그인 풀림) —
//! 자리가 곧 계정이라 본문에는 계정 이름·경로·id 를 싣지 않는다. 본문은 `{"kind","atMs"}` 둘뿐이고(정본·오퍼레이터가
//! 같은 꼴로 읽는다), 화면 원문도 싣지 않는다.
//!
//! - 쓰기: 0600 임시 파일(`create_new`·`O_NOFOLLOW`) → `rename`. 표식 자리에 링크가 있으면 **링크째 바뀐다**(대상을
//!   덮지 않는다). 여러 writer(러너 여럿·오퍼레이터)가 있어도 마지막 writer 가 이기고 뜻은 같다.
//! - 지우기: 그 자리의 것을 지운다 — 링크면 링크만 지운다(대상은 그대로). 디렉터리면 건드리지 않는다.
//! - 실패는 사유를 로컬 로그에만 남기고 삼킨다(정본 `.catch(() => undefined)`) — 표식이 턴을 죽이지 않는다.

use std::fs;
use std::io;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use crate::account_assign::shared::{CLAUDE_ATTENTION_FILE, CLAUDE_AUTH_FILE};
use crate::link::random_uuid;

fn write_marker(config_dir: &Path, file: &str, kind: &str, at_ms: u64) -> io::Result<()> {
    let path = config_dir.join(file);
    let tmp = PathBuf::from(format!("{}.tmp-{}", path.display(), random_uuid()));
    let body = serde_json::json!({ "kind": kind, "atMs": at_ms }).to_string();
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
        fs::rename(&tmp, &path)
    })();
    if res.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    res
}

fn clear_marker(config_dir: &Path, file: &str) -> io::Result<bool> {
    let path = config_dir.join(file);
    match fs::symlink_metadata(&path) {
        Ok(m) if m.is_dir() => Ok(false),
        Ok(_) => fs::remove_file(&path).map(|()| true),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e),
    }
}

fn log_err(what: &str, e: &io::Error) {
    eprintln!("[account] {what} 실패 — {:?}", e.kind());
}

/// 관문 표식을 세운다(정본 `markAccountNeedsAttention`). 실패는 로그만.
pub fn mark_attention(config_dir: &Path, at_ms: u64) {
    if let Err(e) = write_marker(config_dir, CLAUDE_ATTENTION_FILE, "gate", at_ms) {
        log_err("관문 표식 쓰기", &e);
    }
}

/// 관문 표식을 지운다. 지웠으면 `true`(정본 `clearAccountAttention`).
pub fn clear_attention(config_dir: &Path) -> bool {
    clear_marker(config_dir, CLAUDE_ATTENTION_FILE).unwrap_or_else(|e| {
        log_err("관문 표식 지우기", &e);
        false
    })
}

/// 로그인 풀림 표식을 세운다(정본 `markAccountCredentialFailed`). 실패는 로그만.
pub fn mark_credential_failed(config_dir: &Path, at_ms: u64) {
    if let Err(e) = write_marker(config_dir, CLAUDE_AUTH_FILE, "credential", at_ms) {
        log_err("로그인 풀림 표식 쓰기", &e);
    }
}

/// 로그인 풀림 표식을 지운다. 지웠으면 `true`(정본 `clearAccountCredentialFailure`).
pub fn clear_credential_failure(config_dir: &Path) -> bool {
    clear_marker(config_dir, CLAUDE_AUTH_FILE).unwrap_or_else(|e| {
        log_err("로그인 풀림 표식 지우기", &e);
        false
    })
}

#[cfg(test)]
#[path = "account_marks_tests.rs"]
mod tests;
