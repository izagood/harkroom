//! TS `test/runnerLog.test.ts`·shared `test/runnerExitReason.test.ts` 의 판정 대조.
use super::*;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;

fn tmp() -> PathBuf {
    let d = std::env::temp_dir().join(format!(
        "hk-runner-log-{}-{}",
        std::process::id(),
        crate::runners::new_incarnation_id().unwrap()
    ));
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[test]
fn file_name_blocks_path_injection_and_caps_length() {
    assert_eq!(
        runner_log_file_name("../../etc/x"),
        "runner-______etc_x.log"
    );
    assert_eq!(runner_log_file_name(""), "runner-unnamed.log");
    assert_eq!(runner_log_file_name("가"), "runner-_.log");
    let long = "a".repeat(100);
    assert_eq!(
        runner_log_file_name(&long),
        format!("runner-{}.log", "a".repeat(64))
    );
    let id = "0b1f2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
    assert_eq!(runner_log_file_name(id), format!("runner-{id}.log"));
}

#[test]
fn opens_append_0600_under_operator_dir() {
    let d = tmp();
    let (mut f, path) = open_runner_log(&d, "a1", RUNNER_LOG_MAX_BYTES, &|_| {}).unwrap();
    assert_eq!(path, d.join("operator/runner-a1.log"));
    writeln!(f, "one").unwrap();
    drop(f);
    let (mut f, _) = open_runner_log(&d, "a1", RUNNER_LOG_MAX_BYTES, &|_| {}).unwrap();
    writeln!(f, "two").unwrap();
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "one\ntwo\n");
    let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600);
}

#[test]
fn rotates_before_open_and_keeps_only_one_generation() {
    let d = tmp();
    let path = runner_log_path(&d, "a1");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, "x".repeat(20)).unwrap();
    std::fs::write(format!("{}.1", path.display()), "old").unwrap();
    let logs = std::sync::Mutex::new(Vec::new());
    let (mut f, _) =
        open_runner_log(&d, "a1", 10, &|l| logs.lock().unwrap().push(l.to_string())).unwrap();
    writeln!(f, "new").unwrap();
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "new\n");
    assert_eq!(
        std::fs::read_to_string(format!("{}.1", path.display())).unwrap(),
        "x".repeat(20)
    );
    assert!(logs.lock().unwrap()[0].contains("밀었다"));
    // 상한 이하면 밀지 않는다.
    drop(f);
    let (_f, _) = open_runner_log(&d, "a1", 10, &|_| {}).unwrap();
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "new\n");
}

#[test]
fn open_failure_is_none_with_reason() {
    let d = tmp();
    std::fs::write(d.join("operator"), "not a dir").unwrap();
    let logs = std::sync::Mutex::new(Vec::new());
    assert!(
        open_runner_log(&d, "a1", RUNNER_LOG_MAX_BYTES, &|l| logs
            .lock()
            .unwrap()
            .push(l.to_string()))
        .is_none()
    );
    assert!(logs.lock().unwrap()[0].contains("출력을 버린다"));
}

#[test]
fn tail_keeps_last_lines_drops_blank_and_cr() {
    let d = tmp();
    let p = d.join("t.log");
    let mut s = String::new();
    for i in 0..30 {
        s.push_str(&format!("line {i}\r\n\n  \n"));
    }
    std::fs::write(&p, s).unwrap();
    let t = read_runner_log_tail(&p, RUNNER_EXIT_TAIL_LINES);
    assert_eq!(t.len(), 20);
    assert_eq!(t[0], "line 10");
    assert_eq!(t[19], "line 29");
}

#[test]
fn tail_drops_half_line_when_window_starts_mid_file() {
    let d = tmp();
    let p = d.join("t.log");
    let mut s = "h".repeat(RUNNER_TAIL_READ_BYTES as usize);
    s.push_str("\nlast\n");
    std::fs::write(&p, s).unwrap();
    assert_eq!(read_runner_log_tail(&p, 20), vec!["last".to_string()]);
}

#[test]
fn tail_of_missing_or_empty_is_empty() {
    let d = tmp();
    assert!(read_runner_log_tail(&d.join("none.log"), 20).is_empty());
    std::fs::write(d.join("e.log"), "").unwrap();
    assert!(read_runner_log_tail(&d.join("e.log"), 20).is_empty());
}

#[test]
fn exit_reason_only_when_exactly_one_marker() {
    let l = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    assert_eq!(runner_exit_reason(&[]), None);
    assert_eq!(
        runner_exit_reason(&l(&["x", CREDENTIAL_REJECTED_LINE])),
        Some("credential-rejected")
    );
    assert_eq!(
        runner_exit_reason(&l(&[EXECUTABLE_NOT_FOUND_LINE])),
        Some("executable-not-found")
    );
    assert_eq!(
        runner_exit_reason(&l(&[HARNESS_LOGIN_REQUIRED_LINE])),
        Some("harness-login-required")
    );
    assert_eq!(
        runner_exit_reason(&l(&[CREDENTIAL_REJECTED_LINE, EXECUTABLE_NOT_FOUND_LINE])),
        None
    );
    assert_eq!(
        runner_exit_reason(&l(&["prefix ".to_string() + CREDENTIAL_REJECTED_LINE]
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>())),
        Some("credential-rejected")
    );
}

#[test]
fn marker_lines_match_shared_ts() {
    let src = include_str!("../../../../packages/shared/src/index.ts");
    for m in [
        CREDENTIAL_REJECTED_LINE,
        EXECUTABLE_NOT_FOUND_LINE,
        HARNESS_LOGIN_REQUIRED_LINE,
    ] {
        assert!(src.contains(&format!("'{m}'")), "shared 와 갈렸다: {m}");
    }
}

#[test]
fn new_operator_dir_is_0700_and_symlinked_dir_is_refused() {
    let d = tmp();
    open_runner_log(&d, "a1", RUNNER_LOG_MAX_BYTES, &|_| {}).unwrap();
    let mode = std::fs::metadata(d.join("operator"))
        .unwrap()
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(mode, 0o700);

    let d2 = tmp();
    let elsewhere = tmp();
    std::os::unix::fs::symlink(&elsewhere, d2.join("operator")).unwrap();
    assert!(open_runner_log(&d2, "a1", RUNNER_LOG_MAX_BYTES, &|_| {}).is_none());
    assert!(!elsewhere.join("runner-a1.log").exists());
}

#[test]
fn symlinked_log_is_not_followed_for_open_rotate_or_tail() {
    let d = tmp();
    std::fs::create_dir_all(d.join("operator")).unwrap();
    let target = d.join("victim.txt");
    std::fs::write(&target, "keep\n".repeat(10)).unwrap();
    let path = runner_log_path(&d, "a1");
    std::os::unix::fs::symlink(&target, &path).unwrap();
    let reasons = std::cell::RefCell::new(Vec::new());
    // 상한 1바이트 — 링크를 따라갔다면 대상을 밀었을 것이다.
    assert!(open_runner_log(&d, "a1", 1, &|m| reasons.borrow_mut().push(m.to_string())).is_none());
    assert_eq!(
        std::fs::read_to_string(&target).unwrap(),
        "keep\n".repeat(10)
    );
    assert!(reasons.borrow().iter().any(|m| m.contains("열지 못했다")));
    assert!(read_runner_log_tail(&path, 5).is_empty());
}

#[test]
fn fifo_or_dir_at_log_path_is_refused_without_blocking() {
    let d = tmp();
    std::fs::create_dir_all(runner_log_path(&d, "a1")).unwrap();
    assert!(open_runner_log(&d, "a1", RUNNER_LOG_MAX_BYTES, &|_| {}).is_none());
    let fifo = runner_log_path(&d, "a2");
    let c = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
    // SAFETY: 경로 문자열만 넘긴다.
    assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
    assert!(open_runner_log(&d, "a2", RUNNER_LOG_MAX_BYTES, &|_| {}).is_none());
    assert!(read_runner_log_tail(&fifo, 5).is_empty());
}
