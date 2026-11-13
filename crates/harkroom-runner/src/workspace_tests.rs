//! [`workspace_name`]·[`resolve_workspace_dir`] — 스레드마다 다른 폴더, 같은 스레드는 같은 폴더, 옛 이름 재사용, avcs 갈래.
use std::cell::RefCell;

use super::*;

fn root(tag: &str) -> PathBuf {
    let r = std::env::temp_dir().join(format!("hk-ws-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&r);
    std::fs::create_dir_all(&r).unwrap();
    r
}

fn never(_c: &str, _a: &[&str], _d: &Path) -> std::io::Result<(i32, String)> {
    panic!("workingDir 없으면 avcs 를 부르지 않는다")
}

#[test]
fn name_is_agent_id_plus_thread_hash_and_reuses_old_names() {
    let n1 = workspace_name("a1", "c/t1", &[]);
    let n2 = workspace_name("a1", "c/t2", &[]);
    assert!(n1.starts_with("harkroom-a1-") && n1.len() == "harkroom-a1-".len() + 8);
    assert_ne!(n1, n2, "스레드마다 다르다");
    assert_eq!(n1, workspace_name("a1", "c/t1", &[]), "같은 스레드는 같다");
    assert_ne!(n1, workspace_name("a2", "c/t1", &[]), "에이전트마다 다르다");
    let hash = &n1["harkroom-a1-".len()..];
    let old = format!("harkroom-oldhandle-{hash}");
    assert_eq!(
        workspace_name("a1", "c/t1", std::slice::from_ref(&old)),
        old,
        "옛 이름을 쓴다(#846)"
    );
}

#[test]
fn two_threads_get_two_dirs_without_working_dir() {
    let r = root("plain");
    let d1 = resolve_workspace_dir(&r, "a1", "c/t1", None, &never).unwrap();
    let d2 = resolve_workspace_dir(&r, "a1", "c/t2", None, &never).unwrap();
    assert_ne!(d1, d2);
    assert!(d1.is_dir() && d2.is_dir());
    assert_eq!(
        resolve_workspace_dir(&r, "a1", "c/t1", None, &never).unwrap(),
        d1
    );
    let _ = std::fs::remove_dir_all(&r);
}

#[test]
fn working_dir_projects_once_falls_back_only_for_non_avcs_and_rejects_files() {
    let r = root("avcs");
    let calls = RefCell::new(Vec::<String>::new());
    let ok = |c: &str, a: &[&str], d: &Path| {
        calls
            .borrow_mut()
            .push(format!("{c} {} @{}", a.join(" "), d.display()));
        std::fs::create_dir_all(a[4]).unwrap();
        Ok((0, String::new()))
    };
    let d = resolve_workspace_dir(&r, "a1", "c/t1", Some("/repo"), &ok).unwrap();
    assert_eq!(calls.borrow().len(), 1);
    assert!(calls.borrow()[0].starts_with("avcs workspace project harkroom-a1-"));
    assert!(calls.borrow()[0].ends_with("@/repo"));
    // 이미 있으면 다시 부르지 않는다.
    assert_eq!(
        resolve_workspace_dir(&r, "a1", "c/t1", Some("/repo"), &ok).unwrap(),
        d
    );
    assert_eq!(calls.borrow().len(), 1);

    let not_avcs =
        |_c: &str, _a: &[&str], _d: &Path| Ok((1, "error: not an AVCS repo".to_string()));
    assert_eq!(
        resolve_workspace_dir(&r, "a1", "c/t2", Some("/repo"), &not_avcs).unwrap(),
        PathBuf::from("/repo")
    );
    let other = |_c: &str, _a: &[&str], _d: &Path| Ok((2, "boom".to_string()));
    assert!(resolve_workspace_dir(&r, "a1", "c/t3", Some("/repo"), &other).is_err());

    let name = resolve_workspace_name(&r, "a1", "c/t4");
    std::fs::write(r.join(&name), "x").unwrap();
    assert!(
        resolve_workspace_dir(&r, "a1", "c/t4", Some("/repo"), &ok).is_err(),
        "파일이면 오류"
    );
    let _ = std::fs::remove_dir_all(&r);
}
