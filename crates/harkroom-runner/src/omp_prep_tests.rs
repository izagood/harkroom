use super::*;
use std::fs;
use std::os::unix::fs::symlink;
use std::sync::atomic::{AtomicU64, Ordering};

struct Tmp(PathBuf);
impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn tmpdir() -> Tmp {
    static N: AtomicU64 = AtomicU64::new(0);
    let d = std::env::temp_dir().join(format!(
        "hk-ompprep-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(d.join("state")).unwrap();
    Tmp(d)
}

fn prep(t: &Tmp) -> OmpPrep {
    let mcp = t.0.join("mcp.json");
    fs::write(
        &mcp,
        r#"{"mcpServers":{"harkroom":{"type":"stdio","command":"/opt/harkroom/harkroom-operator","args":["mcp-bridge"]}}}"#,
    )
    .unwrap();
    let state = t.0.join("state");
    OmpPrep {
        home: omp_home_root(&state).unwrap(),
        mcp_config_path: mcp,
        state_dir: state,
    }
}

/// 루트는 상태 폴더 안 `omp-home` 이고, 링크면 거절한다(사람 폴더로 새지 않게).
#[test]
fn root_is_under_state_and_refuses_symlink() {
    let t = tmpdir();
    let state = t.0.join("state");
    assert_eq!(omp_home_root(&state).unwrap(), state.join("omp-home"));
    let t2 = tmpdir();
    let other = t2.0.join("elsewhere");
    fs::create_dir_all(&other).unwrap();
    symlink(&other, t2.0.join("state/omp-home")).unwrap();
    assert!(omp_home_root(&t2.0.join("state")).is_err());
}

/// ensure 가 루트에 오버레이·config.yml·mcp.json 을 쓰고, 스레드 자리는 루트 안에만 생긴다. 세션 헤더도 루트 sessions 에.
#[test]
fn ensure_and_prepare_thread_stay_under_root() {
    let t = tmpdir();
    let p = prep(&t);
    p.ensure().unwrap();
    let d = omp_dirs(&p.home);
    assert!(d.agent_dir.join("mcp.json").is_file());
    assert!(d.agent_dir.join("config.yml").is_file());
    let th = p
        .prepare_thread("ch/thread", "11111111-2222-4333-8444-555555555555", None)
        .unwrap();
    assert!(th.cwd.starts_with(&p.home) && th.agent_dir.starts_with(&p.home));
    assert!(th.cwd.join(".git").exists());
    assert!(th.agent_dir.join("mcp.json").is_file());
    let headers: Vec<_> = fs::read_dir(&d.sessions_dir).unwrap().collect();
    assert_eq!(headers.len(), 1);
}

/// 앞 턴이 cwd 에 남긴 것은 옮겨지고 cwd 에는 `.git` 만 남는다.
#[test]
fn prepare_thread_sweeps_leftovers() {
    let t = tmpdir();
    let p = prep(&t);
    p.ensure().unwrap();
    let th = p
        .prepare_thread("k", "11111111-2222-4333-8444-555555555555", None)
        .unwrap();
    fs::write(th.cwd.join("AGENTS.md"), "x").unwrap();
    p.prepare_thread("k", "11111111-2222-4333-8444-555555555555", None)
        .unwrap();
    let names: Vec<String> = fs::read_dir(&th.cwd)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names, vec![".git".to_string()]);
}
