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
use crate::codex_rules::{
    CodexHookListEntry, CodexRulesDeps, CodexRulesError, ListHooksError, ListHooksOpts,
    PrepareCodexRules, codex_rules_path, list_codex_hooks, prepare_codex_rules, sweep_codex_rules,
};
use crate::config::Env;
use std::sync::Arc;

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

/// API 키 연결 러너의 codex 홈(`<state>/codex-provider-lane`). claude lane 폴더와 같은 검사로 만든다(security #2141 조건) —
/// 링크·폴더 아님·남의 소유면 거절한다(lane 키와 링크 너머 로그인이 섞이지 않게).
pub fn codex_lane_home(state_dir: &Path) -> std::io::Result<PathBuf> {
    let home = state_dir.join("codex-provider-lane");
    crate::account_lane::ensure_lane_dir(&home)?;
    Ok(home)
}

/// 한 러너의 codex 턴 준비 묶음 — 홈 자리와 바깥(판·hook 목록) 손잡이.
#[derive(Clone)]
pub struct CodexTurn {
    pub prep: CodexPrep,
    pub deps: Arc<dyn CodexRulesDeps + Send + Sync>,
}

impl CodexTurn {
    /// 턴 직전(모든 codex 턴): 로그인 링크 맞추기 + 남은 규칙 지우기.
    pub fn before_turn(&self) -> Result<(), String> {
        self.prep.run(self.deps.as_ref())
    }

    /// 승인 명령 규칙·hook(c2, 정본 `prepareCodexRules`) — 열쇠 있는 auto 턴에만 부른다. `rules`·`reach` 는 **서버 승인 목록**
    /// (`tool_rule_sets` → `safe_tool_allows`)이다. 규칙을 쓰면 그 턴의 hook 판정 값(`HARKROOM_CODEX_HOOK_SPEC`)을 돌려준다.
    pub fn rules(
        &self,
        workspace_dir: &Path,
        rules: &[String],
        reach: Option<&[String]>,
        operator_bin: &str,
    ) -> Result<Option<String>, CodexRulesError> {
        let env = prepare_codex_rules(
            &PrepareCodexRules {
                codex_home: &self.prep.home,
                workspace_dir,
                operator_bin,
                rules,
                reach,
            },
            self.deps.as_ref(),
        )?;
        Ok(env.get(crate::turn_env::CODEX_HOOK_SPEC_ENV).cloned())
    }

    /// 시도가 끝나면 규칙 파일을 지운다(c2) — 다음 턴은 그 턴의 서버 목록으로 다시 쓴다. hook(`hooks.json`)은 고정 명령이라 둔다
    /// (판정 값이 없는 턴의 hook 은 막는다).
    pub fn end_turn(&self) {
        let p = codex_rules_path(&self.prep.home);
        match std::fs::remove_file(&p) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => self.deps.log(&format!(
                "[codexRules] 턴 뒤 규칙 파일을 지우지 못했다: {}",
                e.kind()
            )),
        }
    }
}

/// 실물 — `codex --version` 을 시한 안에서 묻고, hook 목록은 codex 자신(`app-server` 의 `hooks/list`)에게 묻는다.
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
        codex_home: &Path,
        cwd: &Path,
    ) -> Result<Vec<CodexHookListEntry>, ListHooksError> {
        let Some(bin) = crate::pty_proc::resolve_executable("codex", Some(&self.path)) else {
            return Err(ListHooksError::Failed);
        };
        list_codex_hooks(&ListHooksOpts {
            codex_bin: &bin,
            codex_home,
            cwd,
            path: &self.path,
            home: Some(&self.home),
            timeout: Duration::from_secs(20),
        })
    }

    fn log(&self, line: &str) {
        eprintln!("{line}");
    }
}

#[cfg(test)]
#[path = "codex_prep_tests.rs"]
mod tests;
