//! [`LinkHooks`] — 턴 임대 토큰은 오퍼레이터 알림으로만 가고, 러너 수명 장부가 쥐며, 놓을 때 받은 cause 로 끝을 알린다.
use std::cell::RefCell;
use std::panic::{AssertUnwindSafe, catch_unwind};

use super::*;

#[derive(Default)]
struct Operator {
    leased: RefCell<Vec<(String, String, String)>>,
    ended: RefCell<Vec<String>>,
}
impl LeaseHandoff for Operator {
    fn heartbeat(&self, _cause: &str) {}
    fn lease(&self, cause: &str, lease_id: &str, token: &str, _expires_at: &str) {
        self.leased
            .borrow_mut()
            .push((cause.into(), lease_id.into(), token.into()));
    }
    fn lease_ended(&self, cause: &str) {
        self.ended.borrow_mut().push(cause.into());
    }
}

#[derive(Default)]
struct Sched {
    slots: Vec<String>,
    ended: Vec<(String, String)>,
    outcomes: Vec<bool>,
}
impl SchedulerHooks for Sched {
    fn notice_fenced(&mut self, _thread_key: &str) {}
    fn turn_outcome(&mut self, ok: bool) {
        self.outcomes.push(ok);
    }
    fn stop_requested(&mut self, _at: &str) {}
    fn executable_missing(&mut self) {}
    fn release_slot(&mut self, k: &str) {
        self.slots.push(k.into());
    }
    fn turn_ended(&mut self, k: &str, m: &str) {
        self.ended.push((k.into(), m.into()));
    }
}

#[test]
fn lease_goes_to_operator_and_release_ends_that_cause_once() {
    let op = Operator::default();
    let book = LeaseBook::default();
    let mut h = LinkHooks::new(&op, &book, Sched::default(), "k".into(), || 1);
    h.lease_issued(
        "men-1",
        TurnLease {
            id: "lease-1".into(),
            token: "tok-secret-value".into(),
            expires_at: "x".into(),
        },
    );
    assert_eq!(
        *op.leased.borrow(),
        vec![("men-1".into(), "lease-1".into(), "tok-secret-value".into())]
    );
    assert_eq!(h.cause.as_deref(), Some("men-1"), "쥐는 것은 cause 뿐");
    assert_eq!(book.get("men-1"), Some(Booked::Held));
    h.release_lease();
    h.release_lease();
    assert_eq!(
        *op.ended.borrow(),
        vec!["men-1".to_string()],
        "끝 알림은 한 번"
    );
    assert!(book.is_empty());
}

#[test]
fn scheduler_parts_are_delegated() {
    let op = Operator::default();
    let book = LeaseBook::default();
    let mut h = LinkHooks::new(&op, &book, Sched::default(), "k".into(), || 1);
    h.release_slot("t");
    h.turn_ended("t", "m");
    h.turn_outcome(true);
    assert_eq!(h.scheduler.slots, vec!["t".to_string()]);
    assert_eq!(h.scheduler.ended, vec![("t".to_string(), "m".to_string())]);
    assert_eq!(h.scheduler.outcomes, vec![true]);
    assert!(op.ended.borrow().is_empty(), "임대가 없으면 끝 알림도 없다");
}

fn lease() -> TurnLease {
    TurnLease {
        id: "l".into(),
        token: "t".into(),
        expires_at: "x".into(),
    }
}

/// 정상 길에서 떨어지면 놓지 않는다(재시도 갈래 — 장부가 쥔다). 다음 호출은 장부의 답을 그대로 쓰고, 놓으면 한 번 끝을 알린다.
#[test]
fn normal_drop_keeps_lease_in_book_for_next_call() {
    let op = Operator::default();
    let book = LeaseBook::default();
    {
        let mut h = LinkHooks::new(&op, &book, Sched::default(), "k".into(), || 1);
        assert_eq!(h.prior_lease("men-2"), None);
        h.lease_issued("men-2", lease());
    }
    assert!(op.ended.borrow().is_empty(), "정상 Drop 은 놓지 않는다");
    assert_eq!(book.get("men-2"), Some(Booked::Held));

    let mut h = LinkHooks::new(&op, &book, Sched::default(), "k".into(), || 1);
    assert_eq!(
        h.prior_lease("men-2"),
        Some(LeaseState::Ready),
        "다시 청하지 않는다"
    );
    h.release_lease();
    drop(h);
    assert_eq!(*op.ended.borrow(), vec!["men-2".to_string()]);
    assert!(book.is_empty());
}

/// 패닉 풀림 중 떨어지면 한 번 놓는다(장부에서도 지운다).
#[test]
fn held_lease_is_ended_on_panic_drop_once() {
    let op = Operator::default();
    let book = LeaseBook::default();
    let r = catch_unwind(AssertUnwindSafe(|| {
        let mut h = LinkHooks::new(&op, &book, Sched::default(), "k".into(), || 1);
        h.lease_issued("men-3", lease());
        panic!("시험 패닉");
    }));
    assert!(r.is_err());
    assert_eq!(*op.ended.borrow(), vec!["men-3".to_string()]);
    assert!(book.is_empty());
}

/// 거절은 적어 두고(재시도마다 다시 묻지 않는다) 놓을 때 끝을 알리지 않는다(받은 임대가 없다).
#[test]
fn declined_is_booked_and_release_sends_nothing() {
    let op = Operator::default();
    let book = LeaseBook::default();
    {
        let mut h = LinkHooks::new(&op, &book, Sched::default(), "k".into(), || 1);
        h.lease_declined("men-4");
    }
    let mut h = LinkHooks::new(&op, &book, Sched::default(), "k".into(), || 1);
    assert_eq!(h.prior_lease("men-4"), Some(LeaseState::Declined));
    h.release_lease();
    assert!(op.ended.borrow().is_empty());
    assert!(book.is_empty());
}

fn lease_of(id: &str) -> TurnLease {
    TurnLease {
        id: id.into(),
        token: "tok".into(),
        expires_at: "x".into(),
    }
}

fn beating_book(
    count: Arc<std::sync::atomic::AtomicU32>,
    secrets_dir: Option<PathBuf>,
) -> LeaseBook {
    LeaseBook::with_life(LeaseLife {
        beat: Arc::new(move |_c: &str| {
            count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }),
        every: Duration::from_millis(5),
        secrets_dir,
    })
}

/// security C6 전 필수 ①: 박동은 받은 임대에 걸리고, 결말(놓기)에서 멈춘다.
#[test]
fn heartbeat_runs_while_held_and_stops_on_release() {
    use std::sync::atomic::{AtomicU32, Ordering};
    let n = Arc::new(AtomicU32::new(0));
    let book = beating_book(n.clone(), None);
    let op = Operator::default();
    let mut h = LinkHooks::new(&op, &book, Sched::default(), "k".into(), || 1);
    h.lease_issued("m1", lease_of("l1"));
    std::thread::sleep(Duration::from_millis(60));
    assert!(n.load(Ordering::SeqCst) >= 2, "쥔 동안 박동");
    h.release_lease();
    let after = n.load(Ordering::SeqCst);
    std::thread::sleep(Duration::from_millis(60));
    assert_eq!(n.load(Ordering::SeqCst), after, "놓은 뒤에는 멈춘다");
    assert_eq!(*op.ended.borrow(), vec!["m1".to_string()]);
}

/// 거절된 멘션에는 박동을 걸지 않고 끝 알림도 없다.
#[test]
fn declined_has_no_heartbeat_and_no_end() {
    use std::sync::atomic::{AtomicU32, Ordering};
    let n = Arc::new(AtomicU32::new(0));
    let book = beating_book(n.clone(), None);
    let op = Operator::default();
    let mut h = LinkHooks::new(&op, &book, Sched::default(), "k".into(), || 1);
    h.lease_declined("m1");
    std::thread::sleep(Duration::from_millis(30));
    h.release_lease();
    assert_eq!(n.load(Ordering::SeqCst), 0);
    assert!(op.ended.borrow().is_empty());
}

/// 패닉 풀림에서도 박동이 멈춘다(가드).
#[test]
fn heartbeat_stops_on_panic_unwind() {
    use std::sync::atomic::{AtomicU32, Ordering};
    let n = Arc::new(AtomicU32::new(0));
    let book = beating_book(n.clone(), None);
    let op = Operator::default();
    let r = catch_unwind(AssertUnwindSafe(|| {
        let mut h = LinkHooks::new(&op, &book, Sched::default(), "k".into(), || 1);
        h.lease_issued("m1", lease_of("l1"));
        panic!("멘션 도중 패닉");
    }));
    assert!(r.is_err());
    let after = n.load(Ordering::SeqCst);
    std::thread::sleep(Duration::from_millis(60));
    assert_eq!(n.load(Ordering::SeqCst), after, "패닉 뒤 박동 없음");
    assert!(book.is_empty());
}

/// 끝 알림 때 기록을 읽는 오퍼레이터 — 그 순간 기록이 이미 가려졌는지 본다.
struct CheckingOperator {
    transcript: PathBuf,
    secret: String,
    masked_at_end: RefCell<Option<bool>>,
}
impl LeaseHandoff for CheckingOperator {
    fn heartbeat(&self, _cause: &str) {}
    fn lease(&self, _c: &str, _l: &str, _t: &str, _e: &str) {}
    fn lease_ended(&self, _cause: &str) {
        let body = std::fs::read_to_string(&self.transcript).unwrap();
        *self.masked_at_end.borrow_mut() = Some(!body.contains(&self.secret));
    }
}

/// security C6 전 필수 ②(D7): 결말에서 이 멘션의 기록을 **가린 뒤** 끝을 알린다.
#[test]
fn records_are_scrubbed_before_the_end_notice() {
    let root = std::env::temp_dir().join(format!("hk-lease-d7-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let secret = "supersecretvalue-0123456789";
    let lease_dir = root.join("secrets").join("l1");
    std::fs::create_dir_all(&lease_dir).unwrap();
    std::fs::write(lease_dir.join("db-pass"), secret).unwrap();
    let transcript = root.join("t.jsonl");
    std::fs::write(&transcript, format!("{{\"echo\":\"{secret}\"}}\n")).unwrap();

    let n = Arc::new(std::sync::atomic::AtomicU32::new(0));
    let book = beating_book(n, Some(root.join("secrets")));
    let op = CheckingOperator {
        transcript: transcript.clone(),
        secret: secret.into(),
        masked_at_end: RefCell::new(None),
    };
    let mut h = LinkHooks::new(&op, &book, Sched::default(), "k".into(), || 1);
    h.lease_issued("m1", lease_of("l1"));
    book.note_transcript("m1", transcript.clone());
    h.release_lease();
    assert_eq!(
        *op.masked_at_end.borrow(),
        Some(true),
        "끝 알림 순간 이미 가려짐"
    );
    assert!(
        !std::fs::read_to_string(&transcript)
            .unwrap()
            .contains(secret)
    );
    let _ = std::fs::remove_dir_all(&root);
}

/// security: 결말 가리기는 폴더도 내려간다 — claude 곁 폴더(`<sessionId>/tool-results/…`)의 비밀이 결말에 가려진다.
#[test]
fn conclusion_scrub_walks_the_session_side_folder() {
    let root = std::env::temp_dir().join(format!("hk-lease-dir-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let secret = "folder-secret-value-0123456789";
    let lease_dir = root.join("secrets").join("l1");
    std::fs::create_dir_all(&lease_dir).unwrap();
    std::fs::write(lease_dir.join("token"), secret).unwrap();
    let side = root.join("sess");
    std::fs::create_dir_all(side.join("tool-results")).unwrap();
    let out = side.join("tool-results").join("out.txt");
    std::fs::write(&out, format!("printed {secret}\n")).unwrap();

    let n = Arc::new(std::sync::atomic::AtomicU32::new(0));
    let book = beating_book(n, Some(root.join("secrets")));
    let op = Operator::default();
    let mut h = LinkHooks::new(&op, &book, Sched::default(), "k".into(), || 1);
    h.lease_issued("m1", lease_of("l1"));
    book.note_transcript("m1", side.clone());
    h.release_lease();
    assert!(
        !std::fs::read_to_string(&out).unwrap().contains(secret),
        "곁 폴더 안 파일도 가려졌다"
    );
    let _ = std::fs::remove_dir_all(&root);
}

/// T3a: 그 멘션의 임대 폴더는 받은 임대(`Held`)이고 id 가 안전할 때만 — 거절·다른 멘션·이상한 id·뿌리 없음은 `None`.
#[test]
fn lease_dir_only_for_held_cause_with_safe_id() {
    let n = Arc::new(std::sync::atomic::AtomicU32::new(0));
    let root = PathBuf::from("/secrets-root");
    let book = beating_book(n.clone(), Some(root.clone()));
    book.put("m1", Booked::Held, Some("lease-1"));
    book.put("m2", Booked::Declined, None);
    book.put("m3", Booked::Held, Some("../x"));
    book.put("m4", Booked::Held, Some(""));
    book.put("m5", Booked::Held, Some("."));
    assert_eq!(book.lease_dir("m1"), Some(root.join("lease-1")));
    assert_eq!(book.lease_dir("m2"), None, "거절된 멘션");
    assert_eq!(book.lease_dir("m3"), None, "id 에 .. 이 들면");
    assert_eq!(book.lease_dir("m4"), None, "빈 id");
    assert_eq!(book.lease_dir("m5"), None, "뿌리 자신");
    assert_eq!(book.lease_dir("other"), None, "장부에 없는 멘션");
    let bare = beating_book(n, None);
    bare.put("m1", Booked::Held, Some("lease-1"));
    assert_eq!(bare.lease_dir("m1"), None, "턴 비밀 뿌리 없음");
    for c in ["m1", "m2", "m3", "m4", "m5"] {
        book.release(c);
    }
    bare.release("m1");
}
