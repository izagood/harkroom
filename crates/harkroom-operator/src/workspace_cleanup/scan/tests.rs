use super::*;
use crate::local_merge::ExecResult;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// 시험용 임시 폴더 — 떨어지면 지운다(tempfile 의존 없이).
struct Tmp(PathBuf);
impl Tmp {
    fn path(&self) -> &Path {
        &self.0
    }
}
impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn tmpdir() -> Tmp {
    static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let n = N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let d = std::env::temp_dir().join(format!(
        "hk-c5-{}-{}-{n}",
        module_path!().replace("::", "-"),
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    Tmp(d)
}

fn ok(s: &str) -> ExecResult {
    ExecResult {
        code: 0,
        stdout: s.into(),
        stderr: String::new(),
    }
}
fn fail() -> ExecResult {
    ExecResult {
        code: 1,
        stdout: String::new(),
        stderr: "x".into(),
    }
}

type Calls = Arc<Mutex<Vec<Vec<String>>>>;

fn deps(f: impl Fn(&[String]) -> ExecResult + Send + Sync + 'static) -> (ScanDeps, Calls) {
    let calls: Calls = Arc::default();
    let c = calls.clone();
    let exec: Exec = Arc::new(move |file: &str, a: &[String], env: &[(String, String)]| {
        // git 호출은 모두 실행 칸을 끈 채로 와야 한다(security c5 A). 시험의 응답 표는 그 앞붙임을 뗀 인자로 본다.
        let a = if file == "git" {
            assert_eq!(&a[..SAFE_GIT_ARGS.len()], &SAFE_GIT_ARGS[..], "{a:?}");
            assert!(env.contains(&("GIT_CONFIG_NOSYSTEM".into(), "1".into())));
            assert!(env.contains(&("GIT_CONFIG_GLOBAL".into(), "/dev/null".into())));
            &a[SAFE_GIT_ARGS.len()..]
        } else {
            a
        };
        c.lock().unwrap().push(a.to_vec());
        // 저장소 설정의 filter 칸 묻기는 기본으로 「없음」(git config 의 code 1).
        if a.len() > 3 && a[2] == "config" && a[3] == "--get-regexp" {
            return fail();
        }
        f(a)
    });
    (
        ScanDeps {
            exec,
            git_path: "git".into(),
            gh_path: "gh".into(),
            gh_env: vec![],
            home: "/h".into(),
            protected: vec![],
        },
        calls,
    )
}

/// 심링크 없는 실제 경로의 임시 폴더(macOS `/var` → `/private/var`).
fn real_tmp() -> (Tmp, String) {
    let d = tmpdir();
    let p = std::fs::canonicalize(d.path())
        .unwrap()
        .to_str()
        .unwrap()
        .to_string();
    (d, p)
}

#[test]
fn porcelain_parses_blocks_and_flags() {
    let out = "worktree /r\nHEAD aaa\nbranch refs/heads/main\n\nworktree /r/../w1\nHEAD bbb\ndetached\n\nworktree /w2\nHEAD ccc\nbranch refs/heads/f\nlocked reason\n\nworktree /w3\nprunable gitdir file points to non-existent location\n\nworktree /b\nbare\n";
    let l = parse_worktree_porcelain(out);
    assert_eq!(l.len(), 5);
    assert_eq!(l[0].branch.as_deref(), Some("main"));
    assert_eq!(l[1].branch, None);
    assert_eq!(l[1].head.as_deref(), Some("bbb"));
    assert!(l[2].locked && !l[2].prunable);
    assert!(l[3].prunable);
    assert!(l[4].bare);
}

#[test]
fn slug_only_github() {
    assert_eq!(
        github_slug("git@github.com:o/r.git\n").as_deref(),
        Some("o/r")
    );
    assert_eq!(
        github_slug("https://github.com/o/r").as_deref(),
        Some("o/r")
    );
    assert_eq!(
        github_slug("https://github.com/o/r.git/").as_deref(),
        Some("o/r")
    );
    assert_eq!(github_slug("https://gitlab.com/o/r"), None);
    assert_eq!(github_slug("https://github.com/o/r/x"), None);
    assert_eq!(github_slug("https://github.com/o/r;rm"), None);
}

#[test]
fn pr_list_open_wins_else_highest() {
    let p = parse_pr_list(
        r#"[{"number":3,"state":"MERGED","headRefOid":"a"},{"number":2,"state":"OPEN"}]"#,
    )
    .unwrap();
    assert_eq!((p.number, p.state), (2, PrState::Open));
    let p = parse_pr_list(
        r#"[{"number":3,"state":"CLOSED"},{"number":9,"state":"MERGED","headRefOid":"z"}]"#,
    )
    .unwrap();
    assert_eq!(
        (p.number, p.state, p.head_sha.as_deref()),
        (9, PrState::Merged, Some("z"))
    );
    assert!(parse_pr_list("[]").is_none());
    assert!(parse_pr_list("nope").is_none());
    assert!(
        parse_pr_list(r#"[{"number":"1","state":"OPEN"},{"number":1,"state":"DRAFT"}]"#).is_none()
    );
}

#[test]
fn candidate_path_narrowing() {
    let (_d, root) = real_tmp();
    let main = format!("{root}/repo");
    let wt = format!("{root}/wt");
    std::fs::create_dir_all(&main).unwrap();
    std::fs::create_dir_all(format!("{main}/inner")).unwrap();
    std::fs::create_dir_all(&wt).unwrap();
    assert!(candidate_path_ok(&wt, &main, &[]));
    // main 자신·자손·조상은 안 된다.
    assert!(!candidate_path_ok(&main, &main, &[]));
    assert!(!candidate_path_ok(&format!("{main}/inner"), &main, &[]));
    assert!(!candidate_path_ok(&root, &main, &[]));
    // 심링크 거절.
    let ln = format!("{root}/ln");
    std::os::unix::fs::symlink(&wt, &ln).unwrap();
    assert!(!candidate_path_ok(&ln, &main, &[]));
    // 없는 경로·상대·`..` 거절.
    assert!(!candidate_path_ok(&format!("{root}/gone"), &main, &[]));
    assert!(!candidate_path_ok("wt", &main, &[]));
    assert!(!candidate_path_ok(&format!("{root}/wt/../wt"), &main, &[]));
}

/// security c5 조건 2 — 홈·계정 뿌리·앱 데이터 폴더와 같거나 그 조상인 경로는 후보가 아니다. 그 안쪽은 막지 않는다.
#[test]
fn candidate_refuses_protected_roots_and_their_ancestors() {
    let (_d, root) = real_tmp();
    let main = format!("{root}/repo");
    let home = format!("{root}/home/me");
    let acct = format!("{home}/.harkroom-agent/claude-accounts");
    let inside = format!("{home}/dev/wt");
    for d in [&main, &acct, &inside] {
        std::fs::create_dir_all(d).unwrap();
    }
    let protected = vec![
        home.clone(),
        format!("{home}/.harkroom-agent"),
        acct.clone(),
    ];
    // 지키는 자리 자신·그 조상은 거절.
    for p in [
        &home,
        &format!("{root}/home"),
        &format!("{home}/.harkroom-agent"),
        &acct,
    ] {
        assert!(!candidate_path_ok(p, &main, &protected), "{p}");
        assert!(guards_protected(p, &protected), "{p}");
    }
    // 홈 안쪽의 평범한 worktree 는 이 검사로 막지 않는다(git 등록·실제 경로 검사는 따로).
    assert!(candidate_path_ok(&inside, &main, &protected));
    assert!(!guards_protected(&inside, &protected));
    // /private/tmp 꼴로 적힌 지키는 자리도 같은 곳으로 본다.
    assert!(guards_protected(
        "/tmp/x",
        &["/private/tmp/x/y".to_string()]
    ));
}

#[test]
fn scan_repo_filters_and_attaches() {
    let (_d, root) = real_tmp();
    let main = format!("{root}/repo");
    let w1 = format!("{root}/w1");
    let w2 = format!("{root}/w2");
    for p in [&main, &w1, &w2] {
        std::fs::create_dir_all(p).unwrap();
    }
    let ln = format!("{root}/ln");
    std::os::unix::fs::symlink(&w1, &ln).unwrap();
    let porcelain = format!(
        "worktree {main}\nHEAD m\nbranch refs/heads/main\n\nworktree {w1}\nHEAD aa\nbranch refs/heads/f1\n\nworktree {w2}\nHEAD bb\ndetached\n\nworktree {ln}\nHEAD cc\nbranch refs/heads/f3\n\nworktree {root}/lk\nHEAD dd\nlocked\n"
    );
    let (d, calls) =
        deps(
            move |a| match a.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
                [_, _, "worktree", ..] => ok(&porcelain),
                [_, _, "remote", ..] => ok("git@github.com:o/r.git\n"),
                ["pr", .., "--head", "f1"] => {
                    ok(r#"[{"number":5,"state":"MERGED","headRefOid":"aa"}]"#)
                }
                ["pr", .., "--search", "bb"] => {
                    ok(r#"[{"number":6,"state":"MERGED","headRefOid":"old"}]"#)
                }
                [_, _, "merge-base", ..] => fail(),
                ["-sk", _] => ok("4\t/x\n"),
                _ => fail(),
            },
        );
    let mut owners = HashMap::new();
    owners.insert(
        w1.clone(),
        OwnerRecord {
            channel_id: "c".into(),
            thread_root_id: "t".into(),
            agent_id: "a".into(),
            worktrees: vec![w1.clone()],
            last_turn_at: None,
            workspace_dir: None,
        },
    );
    let out = scan_repo(&d, &main, &owners);
    assert_eq!(
        out.iter().map(|w| w.path.as_str()).collect::<Vec<_>>(),
        vec![w1.as_str(), w2.as_str()]
    );
    assert_eq!(out[0].pr.as_ref().unwrap().number, 5);
    assert_eq!(out[0].thread.as_ref().unwrap().thread_root_id, "t");
    assert_eq!(out[0].size, Some(4096.0));
    assert_eq!(out[0].repo, main);
    // PR head 가 우리 것이 아니면 PR 모름.
    assert!(out[1].pr.is_none());
    assert!(out[1].thread.is_none());
    // 심링크·locked 는 gh 도 부르지 않았다.
    let c = calls.lock().unwrap();
    assert!(!c.iter().any(|a| a.contains(&"f3".to_string())));
}

#[test]
fn scan_repo_git_failure_is_empty() {
    let (d, _) = deps(|_| fail());
    assert!(scan_repo(&d, "/r", &HashMap::new()).is_empty());
}

#[test]
fn pr_head_checks() {
    let (d, calls) = deps(|_| ok(""));
    assert!(pr_head_is_ours(&d, "/w", Some("ab"), Some("ab")));
    assert!(!pr_head_is_ours(&d, "/w", None, Some("ab")));
    assert!(pr_head_is_ours(&d, "/w", Some("ab"), Some("cd")));
    // sha 모양이 아니면 git 에 넘기지 않는다.
    assert!(!pr_head_is_ours(&d, "/w", Some("--exec=x"), Some("cd")));
    assert_eq!(calls.lock().unwrap().len(), 1);
}

#[test]
fn repo_of_worktree_rules() {
    let (_d, root) = real_tmp();
    let w = format!("{root}/w");
    std::fs::create_dir_all(&w).unwrap();
    let (d, _) = deps(|_| ok("/r/.git\n"));
    assert_eq!(repo_of_worktree(&d, &w).as_deref(), Some("/r"));
    let (bare, _) = deps(|_| ok("/r/repo.git\n"));
    assert_eq!(repo_of_worktree(&bare, &w), None);
    let ln = format!("{root}/ln");
    std::os::unix::fs::symlink(&w, &ln).unwrap();
    assert_eq!(repo_of_worktree(&d, &ln), None);
    assert_eq!(repo_of_worktree(&d, &format!("{root}/gone")), None);
}

#[test]
fn rebuildable_only_last_segment() {
    let (d, _) = deps(|_| ok("!! node_modules/\0!! pkg/target/\0?? new.txt\0"));
    assert!(only_rebuildable_ignored(&d, "/w"));
    let (d, _) = deps(|_| ok("!! src/target/secret.key\0"));
    assert!(!only_rebuildable_ignored(&d, "/w"));
    let (d, _) = deps(|_| ok("!! .env\0"));
    assert!(!only_rebuildable_ignored(&d, "/w"));
    let (d, _) = deps(|_| fail());
    assert!(!only_rebuildable_ignored(&d, "/w"));
}

#[test]
fn last_activity_takes_latest_or_none() {
    let (d, _) = deps(|a| {
        if a.contains(&"log".to_string()) {
            ok("2026-10-01T00:00:00+09:00\n")
        } else {
            fail()
        }
    });
    assert_eq!(
        last_activity_at(&d, "/nonexistent-xyz").as_deref(),
        Some("2026-09-30T15:00:00.000Z")
    );
    let (d, _) = deps(|_| fail());
    assert_eq!(last_activity_at(&d, "/nonexistent-xyz"), None);
}

#[test]
fn thread_done_reads_status_reaction() {
    const ROOT: &str = "22222222-2222-2222-2222-222222222222";
    let seen = Mutex::new(Vec::<String>::new());
    let fw = |agent: &str, req: RunnerLinkRequest| {
        if let RunnerLinkRequest::HttpForward { path, .. } = &req {
            seen.lock().unwrap().push(format!("{agent} {path}"));
        }
        RunnerLinkResponse::HttpResponse {
            id: "x".into(),
            status: 200,
            body: r#"{"statusReaction":{"status":"done"}}"#.into(),
        }
    };
    assert!(is_thread_done(&fw, "a", ROOT, "q"));
    assert_eq!(seen.lock().unwrap()[0], format!("a /messages/{ROOT}"));
    // uuid 모양이 아니면 묻지 않는다.
    assert!(!is_thread_done(&fw, "a", "../x", "q"));
    assert_eq!(seen.lock().unwrap().len(), 1);
    let not = |_: &str, _: RunnerLinkRequest| RunnerLinkResponse::HttpResponse {
        id: "x".into(),
        status: 200,
        body: r#"{"statusReaction":null}"#.into(),
    };
    assert!(!is_thread_done(&not, "a", ROOT, "q"));
    let err = |_: &str, _: RunnerLinkRequest| RunnerLinkResponse::HttpResponse {
        id: "x".into(),
        status: 404,
        body: r#"{"statusReaction":{"status":"done"}}"#.into(),
    };
    assert!(!is_thread_done(&err, "a", ROOT, "q"));
}
