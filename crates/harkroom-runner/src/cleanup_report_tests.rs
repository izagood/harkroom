use super::*;
use serde_json::json;

const HOME: &str = "/home/u";

fn paths(cmd: &str) -> Vec<String> {
    worktree_add_paths(cmd, HOME)
}

#[test]
fn absolute_and_tilde_paths_with_flags() {
    assert_eq!(
        paths("git worktree add -b feat /repo-wt/x main"),
        vec!["/repo-wt/x"]
    );
    assert_eq!(
        paths("git worktree add --detach ~/wt/y"),
        vec!["/home/u/wt/y"]
    );
    assert_eq!(
        paths("git worktree add --reason because /a/b/"),
        vec!["/a/b"]
    );
    assert_eq!(paths("git worktree add /private/tmp/z"), vec!["/tmp/z"]);
}

#[test]
fn var_assignment_resolves() {
    assert_eq!(
        paths("W=/abs; git worktree add -b x $W/wt"),
        vec!["/abs/wt"]
    );
    assert_eq!(
        paths("export W=~/w && git worktree add \"${W}/wt\""),
        vec!["/home/u/w/wt"]
    );
}

#[test]
fn cd_resolves_relative() {
    assert_eq!(paths("cd /repo && git worktree add ../wt"), vec!["/wt"]);
    assert_eq!(
        paths("cd /repo/sub && git worktree add ../wt -b x"),
        vec!["/repo/wt"]
    );
}

#[test]
fn git_c_wins_over_cd() {
    assert_eq!(paths("git -C /repo worktree add rel"), vec!["/repo/rel"]);
    assert_eq!(
        paths("cd /other; git -C /repo worktree add ./rel"),
        vec!["/repo/rel"]
    );
}

#[test]
fn unresolvable_skipped() {
    assert!(paths("git worktree add $X/wt").is_empty());
    assert!(paths("git worktree add rel").is_empty());
    assert!(paths("cd \"$UNKNOWN\" && git worktree add rel").is_empty());
}

#[test]
fn normalize_collapses() {
    assert_eq!(normalize_cleanup_path("/a/./b/../c/"), "/a/c");
    assert_eq!(normalize_cleanup_path("/private/tmp/x/"), "/tmp/x");
    assert_eq!(normalize_cleanup_path("/private/var/x"), "/private/var/x");
}

#[test]
fn only_executed_commands_count() {
    let lines = [
        json!({"type":"assistant","message":{"content":[{"type":"tool_use","input":{"command":"git worktree add /repo/wt1"}}]}}),
        json!({"type":"user","message":{"content":[{"type":"tool_result","content":"ran git worktree add /repo/evil"}]}}),
        json!({"type":"response_item","payload":{"type":"function_call","arguments":"{\"command\":[\"bash\",\"-lc\",\"cd /repo && git worktree add ../wt2\"]}"}}),
        json!({"type":"x","text":"worktree add /repo/evil2"}),
    ];
    let jsonl: String = lines.iter().map(|l| format!("{l}\n")).collect();
    let cmds = command_texts(&jsonl);
    let all: Vec<String> = cmds.iter().flat_map(|c| paths(c)).collect();
    assert_eq!(all, vec!["/repo/wt1", "/wt2"]);
}

#[test]
fn owned_requires_listing_of_path_itself() {
    let dir = std::env::temp_dir().join(format!("cr-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let f = dir.join("t.jsonl");
    let l1 = json!({"type":"tool_use","input":{"command":"git worktree add /repo/a && git worktree add /repo/b"}});
    std::fs::write(&f, format!("{l1}\n")).unwrap();
    let list = |p: &Path| {
        if p == Path::new("/repo/a") {
            vec!["/repo".to_string(), "/repo/a".to_string()]
        } else {
            vec!["/repo".to_string()]
        }
    };
    assert_eq!(owned_worktrees(&[f], HOME, &list), vec!["/repo/a"]);
    let _ = std::fs::remove_dir_all(&dir);
}

fn reporter(
    sent: Arc<Mutex<Vec<Value>>>,
    reply: Vec<Value>,
    deleted: Arc<Mutex<Vec<String>>>,
) -> CleanupReporter {
    let reply = Mutex::new(Some(reply));
    CleanupReporter::new(CleanupDeps {
        send: Box::new(move |r| {
            sent.lock().unwrap().push(r.clone());
            Some(reply.lock().unwrap().take().unwrap_or_default())
        }),
        list_worktrees: Box::new(|_| Vec::new()),
        home: HOME.into(),
        workspace_dir_of: Box::new(|_| Some("/ws".into())),
        delete_thread: Some(Box::new(move |k| {
            deleted.lock().unwrap().push(k.to_string());
            DeleteOutcome::Deleted
        })),
        now_iso: Box::new(|| "2026-01-01T00:00:00.000Z".into()),
    })
}

#[test]
fn tick_deletes_idle_threads_and_reports_deleted_next() {
    let sent = Arc::new(Mutex::new(Vec::new()));
    let deleted = Arc::new(Mutex::new(Vec::new()));
    let r = reporter(
        Arc::clone(&sent),
        vec![
            json!({"channelId":"c","threadRootId":"busy"}),
            json!({"channelId":"c","threadRootId":"idle"}),
        ],
        Arc::clone(&deleted),
    );
    r.mark_open("c/busy");
    r.tick();
    assert_eq!(*deleted.lock().unwrap(), vec!["c/idle"]);
    let first = sent.lock().unwrap()[0].clone();
    assert_eq!(first["threads"][0]["threadRootId"], "busy");
    assert_eq!(first["threads"][0]["running"], true);
    assert!(first.get("deleted").is_none());
    r.tick();
    let second = sent.lock().unwrap()[1].clone();
    assert_eq!(
        second["deleted"],
        json!([{"channelId":"c","threadRootId":"idle"}])
    );
}

#[test]
fn turn_end_reports_not_running_and_closes() {
    let sent = Arc::new(Mutex::new(Vec::new()));
    let r = reporter(Arc::clone(&sent), vec![], Arc::default());
    r.mark_open("c/t");
    r.turn_started("c/t");
    r.turn_ended("c/t", "m1");
    assert!(!r.is_open("c/t"));
    let s = sent.lock().unwrap();
    assert_eq!(s[0]["threads"][0]["running"], true);
    assert_eq!(s[0]["threads"][0]["workspaceDir"], "/ws");
    assert_eq!(
        s[1]["threads"],
        json!([{
            "channelId":"c","threadRootId":"t","worktrees":[],
            "lastTurnAt":"2026-01-01T00:00:00.000Z","running":false,"workspaceDir":"/ws"
        }])
    );
}

#[test]
fn delete_thread_refuses_outside_root_and_symlink() {
    let root = std::env::temp_dir().join(format!("cr-del-{}", std::process::id()));
    let base = root.join("workspaces");
    let ws = base.join("t1");
    let outside = root.join("outside");
    std::fs::create_dir_all(&ws).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    std::os::unix::fs::symlink(&outside, base.join("link")).unwrap();
    let proj = root.join("acc").join("projects");
    let pdir = proj.join(claude_project_dir_name(ws.to_str().unwrap()));
    std::fs::create_dir_all(pdir.join("memory")).unwrap();
    std::fs::write(pdir.join("s.jsonl"), "{}").unwrap();

    let store = SessionStore::new(root.join("sessions.json"));
    let rec = |w: &Path| crate::session_store::SessionRecord {
        workspace_dir: w.to_str().unwrap().into(),
        session_id: None,
        harness: crate::adapter::AgentHarness::ClaudeCode,
        last_fed_seq: 0,
        turns_run: 0,
        claude_account: None,
        claude_pool: None,
        unseen_own_after_seq: None,
        canceled_by: None,
    };
    store.put("c/in", rec(&ws)).unwrap();
    store.put("c/out", rec(&outside)).unwrap();
    store.put("c/link", rec(&base.join("link"))).unwrap();

    assert_eq!(
        delete_thread(&store, &base, std::slice::from_ref(&proj), "c/none"),
        DeleteOutcome::Absent
    );
    assert_eq!(
        delete_thread(&store, &base, std::slice::from_ref(&proj), "c/out"),
        DeleteOutcome::Refused
    );
    assert_eq!(
        delete_thread(&store, &base, std::slice::from_ref(&proj), "c/link"),
        DeleteOutcome::Refused
    );
    assert!(outside.exists());
    assert_eq!(
        delete_thread(&store, &base, std::slice::from_ref(&proj), "c/in"),
        DeleteOutcome::Deleted
    );
    assert!(!ws.exists());
    assert!(store.get("c/in").is_none());
    assert!(pdir.join("memory").exists());
    assert!(!pdir.join("s.jsonl").exists());
    let _ = std::fs::remove_dir_all(&root);
}
