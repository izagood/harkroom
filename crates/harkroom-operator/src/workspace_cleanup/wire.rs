//! 작업 폴더 청소 배선(s21c5-4) — TS `run.ts` 의 `createCleanupOwners`(377~382)·`createWorkspaceCleanup`(767~788) 한 벌.
//! serve 가 서버 링크를 세울 때(= 이 커뮤니티의 오퍼레이터 토큰이 있을 때) 한 번 부른다.

use super::owners::{CleanupOwners, cleanup_owners_path};
use super::ports::GitPorts;
use super::scan::ScanDeps;
use super::service::{CleanupServiceDeps, WorkspaceCleanup, read_cleanup_settings};
use crate::local_agents::LocalAgents;
use crate::runner_link::RunnerLinkServer;
use harkroom_proto::p1::RunnerLinkKind;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

/// TS `GIT_PATH`.
pub const GIT_PATH: &str = "/usr/bin/git";
/// 기동 직후 러너 채택·커뮤니티 연결과 겹치지 않게 1분 뒤 첫 회차(TS `setTimeout(runCleanup, 60_000)`).
const BOOT_DELAY: Duration = Duration::from_secs(60);
/// 그 뒤 1시간마다(TS `setInterval(runCleanup, 60 * 60_000)`).
const EVERY: Duration = Duration::from_secs(60 * 60);

/// 지키는 자리(security c5 조건 2). `protected` = 같거나 조상이면 거절, `deny_inside` = 안쪽도 거절.
/// 모두 실제 경로(canonicalize)로 넣는다 — 없는 자리는 뺀다(없는 것은 지울 수도 없다).
pub fn protected_roots(
    home: &str,
    app_data: &Path,
    claude_root: &Path,
    codex_root: &Path,
) -> (Vec<String>, Vec<String>) {
    let canon = |p: &Path| {
        std::fs::canonicalize(p)
            .ok()
            .map(|c| c.to_string_lossy().into_owned())
    };
    let home_p = Path::new(home);
    let deny_inside: Vec<String> = [app_data, claude_root, codex_root]
        .into_iter()
        .filter_map(canon)
        .collect();
    let mut protected: Vec<String> = [home_p.to_path_buf(), home_p.join(".harkroom-agent")]
        .iter()
        .filter_map(|p| canon(p))
        .collect();
    for d in &deny_inside {
        if !protected.contains(d) {
            protected.push(d.clone());
        }
    }
    (protected, deny_inside)
}

/// 설정 파일의 모든 커뮤니티 에이전트(id·workingDir) — TS `agents`.
fn configured_agents(config: &LocalAgents) -> Vec<(String, Option<String>)> {
    let Ok(c) = config.read_config() else {
        return Vec::new();
    };
    let Some(communities) = c.get("communities").and_then(Value::as_object) else {
        return Vec::new();
    };
    communities
        .values()
        .filter_map(|s| s.get("agents").and_then(Value::as_object))
        .flat_map(|agents| {
            agents.iter().map(|(id, a)| {
                let wd = a
                    .get("workingDir")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                (id.clone(), wd)
            })
        })
        .collect()
}

pub struct WireInputs {
    pub config: LocalAgents,
    pub app_data: PathBuf,
    pub home: String,
    pub base_url: String,
    pub token: String,
    pub runner_link: Arc<RunnerLinkServer>,
    pub owners_slot: Arc<OnceLock<Arc<CleanupOwners>>>,
}

/// 주인 장부를 relay 가로채기 자리에 걸고, 서비스를 만들어 돌려준다. 주기 sweep 스레드도 여기서 띄운다.
pub fn wire(w: WireInputs) -> Arc<WorkspaceCleanup> {
    let now = || {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as u64)
    };
    let enabled_cfg = w.config.clone();
    let link = Arc::clone(&w.runner_link);
    let owners = Arc::new(CleanupOwners::new(
        cleanup_owners_path(&w.app_data),
        Box::new(now),
        Box::new(move || read_cleanup_settings(&enabled_cfg).enabled),
        Some(Box::new(move || link.linked_agents())),
        Box::new(|l: &str| eprintln!("{l}")),
    ));
    let _ = w.owners_slot.set(Arc::clone(&owners));

    let env = |k: &str| std::env::var(k).ok();
    let (protected, deny_inside) = protected_roots(
        &w.home,
        &w.app_data,
        &crate::claude_accounts::claude_accounts_root(env, &w.home),
        &crate::codex_accounts::codex_accounts_root(env, &w.home),
    );
    let scan = Arc::new(ScanDeps {
        exec: crate::local_merge::default_exec(),
        git_path: GIT_PATH.into(),
        gh_path: crate::local_merge::default_gh_path(),
        gh_env: crate::local_merge::gh_env(&w.home, None),
        home: w.home.clone(),
        protected,
    });
    let agents_cfg = w.config.clone();
    let (base_url, token) = (w.base_url, w.token);
    let tr = crate::forward::UreqTransport::default();
    let svc = Arc::new(WorkspaceCleanup::new(
        CleanupServiceDeps {
            ledger_path: super::cleanup_ledger_path(&w.app_data),
            config: w.config,
            owners,
            agents: Box::new(move || configured_agents(&agents_cfg)),
            forward: Box::new(move |agent_id, req| {
                let target = crate::forward::ForwardTarget {
                    base_url: base_url.clone(),
                    token: token.clone(),
                    agent_id: agent_id.to_string(),
                };
                crate::forward::forward(&tr, &target, req, RunnerLinkKind::Relay)
            }),
            scan: Arc::clone(&scan),
            now: Box::new(now),
            log: Box::new(|l: &str| eprintln!("{l}")),
        },
        Box::new(GitPorts {
            deps: scan,
            deny_inside,
        }),
    ));
    let weak = Arc::downgrade(&svc);
    std::thread::Builder::new()
        .name("workspace-cleanup".into())
        .spawn(move || {
            std::thread::sleep(BOOT_DELAY);
            loop {
                let Some(s) = weak.upgrade() else { return };
                if let Err(e) = s.sweep() {
                    eprintln!("cleanup 실패: {e}");
                }
                drop(s);
                std::thread::sleep(EVERY);
            }
        })
        .ok();
    svc
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protected_roots_are_real_paths_and_skip_missing() {
        let t = std::env::temp_dir().join(format!("hk-wire-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&t);
        std::fs::create_dir_all(&t).unwrap();
        let home = std::fs::canonicalize(&t).unwrap();
        let app = home.join("app");
        std::fs::create_dir_all(&app).unwrap();
        std::fs::create_dir_all(home.join(".harkroom-agent")).unwrap();
        std::os::unix::fs::symlink(&app, home.join("claude")).unwrap();
        let (protected, deny) = protected_roots(
            home.to_str().unwrap(),
            &app,
            &home.join("claude"),
            &home.join("nope"),
        );
        let s = |p: &Path| p.to_string_lossy().into_owned();
        assert_eq!(deny, vec![s(&app), s(&app)]);
        assert_eq!(
            protected,
            vec![s(&home), s(&home.join(".harkroom-agent")), s(&app)]
        );
        let _ = std::fs::remove_dir_all(&t);
    }
}
