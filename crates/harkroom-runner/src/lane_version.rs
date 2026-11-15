//! API 키 연결 판 확인에 쓰는 하네스 판(정본 `main.ts` 672 `harnessVersion`) — `<하네스> --version` 출력.
//!
//! - **기억하지 않고 턴마다 묻는다**(security F1) — opencode 는 러너 모르게 스스로 업데이트할 수 있다.
//! - env 는 PATH(하네스 PATH)·HOME 만. omp 는 natives 캐시를 `$HOME/.omp` 에서 실행 코드로 싣는다(security C3) — 러너 omp 홈의
//!   HOME 을 준다. pi 는 런처를 거치지 않고 release 실행 파일로 묻는다(#2155 — 사람 `install/` 을 건드리지 않게).
//! - codex 는 `--version` 에도 `$CODEX_HOME/tmp/arg0` 에 도우미 링크·잠금을 만든다(없으면 `~/.codex`) — **러너 codex 홈을 `CODEX_HOME`**
//!   으로 준다. 러너 codex 홈을 모르면 묻지 않는다(사람 `~/.codex` 를 건드리지 않게).
//! - pi 는 `PI_CODING_AGENT_DIR` 가 없으면 `--version` 에도 사람 `$HOME/.pi/agent` 를 건드린다(빈 HOME 실측) — **러너 pi 홈을
//!   `PI_CODING_AGENT_DIR`**(lane 이면 lane 루트)로 준다. 러너 pi 홈을 모르면 묻지 않는다.
//! - 못 띄우거나 출력이 비면 `None` — 판 확인은 막지 않고 경고만 낸다(`provider_lane`).

use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::adapter::{AgentHarness, harness_command, uses_omp_home, uses_pi_home};
use crate::config::Env;

/// 판을 묻는 시한(정본 15초).
pub const HARNESS_VERSION_TIMEOUT: Duration = Duration::from_secs(15);
const HARNESS_VERSION_MAX_BYTES: usize = 4096;

/// 판을 물을 env(PATH·HOME 만)와 띄울 실행 파일. 실행 파일을 못 찾으면 `None`.
pub fn version_query(
    harness: AgentHarness,
    base_path: Option<&str>,
    home: &Path,
    omp_home: Option<&Path>,
    codex_home: Option<&Path>,
    pi_home: Option<&Path>,
) -> Option<(PathBuf, Env)> {
    let bin = harness_command(harness).ok()?;
    let codex_home = if harness == AgentHarness::Codex {
        Some(codex_home?)
    } else {
        None
    };
    let pi_home = if uses_pi_home(harness) {
        Some(pi_home?)
    } else {
        None
    };
    let path = crate::turn_env::harness_path(harness, base_path, home);
    let run_home = if uses_omp_home(harness) {
        crate::omp_home::omp_dirs(omp_home?).home
    } else {
        home.to_path_buf()
    };
    let mut env: Env = [
        ("PATH".to_string(), path),
        ("HOME".to_string(), run_home.to_string_lossy().into_owned()),
    ]
    .into();
    if let Some(ch) = codex_home {
        env.insert("CODEX_HOME".to_string(), ch.to_string_lossy().into_owned());
    }
    if let Some(ph) = pi_home {
        env.insert(
            "PI_CODING_AGENT_DIR".to_string(),
            ph.to_string_lossy().into_owned(),
        );
    }
    let command = if uses_pi_home(harness) {
        let launch = crate::pi_launch::resolve_pi_launch(&env);
        crate::pi_launch::apply_pi_launch_env(&mut env, &launch);
        launch.command
    } else {
        bin.to_string()
    };
    let exe = crate::pty_proc::resolve_executable(&command, env.get("PATH").map(String::as_str))?;
    Some((exe, env))
}

/// `<하네스> --version` 을 묻는다. 실패·빈 출력이면 `None`.
pub fn read_harness_version(
    harness: AgentHarness,
    base_path: Option<&str>,
    home: &Path,
    omp_home: Option<&Path>,
    codex_home: Option<&Path>,
    pi_home: Option<&Path>,
) -> Option<String> {
    let (exe, env) = version_query(harness, base_path, home, omp_home, codex_home, pi_home)?;
    let out = crate::pi_home::run_capped_with(
        &exe,
        &["--version".to_string()],
        &env,
        Path::new("/"),
        HARNESS_VERSION_MAX_BYTES,
        HARNESS_VERSION_TIMEOUT,
    )
    .ok()?;
    let t = out.trim();
    (!t.is_empty()).then(|| t.to_string())
}

#[cfg(test)]
#[path = "lane_version_tests.rs"]
mod tests;
