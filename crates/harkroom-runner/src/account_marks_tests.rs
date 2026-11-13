use std::os::unix::fs::{PermissionsExt, symlink};

use serde_json::Value;

use super::*;
use crate::account_assign::shared::{AttentionKind, read_account_blocked};

struct Tmp(PathBuf);
impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn tmp(tag: &str) -> Tmp {
    let d = std::env::temp_dir().join(format!("hk-marks-{tag}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    Tmp(d)
}

/// 본문은 `{"kind","atMs"}` 둘뿐(계정 이름·경로 없음) · 0600 · 읽기 쪽(배정기)이 그대로 읽는다 · 임시 파일이 남지 않는다.
#[test]
fn mark_writes_kind_and_time_only_private() {
    let t = tmp("write");
    mark_attention(&t.0, 1_000);
    let p = t.0.join(CLAUDE_ATTENTION_FILE);
    let v: Value = serde_json::from_str(&fs::read_to_string(&p).unwrap()).unwrap();
    let mut keys: Vec<&String> = v.as_object().unwrap().keys().collect();
    keys.sort();
    assert_eq!(keys, ["atMs", "kind"]);
    assert_eq!(v["kind"], "gate");
    assert_eq!(
        fs::metadata(&p).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let a = read_account_blocked(&t.0).unwrap();
    assert_eq!((a.kind, a.at_ms), (AttentionKind::Gate, 1_000.0));
    let names: Vec<String> = fs::read_dir(&t.0)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names, [CLAUDE_ATTENTION_FILE]);

    mark_credential_failed(&t.0, 2_000);
    assert!(clear_attention(&t.0));
    let a = read_account_blocked(&t.0).unwrap();
    assert_eq!((a.kind, a.at_ms), (AttentionKind::Credential, 2_000.0));
    assert!(clear_credential_failure(&t.0));
    assert!(read_account_blocked(&t.0).is_none());
    assert!(!clear_attention(&t.0), "없으면 false");
}

/// 표식 자리에 링크가 있으면: 쓰기는 링크째 바꾸고 대상을 덮지 않는다 · 읽기는 따라가지 않는다 · 지우기는 링크만.
#[test]
fn symlinks_are_not_followed() {
    let t = tmp("link");
    let outside = t.0.join("outside.json");
    fs::write(&outside, r#"{"kind":"gate","atMs":5}"#).unwrap();
    let acct = t.0.join("acct");
    fs::create_dir_all(&acct).unwrap();
    let marker = acct.join(CLAUDE_ATTENTION_FILE);

    symlink(&outside, &marker).unwrap();
    assert!(
        read_account_blocked(&acct).is_none(),
        "링크 표식은 읽지 않는다"
    );
    assert!(clear_attention(&acct), "링크를 지운다");
    assert!(fs::symlink_metadata(&marker).is_err());
    assert!(outside.exists(), "대상은 그대로");

    symlink(&outside, &marker).unwrap();
    mark_attention(&acct, 9);
    assert!(
        !fs::symlink_metadata(&marker)
            .unwrap()
            .file_type()
            .is_symlink(),
        "링크째 바뀐다"
    );
    assert_eq!(
        fs::read_to_string(&outside).unwrap(),
        r#"{"kind":"gate","atMs":5}"#,
        "대상을 덮지 않는다"
    );
}

/// 표식 자리가 디렉터리면 지우지 않는다 · 쓰기 실패는 삼킨다(턴을 죽이지 않는다).
#[test]
fn directory_in_place_is_left_alone() {
    let t = tmp("dir");
    fs::create_dir_all(t.0.join(CLAUDE_AUTH_FILE)).unwrap();
    assert!(!clear_credential_failure(&t.0));
    mark_credential_failed(&t.0, 1);
    assert!(t.0.join(CLAUDE_AUTH_FILE).is_dir());
}

/// security nit: 표식 자리의 FIFO 에서 막히지 않고(없는 것으로 본다), 4KB 를 넘는 표식은 깨진 것으로 본다.
#[test]
fn fifo_and_oversized_markers_are_ignored() {
    let t = tmp("fifo");
    let p = t.0.join(CLAUDE_ATTENTION_FILE);
    let c = std::ffi::CString::new(p.to_str().unwrap()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
    let (tx, rx) = std::sync::mpsc::channel();
    let dir = t.0.clone();
    std::thread::spawn(move || {
        let _ = tx.send(read_account_blocked(&dir));
    });
    let got = rx
        .recv_timeout(std::time::Duration::from_secs(2))
        .expect("FIFO 에서 막히지 않는다");
    assert!(got.is_none());
    fs::remove_file(&p).unwrap();

    let pad = " ".repeat(5000);
    fs::write(&p, format!(r#"{{"kind":"gate","atMs":1{pad}}}"#)).unwrap();
    assert!(read_account_blocked(&t.0).is_none(), "4KB 넘으면 버린다");
    fs::write(&p, r#"{"kind":"gate","atMs":1}"#).unwrap();
    assert!(read_account_blocked(&t.0).is_some());
}
