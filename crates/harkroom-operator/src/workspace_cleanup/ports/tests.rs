//! 진짜 git 으로 지우기 직전 검사(security c5 조건 1~3)를 본다.
use super::*;
use crate::local_merge::{Exec, ExecResult};
use crate::workspace_cleanup::{CleanupPr, PrState, ThreadRef};
use std::path::PathBuf;
use std::process::Command;

struct Tmp(PathBuf);
impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn tmpdir() -> Tmp {
    static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let n = N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let d = std::env::temp_dir().join(format!("hk-c5p-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    // macOS 의 /var → /private/var: 실제 경로로 잡아야 조건 3 이 통과한다.
    Tmp(std::fs::canonicalize(&d).unwrap())
}

fn real_exec() -> Exec {
    Arc::new(|file: &str, a: &[String], env: &[(String, String)]| {
        let o = Command::new(file)
            .args(a)
            .env_clear()
            .envs(env.iter().cloned())
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@example.invalid")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@example.invalid")
            .output()
            .unwrap();
        ExecResult {
            code: o.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&o.stdout).into(),
            stderr: String::from_utf8_lossy(&o.stderr).into(),
        }
    })
}

fn ports(home: &str, protected: Vec<String>, deny_inside: Vec<String>) -> GitPorts {
    GitPorts {
        deps: Arc::new(ScanDeps {
            exec: real_exec(),
            git_path: "/usr/bin/git".into(),
            gh_path: "/nonexistent".into(),
            gh_env: vec![],
            home: home.into(),
            protected,
        }),
        deny_inside,
    }
}

fn git(p: &GitPorts, a: &[&str]) -> String {
    let r = p.git(a);
    assert_eq!(r.code, 0, "git {a:?}: {}", r.stderr);
    r.stdout.trim().to_string()
}

/// 저장소 + 브랜치 `wt` 의 linked worktree 하나. (repo, wt, head)
fn setup(p: &GitPorts, root: &Path) -> (String, String, String) {
    let repo = root.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    let repo = repo.to_str().unwrap().to_string();
    git(p, &["-C", &repo, "init", "-q", "-b", "main"]);
    std::fs::write(Path::new(&repo).join("a"), "a").unwrap();
    git(p, &["-C", &repo, "add", "a"]);
    git(p, &["-C", &repo, "commit", "-qm", "a"]);
    let wt = root.join("wt").to_str().unwrap().to_string();
    git(p, &["-C", &repo, "worktree", "add", "-q", "-b", "wt", &wt]);
    let head = git(p, &["-C", &wt, "rev-parse", "HEAD"]);
    (repo, wt, head)
}

fn item(path: &str, repo: &str, head: &str) -> CleanupItem {
    CleanupItem {
        repo: Some(repo.into()),
        branch: Some("wt".into()),
        head_sha: Some(head.into()),
        pr: Some(CleanupPr {
            number: 1,
            state: PrState::Merged,
            head_sha: Some(head.into()),
        }),
        ..CleanupItem::blank(path, CleanupKind::Worktree)
    }
}

#[test]
fn check_and_remove_registered_pushed_worktree() {
    let t = tmpdir();
    let p = ports(t.0.to_str().unwrap(), vec![], vec![]);
    let (repo, wt, head) = setup(&p, &t.0);
    let it = item(&wt, &repo, &head);
    assert_eq!(p.check(&it, &HashSet::new()), None);
    p.remove(&it).unwrap();
    assert!(!Path::new(&wt).exists());
    // 브랜치도 검사한 커밋 그대로라 지워졌다.
    assert_ne!(
        p.git(&["-C", &repo, "rev-parse", "--verify", "-q", "refs/heads/wt"])
            .code,
        0
    );
    // main 은 그대로.
    assert!(Path::new(&repo).join("a").exists());
}

#[test]
fn check_blocks_dirty_unpushed_running() {
    let t = tmpdir();
    let p = ports(t.0.to_str().unwrap(), vec![], vec![]);
    let (repo, wt, head) = setup(&p, &t.0);
    let mut it = item(&wt, &repo, &head);
    it.thread = Some(ThreadRef {
        channel_id: "c".into(),
        thread_root_id: "r".into(),
    });
    let running: HashSet<String> = [it.thread.as_ref().unwrap().key()].into();
    assert_eq!(p.check(&it, &running), Some(BlockReason::TurnRunning));
    std::fs::write(Path::new(&wt).join("new"), "x").unwrap();
    assert_eq!(
        p.check(&it, &HashSet::new()),
        Some(BlockReason::Uncommitted)
    );
    std::fs::remove_file(Path::new(&wt).join("new")).unwrap();
    // PR head 를 모르고 원격도 없으면 안 올라간 것.
    it.pr = None;
    assert_eq!(p.check(&it, &HashSet::new()), Some(BlockReason::Unpushed));
    // 원장 head 가 지금 HEAD 와 다르면 막는다.
    let mut it2 = item(&wt, &repo, &"0".repeat(40));
    it2.pr = None;
    assert_eq!(p.check(&it2, &HashSet::new()), Some(BlockReason::Unpushed));
}

#[test]
fn remove_refuses_unregistered_symlink_main_and_protected() {
    let t = tmpdir();
    let root = t.0.to_str().unwrap().to_string();
    let p = ports(&root, vec![], vec![]);
    let (repo, wt, head) = setup(&p, &t.0);

    // git 목록에 없는 폴더(조건 1).
    let plain = format!("{root}/plain");
    std::fs::create_dir_all(&plain).unwrap();
    assert!(p.remove(&item(&plain, &repo, &head)).is_err());
    assert!(Path::new(&plain).exists());

    // main worktree(조건 1).
    assert!(p.remove(&item(&repo, &repo, &head)).is_err());
    assert!(Path::new(&repo).join("a").exists());

    // 심링크로 가리킨 worktree(조건 3).
    let link = format!("{root}/link");
    std::os::unix::fs::symlink(&wt, &link).unwrap();
    assert!(p.remove(&item(&link, &repo, &head)).is_err());
    assert!(Path::new(&wt).exists());

    // 지키는 자리의 조상(조건 2).
    let guarded = ports(&root, vec![format!("{wt}/inner")], vec![]);
    assert!(guarded.remove(&item(&wt, &repo, &head)).is_err());
    // 계정 뿌리·앱 데이터 폴더의 안쪽(조건 2 넓힘).
    let inside = ports(&root, vec![], vec![root.clone()]);
    assert!(inside.remove(&item(&wt, &repo, &head)).is_err());
    assert!(Path::new(&wt).exists());

    // 모양이 나쁜 경로.
    assert!(
        p.remove(&item(&format!("{wt}/../wt"), &repo, &head))
            .is_err()
    );

    // 스레드 폴더는 오퍼레이터가 지우지 않는다.
    let td = CleanupItem::blank(&plain, CleanupKind::ThreadDir);
    assert!(p.remove(&td).is_err());
    assert!(Path::new(&plain).exists());
}

#[test]
fn remove_refuses_dirty_worktree_without_force() {
    let t = tmpdir();
    let p = ports(t.0.to_str().unwrap(), vec![], vec![]);
    let (repo, wt, head) = setup(&p, &t.0);
    std::fs::write(Path::new(&wt).join("a"), "changed").unwrap();
    assert!(p.remove(&item(&wt, &repo, &head)).is_err());
    assert!(Path::new(&wt).join("a").exists());
}

/// 부르면 `marker` 를 만드는 실행 파일 — 저장소 설정에 넣어 그것이 도는지 본다.
fn trap(root: &Path, name: &str) -> (String, PathBuf) {
    let marker = root.join(format!("{name}.ran"));
    let script = root.join(format!("{name}.sh"));
    std::fs::write(
        &script,
        format!("#!/bin/sh\ntouch '{}'\ncat\n", marker.display()),
    )
    .unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    (script.to_str().unwrap().to_string(), marker)
}

#[test]
fn check_does_not_run_commands_from_repo_or_global_config() {
    let t = tmpdir();
    let p = ports(t.0.to_str().unwrap(), vec![], vec![]);
    let (repo, wt, head) = setup(&p, &t.0);
    let (cmd, marker) = trap(&t.0, "fsmonitor");
    // 저장소 설정(에이전트가 쓸 수 있다)과 전역 설정(HOME) 양쪽에 명령을 넣는다.
    git(&p, &["-C", &repo, "config", "core.fsmonitor", &cmd]);
    std::fs::write(
        t.0.join(".gitconfig"),
        format!("[core]\n\tfsmonitor = {cmd}\n"),
    )
    .unwrap();
    // hooks 도 덮인다 — 저장소 hooks 폴더에 무엇이 있어도 돌지 않는다.
    let hooks = Path::new(&repo).join(".git/hooks");
    std::fs::create_dir_all(&hooks).unwrap();
    for h in [
        "reference-transaction",
        "post-checkout",
        "post-index-change",
    ] {
        std::fs::copy(&cmd, hooks.join(h)).unwrap();
    }
    let it = item(&wt, &repo, &head);
    assert_eq!(p.check(&it, &HashSet::new()), None);
    p.remove(&it).unwrap();
    assert!(!marker.exists(), "저장소/전역 설정의 명령이 돌았다");
}

#[test]
fn filter_config_blocks_check_and_keeps_deps() {
    let t = tmpdir();
    let p = ports(t.0.to_str().unwrap(), vec![], vec![]);
    let (repo, wt, head) = setup(&p, &t.0);
    let (cmd, marker) = trap(&t.0, "filter");
    git(&p, &["-C", &repo, "config", "filter.x.clean", &cmd]);
    git(&p, &["-C", &repo, "config", "filter.x.smudge", &cmd]);
    std::fs::write(Path::new(&wt).join(".gitattributes"), "* filter=x\n").unwrap();
    std::fs::write(Path::new(&wt).join(".gitignore"), "node_modules/\n").unwrap();
    std::fs::create_dir_all(Path::new(&wt).join("node_modules/m")).unwrap();
    let it = item(&wt, &repo, &head);
    assert_eq!(
        p.check(&it, &HashSet::new()),
        Some(BlockReason::Uncommitted)
    );
    assert!(p.remove_deps(&wt).is_err());
    assert!(Path::new(&wt).join("node_modules/m").exists());
    assert!(!marker.exists(), "filter 명령이 돌았다");
}

#[test]
fn remove_deps_goes_through_removal_guard() {
    let t = tmpdir();
    let p = ports(t.0.to_str().unwrap(), vec![], vec![]);
    let (_repo, wt, _head) = setup(&p, &t.0);
    // 등록 안 된 폴더(혼자 선 저장소) — 무시되는 node_modules 라도 남는다.
    let loose = t.0.join("loose");
    std::fs::create_dir_all(loose.join("node_modules/m")).unwrap();
    let loose_s = loose.to_str().unwrap();
    git(&p, &["-C", loose_s, "init", "-q"]);
    std::fs::write(loose.join(".gitignore"), "node_modules/\n").unwrap();
    assert!(p.remove_deps(loose_s).is_err());
    assert!(loose.join("node_modules/m").exists());
    // 지키는 자리 안쪽의 등록 worktree 도 남는다.
    std::fs::write(Path::new(&wt).join(".gitignore"), "node_modules/\n").unwrap();
    std::fs::create_dir_all(Path::new(&wt).join("node_modules/m")).unwrap();
    let guarded = ports(
        t.0.to_str().unwrap(),
        vec![],
        vec![t.0.to_str().unwrap().into()],
    );
    assert!(guarded.remove_deps(&wt).is_err());
    assert!(Path::new(&wt).join("node_modules/m").exists());
    // 등록된 worktree 의 무시되는 node_modules 는 지운다(대조).
    p.remove_deps(&wt).unwrap();
    assert!(!Path::new(&wt).join("node_modules").exists());
}

#[test]
fn last_activity_does_not_call_signature_program() {
    let t = tmpdir();
    let p = ports(t.0.to_str().unwrap(), vec![], vec![]);
    let (repo, wt, _head) = setup(&p, &t.0);
    let (cmd, marker) = trap(&t.0, "gpg");
    // 서명이 달린 커밋을 손으로 만들고, 저장소 설정에서 서명 표시와 검사 프로그램을 켠다.
    let tree = git(&p, &["-C", &wt, "rev-parse", "HEAD^{tree}"]);
    let parent = git(&p, &["-C", &wt, "rev-parse", "HEAD"]);
    let obj = format!(
        "tree {tree}\nparent {parent}\nauthor t <t@example.invalid> 1700000000 +0000\ncommitter t <t@example.invalid> 1700000000 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n x\n -----END PGP SIGNATURE-----\n\nsigned\n"
    );
    let f = t.0.join("commit.txt");
    std::fs::write(&f, obj).unwrap();
    let c = git(
        &p,
        &[
            "-C",
            &wt,
            "hash-object",
            "-t",
            "commit",
            "-w",
            f.to_str().unwrap(),
        ],
    );
    git(&p, &["-C", &wt, "update-ref", "refs/heads/wt", &c]);
    git(&p, &["-C", &repo, "config", "log.showSignature", "true"]);
    git(&p, &["-C", &repo, "config", "gpg.program", &cmd]);
    assert!(super::super::scan::last_activity_at(&p.deps, &wt).is_some());
    assert!(!marker.exists(), "서명 검사 프로그램이 돌았다");
}

#[test]
fn check_does_not_enter_submodules() {
    let t = tmpdir();
    let p = ports(t.0.to_str().unwrap(), vec![], vec![]);
    let (repo, wt, head) = setup(&p, &t.0);
    let (cmd, marker) = trap(&t.0, "subfilter");
    // 서브모듈 저장소: 그 저장소 설정의 filter 는 바깥 저장소 검사가 보지 못한다.
    let sub = Path::new(&wt).join("sub");
    std::fs::create_dir_all(&sub).unwrap();
    let sub_s = sub.to_str().unwrap();
    git(&p, &["-C", sub_s, "init", "-q", "-b", "main"]);
    std::fs::write(sub.join("f"), "f").unwrap();
    git(&p, &["-C", sub_s, "add", "f"]);
    git(&p, &["-C", sub_s, "commit", "-qm", "f"]);
    git(&p, &["-C", &wt, "add", "sub"]);
    git(&p, &["-C", &wt, "commit", "-qm", "sub"]);
    let head2 = git(&p, &["-C", &wt, "rev-parse", "HEAD"]);
    let _ = head;
    git(&p, &["-C", sub_s, "config", "filter.x.clean", &cmd]);
    // .gitattributes 를 올려 두고, f 는 크기가 같은 다른 내용으로 바꿔 git 이 내용(=filter)을 보게 한다.
    std::fs::write(sub.join(".gitattributes"), "* filter=x\n").unwrap();
    git(&p, &["-C", sub_s, "add", ".gitattributes"]);
    git(&p, &["-C", sub_s, "commit", "-qm", "attr"]);
    std::thread::sleep(std::time::Duration::from_millis(1100));
    std::fs::write(sub.join("f"), "g").unwrap();
    // 준비하며 시험 자신의 `git add` 가 부른 흔적은 지운다.
    let _ = std::fs::remove_file(&marker);
    let _ = p.check(&item(&wt, &repo, &head2), &HashSet::new());
    assert!(!marker.exists(), "서브모듈의 filter 명령이 돌았다");
}
