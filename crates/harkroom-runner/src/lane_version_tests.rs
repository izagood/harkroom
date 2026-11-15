use super::*;
use std::fs;
use std::os::unix::fs::PermissionsExt;
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
        "hk-lanever-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(d.join("bin")).unwrap();
    Tmp(d)
}

/// 가짜 하네스: `--version` 이면 판과 함께 받은 env 이름을 찍는다.
fn fake(t: &Tmp, name: &str, version: &str) {
    let p = t.0.join("bin").join(name);
    fs::write(
        &p,
        format!(
            "#!/bin/sh\n[ \"$1\" = --version ] || exit 2\necho '{version}'\nenv | cut -d= -f1 | sort | tr '\\n' ' ' >&2\n"
        ),
    )
    .unwrap();
    fs::set_permissions(&p, fs::Permissions::from_mode(0o755)).unwrap();
}

#[test]
fn reads_version_with_path_and_home_only() {
    let t = tmpdir();
    fake(&t, "opencode", "1.18.32");
    let path = format!("{}:/usr/bin:/bin", t.0.join("bin").display());
    let got = read_harness_version(AgentHarness::Opencode, Some(&path), &t.0, None, None);
    assert_eq!(got.as_deref(), Some("1.18.32"));
    let (_, env) = version_query(AgentHarness::Opencode, Some(&path), &t.0, None, None).unwrap();
    let mut keys: Vec<_> = env.keys().cloned().collect();
    keys.sort();
    assert_eq!(keys, vec!["HOME".to_string(), "PATH".to_string()]);
}

#[test]
fn omp_asks_with_runner_omp_home() {
    let t = tmpdir();
    fake(&t, "omp", "omp/18.12.6");
    let path = format!("{}:/usr/bin:/bin", t.0.join("bin").display());
    let oh = t.0.join("state/omp-home");
    let (_, env) = version_query(AgentHarness::Omp, Some(&path), &t.0, Some(&oh), None).unwrap();
    assert_eq!(
        env["HOME"],
        crate::omp_home::omp_dirs(&oh).home.to_string_lossy()
    );
    assert_eq!(
        read_harness_version(AgentHarness::Omp, Some(&path), &t.0, Some(&oh), None).as_deref(),
        Some("omp/18.12.6")
    );
    // omp 홈을 모르면 묻지 않는다(사람 HOME 으로 묻지 않게).
    assert!(version_query(AgentHarness::Omp, Some(&path), &t.0, None, None).is_none());
}

#[test]
fn missing_binary_or_empty_output_is_none() {
    let t = tmpdir();
    let path = format!("{}:/usr/bin:/bin", t.0.join("bin").display());
    assert_eq!(
        read_harness_version(AgentHarness::Kilo, Some(&path), &t.0, None, None),
        None
    );
    fake(&t, "kilo", "");
    assert_eq!(
        read_harness_version(AgentHarness::Kilo, Some(&path), &t.0, None, None),
        None
    );
}

/// codex 는 `--version` 에도 `$CODEX_HOME/tmp/arg0` 를 쓴다 — 러너 codex 홈을 `CODEX_HOME` 으로 주고, 모르면 묻지 않는다
/// (사람 `~/.codex` 를 건드리지 않게).
#[test]
fn codex_asks_with_runner_codex_home_or_not_at_all() {
    let t = tmpdir();
    fake(&t, "codex", "codex-cli 0.154.0");
    let path = format!("{}:/usr/bin:/bin", t.0.join("bin").display());
    let ch = t.0.join("state/codex-provider-lane");
    let (_, env) = version_query(AgentHarness::Codex, Some(&path), &t.0, None, Some(&ch)).unwrap();
    let mut keys: Vec<_> = env.keys().cloned().collect();
    keys.sort();
    assert_eq!(keys, vec!["CODEX_HOME", "HOME", "PATH"]);
    assert_eq!(env["CODEX_HOME"], ch.to_string_lossy());
    assert_eq!(
        read_harness_version(AgentHarness::Codex, Some(&path), &t.0, None, Some(&ch)).as_deref(),
        Some("codex-cli 0.154.0")
    );
    // 홈 모르면 묻지 않는다.
    assert!(version_query(AgentHarness::Codex, Some(&path), &t.0, None, None).is_none());
    assert!(read_harness_version(AgentHarness::Codex, Some(&path), &t.0, None, None).is_none());
    // codex 가 아닌 하네스엔 CODEX_HOME 을 싣지 않는다.
    fake(&t, "opencode", "1.18.32");
    let (_, env) =
        version_query(AgentHarness::Opencode, Some(&path), &t.0, None, Some(&ch)).unwrap();
    assert!(!env.contains_key("CODEX_HOME"));
}
