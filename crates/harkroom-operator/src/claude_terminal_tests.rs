//! TS `packages/operator/test/claudeAccountTerminal.test.ts` 의 openTerminal·terminalScript 칸 이식.
use super::*;
use crate::claude_accounts::ClaudeAccounts;
use std::cell::RefCell;

fn tmpdir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!(
        "hk-term-{tag}-{}",
        crate::endpoint::random_hex(6).unwrap()
    ));
    fs::create_dir_all(d.join("work").join("aria")).unwrap();
    fs::create_dir_all(d.join("work").join("cedar")).unwrap();
    fs::write(d.join("pools.json"), r#"{"defaultPool":"work"}"#).unwrap();
    d
}

fn cwd_of(script: &str) -> String {
    let line = script.lines().find(|l| l.starts_with("cd '")).unwrap();
    line["cd '".len()..line.rfind("' || exit 1").unwrap()].to_string()
}

#[test]
fn writes_and_opens_the_account_script_with_a_fresh_trusted_workdir() {
    let root = tmpdir("open");
    let opened = RefCell::new(Vec::<PathBuf>::new());
    let open = |p: &Path| -> Result<(), String> {
        opened.borrow_mut().push(p.to_path_buf());
        Ok(())
    };
    open_terminal(&root, "work", "aria", &open).unwrap();
    let first = opened.borrow()[0].clone();
    let script = fs::read_to_string(&first).unwrap();
    let acct = root.join("work").join("aria");
    assert!(script.contains(&format!("export CLAUDE_CONFIG_DIR='{}'", acct.display())));
    assert!(script.contains(&format!("rm -f '{}'", acct.join(ATTENTION_FILE).display())));
    assert_eq!(
        fs::metadata(&first).unwrap().permissions().mode() & 0o777,
        0o700
    );

    // 작업 폴더는 열 때마다 새로 만든 빈 폴더이고, 그 폴더만 신뢰한다(security ★).
    let cwd = cwd_of(&script);
    assert!(cwd.starts_with(&format!(
        "{}",
        root.join(".terminal").join("session-").display()
    )));
    assert_eq!(fs::read_dir(&cwd).unwrap().count(), 0);
    assert_eq!(
        fs::metadata(&cwd).unwrap().permissions().mode() & 0o777,
        0o700
    );
    let doc: Value =
        serde_json::from_str(&fs::read_to_string(acct.join(GLOBAL_CONFIG_FILE)).unwrap()).unwrap();
    assert_eq!(
        doc["projects"][&cwd],
        serde_json::json!({ "hasTrustDialogAccepted": true })
    );
    assert!(
        doc["projects"]
            .get(root.join(".terminal").to_string_lossy().as_ref())
            .is_none()
    );
    // 첫 실행 관문도 미리 지난다.
    assert_eq!(doc["hasCompletedOnboarding"], Value::Bool(true));
    // 스크립트는 작업 폴더 밖에 있다 — 신뢰한 폴더 안에 실행 파일을 두지 않는다.
    assert!(!first.starts_with(&cwd));

    // 두 번 열면 다른 폴더다 — 앞 세션이 남긴 것을 다음 세션이 읽지 않는다.
    open_terminal(&root, "work", "aria", &open).unwrap();
    let second = opened.borrow()[1].clone();
    let cwd2 = cwd_of(&fs::read_to_string(&second).unwrap());
    assert_ne!(cwd2, cwd);

    // 뿌리의 `.terminal` 은 풀도 계정도 아니다.
    let accounts = ClaudeAccounts::with(
        root.clone(),
        root.join("pools.json"),
        Box::new(|_: &Path| false),
        Box::new(|_: &Path| {}),
        || 0.0,
    );
    let list = accounts.list();
    let names: Vec<&str> = list["pools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, vec!["work"]);
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn refuses_missing_accounts_and_names_outside_the_grammar_without_opening() {
    let root = tmpdir("refuse");
    let opened = RefCell::new(0usize);
    let open = |_: &Path| -> Result<(), String> {
        *opened.borrow_mut() += 1;
        Ok(())
    };
    let e = open_terminal(&root, "work", "ghost", &open).unwrap_err();
    assert!(e.contains("없다"), "{e}");
    assert!(open_terminal(&root, "work", "..", &open).is_err());
    assert!(open_terminal(&root, "../x", "aria", &open).is_err());
    assert_eq!(*opened.borrow(), 0);
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn script_quotes_single_quotes_in_paths() {
    let s = terminal_script(Path::new("/tmp/it's"), Path::new("/w"), "work/aria");
    assert!(s.contains(r"export CLAUDE_CONFIG_DIR='/tmp/it'\''s'"));
    assert_eq!(s.lines().next().unwrap(), "#!/bin/zsh -l");
}

#[test]
fn trust_mark_does_not_overwrite_a_broken_or_non_object_config() {
    let root = tmpdir("broken");
    let acct = root.join("work").join("aria");
    fs::write(acct.join(GLOBAL_CONFIG_FILE), "[1]").unwrap();
    assert!(mark_workspace_trusted(&acct, Path::new("/w")).is_err());
    assert_eq!(
        fs::read_to_string(acct.join(GLOBAL_CONFIG_FILE)).unwrap(),
        "[1]"
    );
    fs::write(acct.join(GLOBAL_CONFIG_FILE), "{not json").unwrap();
    assert!(mark_workspace_trusted(&acct, Path::new("/w")).is_err());
    // 이미 신뢰돼 있으면 쓰지 않는다. 다른 키는 그대로 둔다.
    fs::write(
        acct.join(GLOBAL_CONFIG_FILE),
        r#"{"keep":1,"projects":{"/w":{"hasTrustDialogAccepted":true,"x":2}}}"#,
    )
    .unwrap();
    assert_eq!(mark_workspace_trusted(&acct, Path::new("/w")), Ok(false));
    assert_eq!(mark_workspace_trusted(&acct, Path::new("/v")), Ok(true));
    let doc: Value =
        serde_json::from_str(&fs::read_to_string(acct.join(GLOBAL_CONFIG_FILE)).unwrap()).unwrap();
    assert_eq!(doc["keep"], 1);
    assert_eq!(doc["projects"]["/w"]["x"], 2);
    assert_eq!(doc["projects"]["/v"]["hasTrustDialogAccepted"], true);
    fs::remove_dir_all(&root).unwrap();
}
