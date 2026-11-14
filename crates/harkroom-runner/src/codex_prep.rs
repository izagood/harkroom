//! codex 턴 직전 준비(c1) — 정본 `mentionTurn.ts` 의 `deps.syncCodexAuth`(2661)·`deps.sweepCodexRules`(1694).
//!
//! 1. 활성 codex 계정에 격리 홈의 로그인 링크를 맞춘다(lane 러너는 안 한다 — 로그인이 아니라 그 턴 키로 돈다).
//!    **실패해도 턴을 죽이지 않는다** — 기동 때 건 링크가 남아 직전 계정으로 돈다(정본과 같음).
//! 2. 남은 승인 명령 규칙 파일을 지운다(security F1) — Rust 러너는 아직 규칙 파일을 쓰지 않는다(`prepareCodexRules` 는 c2).
//!    잰 판 밖이면 지우고, 지우다 실패하면 턴을 띄우지 않는다(정본은 await 가 던진다).

use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::adapter::AgentHarness;
use crate::codex_home::sync_codex_auth;
use crate::codex_rules::{CodexHookListEntry, CodexRulesDeps, ListHooksError, sweep_codex_rules};
use crate::config::Env;

/// 러너 하나의 codex 홈 자리.
#[derive(Clone, Debug)]
pub struct CodexPrep {
    /// 격리 `CODEX_HOME`.
    pub home: PathBuf,
    /// 턴마다 활성 계정 링크를 맞추나(lane 러너는 `false`).
    pub sync_auth: bool,
    /// 활성 계정 자리를 읽을 러너 env(`HARKROOM_OPERATOR_ROOT` 등).
    pub env: Env,
}

impl CodexPrep {
    /// 턴 직전 차례. `Err` 면 턴을 띄우지 않는다.
    pub fn run(&self, deps: &dyn CodexRulesDeps) -> Result<(), String> {
        if self.sync_auth
            && let Err(e) = sync_codex_auth(&self.home, &self.env)
        {
            deps.log(&format!(
                "[mentionTurn] codex 계정 링크 갱신 실패 — 직전 계정으로 돈다: {e}"
            ));
        }
        sweep_codex_rules(&self.home, deps)
            .map_err(|e| format!("codex 규칙 파일을 지우지 못했다: {}", e.kind()))
    }
}

/// 실물 — `codex --version` 을 시한 안에서 묻는다. hook 목록은 c1 에서 쓰지 않는다(규칙 파일을 안 쓴다).
pub struct SystemCodexDeps {
    path: String,
    home: PathBuf,
}

impl SystemCodexDeps {
    pub fn new(base_path: Option<&str>, home: &Path) -> Self {
        SystemCodexDeps {
            path: crate::turn_env::harness_path(AgentHarness::Codex, base_path, home),
            home: home.to_path_buf(),
        }
    }
}

impl CodexRulesDeps for SystemCodexDeps {
    fn version(&self) -> Option<String> {
        let bin = crate::pty_proc::resolve_executable("codex", Some(&self.path))?;
        let env: Env = [
            ("PATH".to_string(), self.path.clone()),
            ("HOME".to_string(), self.home.to_string_lossy().into_owned()),
        ]
        .into();
        crate::pi_home::run_capped_with(
            &bin,
            &["--version".to_string()],
            &env,
            Path::new("/"),
            4096,
            Duration::from_secs(10),
        )
        .ok()
    }

    fn list_hooks(
        &self,
        _codex_home: &Path,
        _cwd: &Path,
    ) -> Result<Vec<CodexHookListEntry>, ListHooksError> {
        Err(ListHooksError::Failed)
    }

    fn log(&self, line: &str) {
        eprintln!("{line}");
    }
}

#[cfg(test)]
#[path = "codex_prep_tests.rs"]
mod tests;
