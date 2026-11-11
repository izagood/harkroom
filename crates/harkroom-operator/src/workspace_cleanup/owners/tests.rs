use super::*;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

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

const C: &str = "11111111-1111-1111-1111-111111111111";
const R1: &str = "22222222-2222-2222-2222-222222222222";
const R2: &str = "33333333-3333-3333-3333-333333333333";

fn t(r: &str) -> ThreadRef {
    ThreadRef {
        channel_id: C.into(),
        thread_root_id: r.into(),
    }
}

struct Fx {
    _dir: Tmp,
    owners: CleanupOwners,
    now: Arc<AtomicU64>,
    on: Arc<AtomicBool>,
    path: PathBuf,
}

fn fx() -> Fx {
    let dir = tmpdir();
    let path = cleanup_owners_path(dir.path());
    let now = Arc::new(AtomicU64::new(
        parse_iso_ms("2026-10-06T00:00:00Z").unwrap(),
    ));
    let on = Arc::new(AtomicBool::new(true));
    let (n, o) = (now.clone(), on.clone());
    let owners = CleanupOwners::new(
        path.clone(),
        Box::new(move || n.load(Ordering::SeqCst)),
        Box::new(move || o.load(Ordering::SeqCst)),
        None,
        Box::new(|_| {}),
    );
    Fx {
        _dir: dir,
        owners,
        now,
        on,
        path,
    }
}

fn report(body: Value) -> RunnerLinkRequest {
    RunnerLinkRequest::HttpForward {
        id: "q".into(),
        method: "POST".into(),
        path: CLEANUP_REPORT_PATH.into(),
        body: Some(body.to_string()),
        body_base64: None,
        content_type: None,
    }
}

fn send(o: &CleanupOwners, runner: &str, agent: &str, body: Value) -> (u16, Value) {
    match o.maybe_handle(runner, agent, &report(body), RunnerLinkKind::Relay) {
        Some(RunnerLinkResponse::HttpResponse { status, body, .. }) => {
            (status, serde_json::from_str(&body).unwrap_or(Value::Null))
        }
        other => panic!("{other:?}"),
    }
}

fn th(r: &str, running: bool, last: &str, wt: &[&str], ws: Option<&str>) -> Value {
    json!({"channelId": C, "threadRootId": r, "running": running, "lastTurnAt": last,
           "worktrees": wt, "workspaceDir": ws})
}

#[test]
fn ignores_other_requests_and_refuses_non_relay() {
    let f = fx();
    let get = RunnerLinkRequest::HttpForward {
        id: "q".into(),
        method: "GET".into(),
        path: CLEANUP_REPORT_PATH.into(),
        body: None,
        body_base64: None,
        content_type: None,
    };
    assert!(
        f.owners
            .maybe_handle("r", "a", &get, RunnerLinkKind::Relay)
            .is_none()
    );
    let res = f.owners.maybe_handle(
        "r",
        "a",
        &report(json!({"threads": []})),
        RunnerLinkKind::Bridge,
    );
    assert!(matches!(
        res,
        Some(RunnerLinkResponse::HttpResponse { status: 403, .. })
    ));
    assert_eq!(send(&f.owners, "r", "a", json!({})).0, 400);
}

#[test]
fn records_owners_and_running_and_persists() {
    let f = fx();
    let (s, b) = send(
        &f.owners,
        "run1",
        "a1",
        json!({"threads": [th(R1, true, "2026-10-05T00:00:00Z", &["/private/tmp/w1/"], Some("/s/ws1"))]}),
    );
    assert_eq!(s, 200);
    assert_eq!(b, json!({"deleteThreads": []}));
    assert!(f.owners.running().contains(&t(R1).key()));
    let own = f.owners.owner_of();
    assert_eq!(own.get("/tmp/w1").unwrap().agent_id, "a1");
    // 다시 읽어도 남는다(running 은 남지 않는다).
    let back = read_owners(&f.path);
    assert_eq!(
        back.get(&t(R1).key()).unwrap().workspace_dir.as_deref(),
        Some("/s/ws1")
    );
    f.owners.release_runner("run1");
    assert!(f.owners.running().is_empty());
}

#[test]
fn other_agent_cannot_take_workspace_dir() {
    let f = fx();
    send(
        &f.owners,
        "r1",
        "a1",
        json!({"threads": [th(R1, false, "2026-10-01T00:00:00Z", &["/w/a"], Some("/s/ws1"))]}),
    );
    send(
        &f.owners,
        "r2",
        "a2",
        json!({"threads": [th(R1, false, "2026-10-02T00:00:00Z", &["/w/b"], Some("/evil"))]}),
    );
    let rec = f.owners.threads().into_iter().next().unwrap();
    assert_eq!(rec.agent_id, "a1");
    assert_eq!(rec.workspace_dir.as_deref(), Some("/s/ws1"));
    assert_eq!(rec.worktrees, vec!["/w/a".to_string(), "/w/b".to_string()]);
    assert_eq!(
        rec.last_turn_at.as_deref(),
        Some("2026-10-02T00:00:00.000Z")
    );
}

#[test]
fn delete_request_flows_and_confirm() {
    let f = fx();
    send(
        &f.owners,
        "r1",
        "a1",
        json!({"threads": [th(R1, false, "2026-10-01T00:00:00Z", &[], Some("/s/ws1"))]}),
    );
    f.owners.request_delete(&t(R1));
    // 다른 에이전트 보고에는 싣지 않는다.
    assert_eq!(
        send(&f.owners, "r2", "a2", json!({"threads": []})).1,
        json!({"deleteThreads": []})
    );
    let (_, b) = send(&f.owners, "r1", "a1", json!({"threads": []}));
    assert_eq!(
        b,
        json!({"deleteThreads": [{"channelId": C, "threadRootId": R1}]})
    );
    // 다른 에이전트가 「지웠다」고 해도 받지 않는다.
    send(
        &f.owners,
        "r2",
        "a2",
        json!({"threads": [], "deleted": [{"channelId": C, "threadRootId": R1}]}),
    );
    assert!(f.owners.drain_deleted().is_empty());
    send(
        &f.owners,
        "r1",
        "a1",
        json!({"threads": [], "deleted": [{"channelId": C, "threadRootId": R1}]}),
    );
    let d = f.owners.drain_deleted();
    assert_eq!(
        d,
        vec![DeletedConfirmed {
            thread: t(R1),
            path: "/s/ws1".into()
        }]
    );
    assert!(f.owners.drain_deleted().is_empty());
    assert!(f.owners.threads()[0].workspace_dir.is_none());
}

#[test]
fn unrequested_deleted_is_ignored() {
    let f = fx();
    send(
        &f.owners,
        "r1",
        "a1",
        json!({"threads": [th(R1, false, "2026-10-01T00:00:00Z", &[], Some("/s/ws1"))]}),
    );
    send(
        &f.owners,
        "r1",
        "a1",
        json!({"threads": [], "deleted": [{"channelId": C, "threadRootId": R1}]}),
    );
    assert!(f.owners.drain_deleted().is_empty());
    assert_eq!(
        f.owners.threads()[0].workspace_dir.as_deref(),
        Some("/s/ws1")
    );
}

#[test]
fn revive_on_new_turn_or_running() {
    let f = fx();
    send(
        &f.owners,
        "r1",
        "a1",
        json!({"threads": [
        th(R1, false, "2026-10-01T00:00:00Z", &[], Some("/s/1")),
        th(R2, false, "2026-10-01T00:00:00Z", &[], Some("/s/2"))]}),
    );
    f.owners.request_delete(&t(R1));
    f.owners.request_delete(&t(R2));
    f.now.store(
        parse_iso_ms("2026-10-07T00:00:00Z").unwrap(),
        Ordering::SeqCst,
    );
    let (_, b) = send(
        &f.owners,
        "r1",
        "a1",
        json!({"threads": [
        th(R1, true, "2026-10-01T00:00:00Z", &[], None),
        th(R2, false, "2026-10-06T12:00:00Z", &[], None)]}),
    );
    assert_eq!(b, json!({"deleteThreads": []}));
    assert!(
        f.owners
            .live(None)
            .threads
            .values()
            .all(|l| l.delete_requested_at.is_none())
    );
}

#[test]
fn disabled_clears_requests() {
    let f = fx();
    send(
        &f.owners,
        "r1",
        "a1",
        json!({"threads": [th(R1, false, "2026-10-01T00:00:00Z", &[], Some("/s/1"))]}),
    );
    f.owners.request_delete(&t(R1));
    f.on.store(false, Ordering::SeqCst);
    assert_eq!(
        send(&f.owners, "r1", "a1", json!({"threads": []})).1,
        json!({"deleteThreads": []})
    );
    f.on.store(true, Ordering::SeqCst);
    assert_eq!(
        send(&f.owners, "r1", "a1", json!({"threads": []})).1,
        json!({"deleteThreads": []})
    );
}

#[test]
fn retain_cancel_and_live() {
    let f = fx();
    send(
        &f.owners,
        "r1",
        "a1",
        json!({"threads": [
        th(R1, false, "2026-10-01T00:00:00Z", &[], Some("/s/1")),
        th(R2, false, "2026-10-01T00:00:00Z", &[], Some("/s/2"))]}),
    );
    f.owners.request_delete(&t(R1));
    f.now.store(
        parse_iso_ms("2026-10-07T00:00:00Z").unwrap(),
        Ordering::SeqCst,
    );
    f.owners.request_delete(&t(R1)); // 두 번째는 시각을 바꾸지 않는다
    f.owners.request_delete(&t(R2));
    f.owners.cancel_delete(&t(R2));
    let live = f.owners.live(None);
    assert!(live.owners_reported);
    assert_eq!(
        live.threads[&t(R1).key()].delete_requested_at.as_deref(),
        Some("2026-10-06T00:00:00.000Z")
    );
    assert!(live.threads[&t(R1).key()].runner_connected);
    assert!(live.threads[&t(R2).key()].delete_requested_at.is_none());
    f.owners.retain_deletes(&HashSet::new());
    assert!(
        f.owners.live(None).threads[&t(R1).key()]
            .delete_requested_at
            .is_none()
    );
    let only: HashSet<String> = [t(R2).key()].into();
    assert_eq!(f.owners.live(Some(&only)).threads.len(), 1);
    f.owners.release_runner("r1");
    assert!(!f.owners.live(None).threads[&t(R1).key()].runner_connected);
}

#[test]
fn owner_of_prefers_later_turn() {
    let f = fx();
    send(
        &f.owners,
        "r1",
        "a1",
        json!({"threads": [
        th(R1, false, "2026-10-01T00:00:00Z", &["/w/x"], None),
        th(R2, false, "2026-10-03T00:00:00Z", &["/w/x"], None)]}),
    );
    assert_eq!(f.owners.owner_of()["/w/x"].thread_root_id, R2);
    assert_eq!(f.owners.last_turn_at().len(), 2);
}

#[test]
fn read_owners_rejects_bad_shapes_and_symlink() {
    let dir = tmpdir();
    let p = dir.path().join("owners.json");
    let good = OwnerRecord {
        channel_id: C.into(),
        thread_root_id: R1.into(),
        agent_id: "a".into(),
        worktrees: vec!["/w".into()],
        last_turn_at: None,
        workspace_dir: None,
    };
    let bad_path = OwnerRecord {
        worktrees: vec!["rel".into()],
        ..good.clone()
    };
    std::fs::write(
        &p,
        json!({ t(R1).key(): good, "wrong/key": good, t(R2).key(): bad_path }).to_string(),
    )
    .unwrap();
    let got = read_owners(&p);
    assert_eq!(got.len(), 1);
    assert!(got.contains_key(&t(R1).key()));
    let link = dir.path().join("link.json");
    std::os::unix::fs::symlink(&p, &link).unwrap();
    assert!(read_owners(&link).is_empty());
    std::fs::write(dir.path().join("arr.json"), "[]").unwrap();
    assert!(read_owners(&dir.path().join("arr.json")).is_empty());
}

#[test]
fn write_owners_is_private_and_refuses_symlinked_dir() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tmpdir();
    let p = cleanup_owners_path(dir.path());
    write_owners(&p, &HashMap::new()).unwrap();
    assert_eq!(
        std::fs::metadata(&p).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(
        std::fs::metadata(p.parent().unwrap())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    let real = dir.path().join("real");
    std::fs::create_dir(&real).unwrap();
    let ln = dir.path().join("ln");
    std::os::unix::fs::symlink(&real, &ln).unwrap();
    assert!(write_owners(&ln.join("owners.json"), &HashMap::new()).is_err());
}
