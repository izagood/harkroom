use super::*;
use crate::codex_rules::codex_rules_path;
use std::cell::RefCell;

struct FakeDeps {
    version: Option<String>,
    logs: RefCell<Vec<String>>,
}

impl CodexRulesDeps for FakeDeps {
    fn version(&self) -> Option<String> {
        self.version.clone()
    }
    fn list_hooks(&self, _h: &Path, _c: &Path) -> Result<Vec<CodexHookListEntry>, ListHooksError> {
        Err(ListHooksError::Failed)
    }
    fn log(&self, line: &str) {
        self.logs.borrow_mut().push(line.to_string());
    }
}

fn tmp(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("hk-cprep-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// 잰 판 밖의 codex 면 남은 규칙 파일을 지운다(security F1) — 지우지 않으면 승인 규칙이 hook 없이 실린다.
#[test]
fn stale_rules_are_swept_before_codex_turn() {
    let root = tmp("sweep");
    let home = root.join("codex-home");
    let rules = codex_rules_path(&home);
    std::fs::create_dir_all(rules.parent().unwrap()).unwrap();
    std::fs::write(&rules, "prefix_rule(...)").unwrap();
    let prep = CodexPrep {
        home: home.clone(),
        sync_auth: false,
        env: Env::new(),
    };
    let deps = FakeDeps {
        version: Some("codex-cli 9.9.9".into()),
        logs: RefCell::default(),
    };
    prep.run(&deps).unwrap();
    assert!(!rules.exists(), "남은 규칙 파일을 지운다");
    let _ = std::fs::remove_dir_all(&root);
}

/// 로그인 링크 갱신 실패는 턴을 죽이지 않는다(정본과 같음) — 로그만 남긴다.
#[test]
fn auth_sync_failure_only_logs() {
    let root = tmp("sync");
    let home = root.join("codex-home");
    std::fs::create_dir_all(&home).unwrap();
    // 모르는 자리를 가리키는 링크 = `UnexpectedAuthLink`.
    std::os::unix::fs::symlink(root.join("elsewhere/auth.json"), home.join("auth.json")).unwrap();
    let src = root.join("src-codex");
    std::fs::create_dir_all(&src).unwrap();
    std::fs::write(src.join("auth.json"), "{}").unwrap();
    let env: Env = [("CODEX_HOME".to_string(), src.to_string_lossy().into_owned())].into();
    let prep = CodexPrep {
        home: home.clone(),
        sync_auth: true,
        env,
    };
    let deps = FakeDeps {
        version: None,
        logs: RefCell::default(),
    };
    prep.run(&deps).unwrap();
    assert!(
        deps.logs
            .borrow()
            .iter()
            .any(|l| l.contains("codex 계정 링크 갱신 실패"))
    );
    let _ = std::fs::remove_dir_all(&root);
}
