//! 러너의 stdout·stderr 를 받는 **파일**과 종료 통지의 꼬리(`tailLines`) — 정본은 `packages/operator/src/runnerLog.ts`(`#434`·`#473`).
//!
//! **옮긴 성질**(TS 와 같다 — 근거는 TS 모듈 주석):
//! - 파이프가 아니라 파일이다. 오퍼레이터가 죽어도 러너가 EPIPE 로 죽지 않고, 안 읽어도 쓰기가 막히지 않는다.
//! - 러너(에이전트)마다 파일을 나눈다 — 78 종료의 사유는 **그 러너 로그의 마지막 줄**로만 가린다.
//! - 회전은 spawn 직전 한 번(러너가 아직 안 연 파일만 민다). 상한 8MiB, `.1` 하나만 남긴다.
//! - 파일 이름은 `[A-Za-z0-9_-]` 밖을 `_` 로, 64자로 자른다 — `agentId` 는 소켓 너머에서 온다(경로 주입 경계).
//! - 열지 못해도 러너는 띄운다(출력만 버린다). 꼬리를 못 읽으면 빈 배열 — 지어내지 않는다(`#368`).
//! - 꼬리는 끝에서 64KiB 만 되짚고, 창이 파일 중간에서 시작했으면 첫 줄(반쪽)을 버린다. 최대 20줄.
//! - 오퍼레이터는 꼬리를 해석하지 않는다 — 사유 판정(`runner_exit_reason`)은 shared `runnerExitReason` 과 같은 규칙 한 곳.
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

/// TS `RUNNER_LOG_MAX_BYTES`.
pub const RUNNER_LOG_MAX_BYTES: u64 = 8 * 1024 * 1024;
/// TS `RUNNER_LOG_KEEP` — `.1` 하나.
pub const RUNNER_LOG_KEEP: u32 = 1;
/// TS `RUNNER_EXIT_TAIL_LINES`.
pub const RUNNER_EXIT_TAIL_LINES: usize = 20;
/// TS `RUNNER_TAIL_READ_BYTES`.
pub const RUNNER_TAIL_READ_BYTES: u64 = 64 * 1024;

/// shared `CREDENTIAL_REJECTED_LINE`·`EXECUTABLE_NOT_FOUND_LINE`·`HARNESS_LOGIN_REQUIRED_LINE` — 러너가 78 로 물러날 때 찍는 줄.
pub const CREDENTIAL_REJECTED_LINE: &str =
    "harkroom-agent: credential rejected (revoked or rotated); exiting";
pub const EXECUTABLE_NOT_FOUND_LINE: &str = "harkroom-agent: harness executable not found; exiting";
pub const HARNESS_LOGIN_REQUIRED_LINE: &str =
    "harkroom-agent: harness login required (expired or revoked); exiting";

/// TS `runnerLogFileName`.
pub fn runner_log_file_name(agent_id: &str) -> String {
    let safe: String = agent_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .take(64)
        .collect();
    format!(
        "runner-{}.log",
        if safe.is_empty() { "unnamed" } else { &safe }
    )
}

/// TS `runnerLogPath` — `<appDataDir>/operator/runner-<agentId>.log`. 경로 규칙은 여기 하나뿐이다.
pub fn runner_log_path(app_data_dir: &Path, agent_id: &str) -> PathBuf {
    app_data_dir
        .join("operator")
        .join(runner_log_file_name(agent_id))
}

/// TS `openRunnerLog` — 필요하면 먼저 회전하고(여는 것보다 **먼저**) append·0600 으로 연다. 못 열면 None(사유는 `log`).
pub fn open_runner_log(
    app_data_dir: &Path,
    agent_id: &str,
    max_bytes: u64,
    log: &dyn Fn(&str),
) -> Option<(File, PathBuf)> {
    let path = runner_log_path(app_data_dir, agent_id);
    let opened = std::fs::create_dir_all(app_data_dir.join("operator")).and_then(|()| {
        rotate_if_large(&path, max_bytes, log);
        OpenOptions::new()
            .append(true)
            .create(true)
            .mode(0o600)
            .open(&path)
    });
    match opened {
        Ok(f) => Some((f, path)),
        Err(e) => {
            log(&format!(
                "러너 로그 파일을 열지 못했다 — 출력을 버린다: `{}`: {e}",
                path.display()
            ));
            None
        }
    }
}

fn rotate_if_large(path: &Path, max_bytes: u64, log: &dyn Fn(&str)) {
    let Ok(meta) = std::fs::metadata(path) else {
        return; // 아직 없다 — 첫 기동.
    };
    let size = meta.len();
    if size <= max_bytes {
        return;
    }
    let rotated = PathBuf::from(format!("{}.{RUNNER_LOG_KEEP}", path.display()));
    let _ = std::fs::remove_file(&rotated);
    match std::fs::rename(path, &rotated) {
        Ok(()) => log(&format!(
            "러너 로그가 {size}바이트로 상한 {max_bytes}바이트를 넘어 밀었다: `{}`",
            rotated.display()
        )),
        Err(e) => log(&format!(
            "러너 로그를 밀지 못했다 — 계속 이어 쓴다: `{}`: {e}",
            path.display()
        )),
    }
}

/// TS `readRunnerLogTail` — 마지막 `max_lines` 줄을 그대로. 못 읽으면 빈 배열.
pub fn read_runner_log_tail(path: &Path, max_lines: usize) -> Vec<String> {
    let read = || -> std::io::Result<Vec<String>> {
        let mut f = File::open(path)?;
        let size = f.metadata()?.len();
        let start = size.saturating_sub(RUNNER_TAIL_READ_BYTES);
        if size == start {
            return Ok(Vec::new());
        }
        f.seek(SeekFrom::Start(start))?;
        let mut buf = Vec::with_capacity((size - start) as usize);
        f.take(size - start).read_to_end(&mut buf)?;
        // TS `Buffer.toString('utf8')` 처럼 깨진 바이트는 U+FFFD 로 — 던지지 않는다.
        let text = String::from_utf8_lossy(&buf);
        let mut lines: Vec<&str> = text.split('\n').collect();
        if start > 0 && !lines.is_empty() {
            lines.remove(0); // 창이 줄 한가운데서 시작했다 — 반쪽 줄은 버린다.
        }
        let kept: Vec<String> = lines
            .into_iter()
            .map(|l| l.strip_suffix('\r').unwrap_or(l))
            .filter(|l| !l.trim().is_empty())
            .map(str::to_string)
            .collect();
        let skip = kept.len().saturating_sub(max_lines);
        Ok(kept.into_iter().skip(skip).collect())
    };
    read().unwrap_or_default()
}

/// shared `runnerExitReason` — 셋 중 **하나만** 보일 때만 단정한다. 없거나 둘 이상이면 None.
pub fn runner_exit_reason(tail_lines: &[String]) -> Option<&'static str> {
    let has = |m: &str| tail_lines.iter().any(|l| l.contains(m));
    let credential = has(CREDENTIAL_REJECTED_LINE);
    let harness_login = has(HARNESS_LOGIN_REQUIRED_LINE);
    let not_found = has(EXECUTABLE_NOT_FOUND_LINE);
    let seen = [credential, harness_login, not_found]
        .iter()
        .filter(|b| **b)
        .count();
    if seen != 1 {
        return None;
    }
    Some(if not_found {
        "executable-not-found"
    } else if harness_login {
        "harness-login-required"
    } else {
        "credential-rejected"
    })
}

#[cfg(test)]
mod tests;
