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

/// hooks.json 이 있으면 신뢰된 hook 하나를 내는 가짜(codex `hooks/list` 대신).
struct Trusting;
impl CodexRulesDeps for Trusting {
    fn version(&self) -> Option<String> {
        Some("codex-cli 0.154.0".into())
    }
    fn list_hooks(&self, h: &Path, _c: &Path) -> Result<Vec<CodexHookListEntry>, ListHooksError> {
        let p = crate::codex_rules::codex_hooks_path(h);
        if !p.exists() {
            return Ok(vec![]);
        }
        Ok(vec![CodexHookListEntry {
            key: "k".into(),
            source_path: p.to_string_lossy().into_owned(),
            event_name: "preToolUse".into(),
            command: None,
            current_hash: "sha256:x".into(),
            trust_status: "trusted".into(),
        }])
    }
    fn writable_roots(&self, ws: &Path) -> Vec<PathBuf> {
        vec![ws.to_path_buf()]
    }
}

fn s(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| x.to_string()).collect()
}

/// c2: 규칙 파일·hook 판정 값은 넘겨받은 **서버 승인 목록**(reach·rules)에서만 나오고, 시도가 끝나면 규칙 파일이 지워진다.
#[test]
fn rules_come_only_from_server_lists_and_end_with_turn() {
    let root = tmp("rules");
    let (home, ws) = (root.join("codex-home"), root.join("ws"));
    std::fs::create_dir_all(&ws).unwrap();
    std::fs::create_dir_all(&home).unwrap();
    let turn = CodexTurn {
        prep: CodexPrep {
            home: home.clone(),
            sync_auth: false,
            env: Env::new(),
        },
        deps: std::sync::Arc::new(Trusting),
    };
    let rules = s(&["Bash(git status)"]);
    let reach = s(&["Bash(git status)", "Bash(ls -la)"]);
    let spec = turn.rules(&ws, &rules, Some(&reach), "/bin/op").unwrap();
    let file = std::fs::read_to_string(codex_rules_path(&home)).unwrap();
    assert_eq!(
        file,
        crate::codex_rules::codex_rules_file(&reach),
        "규칙 파일 = 서버 reach 그대로"
    );
    assert_eq!(
        spec.as_deref(),
        Some(crate::codex_rules::encode_codex_hook_spec(&rules, &reach, &home).as_str()),
        "hook 판정 값 = 그 턴 채널 규칙 + reach"
    );
    turn.end_turn();
    assert!(
        !codex_rules_path(&home).exists(),
        "시도가 끝나면 규칙 파일을 지운다"
    );
    assert!(
        crate::codex_rules::codex_hooks_path(&home).exists(),
        "hook 선언(고정 명령)은 둔다"
    );
    // 옛 서버(reach 없음)면 규칙 파일을 쓰지 않는다.
    assert_eq!(turn.rules(&ws, &rules, None, "/bin/op").unwrap(), None);
    assert!(!codex_rules_path(&home).exists());
    let _ = std::fs::remove_dir_all(&root);
}

/// security #2141 조건: codex lane 홈 자리가 링크·파일이면 거절한다(링크 너머 로그인과 lane 키가 섞이지 않게).
#[test]
fn codex_lane_home_refuses_link_and_file() {
    let root = tmp("lane");
    let state = root.join("state");
    std::fs::create_dir_all(&state).unwrap();
    let elsewhere = root.join("someone-codex");
    std::fs::create_dir_all(&elsewhere).unwrap();
    std::os::unix::fs::symlink(&elsewhere, state.join("codex-provider-lane")).unwrap();
    assert!(codex_lane_home(&state).is_err(), "링크는 거절");
    std::fs::remove_file(state.join("codex-provider-lane")).unwrap();
    std::fs::write(state.join("codex-provider-lane"), "x").unwrap();
    assert!(codex_lane_home(&state).is_err(), "파일은 거절");
    std::fs::remove_file(state.join("codex-provider-lane")).unwrap();
    let h = codex_lane_home(&state).unwrap();
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(
        std::fs::metadata(&h).unwrap().permissions().mode() & 0o777,
        0o700
    );
    let _ = std::fs::remove_dir_all(&root);
}
