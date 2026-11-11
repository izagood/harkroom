//! TS `test/localTerminal.test.ts` 의 이식 + 감사 보고(gen) 짝맞춤.
use super::*;
use std::sync::atomic::{AtomicBool, Ordering};

const VIEW: &str = "vvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv";
const VIEW2: &str = "wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww";
const W1: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const W2: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

#[derive(Default)]
struct Rec {
    to_runner: Mutex<Vec<(String, Value)>>,
    logs: Mutex<Vec<String>>,
    reports: Mutex<Vec<(String, String, i64, i64)>>,
    scheduled: Mutex<Vec<Box<dyn FnOnce() + Send>>>,
    unlinked: AtomicBool,
}

struct Deps(Arc<Rec>);
impl LocalTerminalDeps for Deps {
    fn send_to_runner(&self, runner_id: &str, frame: &Value) -> bool {
        if self.0.unlinked.load(Ordering::SeqCst) {
            return false;
        }
        self.0
            .to_runner
            .lock()
            .unwrap()
            .push((runner_id.into(), frame.clone()));
        true
    }
    fn report_input(&self, runner_id: &str, session_id: &str, r#gen: i64, bytes: i64) {
        self.0
            .reports
            .lock()
            .unwrap()
            .push((runner_id.into(), session_id.into(), r#gen, bytes));
    }
    fn schedule(&self, f: Box<dyn FnOnce() + Send>, _ms: u64) {
        self.0.scheduled.lock().unwrap().push(f);
    }
    fn log(&self, line: &str) {
        self.0.logs.lock().unwrap().push(line.into());
    }
}

struct Subscriber {
    id: u64,
    events: Mutex<Vec<(String, Value)>>,
}
impl LocalTerminalSubscriber for Subscriber {
    fn id(&self) -> u64 {
        self.id
    }
    fn send(&self, event: &str, payload: Value) {
        self.events.lock().unwrap().push((event.into(), payload));
    }
}

struct T {
    hub: Arc<LocalTerminalHub>,
    rec: Arc<Rec>,
    sub: Arc<Subscriber>,
}
impl T {
    fn events(&self) -> Vec<(String, Value)> {
        self.sub.events.lock().unwrap().clone()
    }
    fn to_runner(&self) -> Vec<(String, Value)> {
        self.rec.to_runner.lock().unwrap().clone()
    }
    fn subscribe(&self, sid: &str, key: &str) -> Result<(), Refusal> {
        self.hub.subscribe(self.sub.clone(), sid, key)
    }
    fn frame(&self, runner: &str, f: Value) {
        self.hub.on_runner_frame(runner, &f);
    }
    fn run_scheduled(&self) {
        let fs: Vec<_> = self.rec.scheduled.lock().unwrap().drain(..).collect();
        for f in fs {
            f();
        }
    }
}

fn setup() -> T {
    let rec = Arc::new(Rec::default());
    let hub = LocalTerminalHub::new(Box::new(Deps(rec.clone())));
    let sub = Arc::new(Subscriber {
        id: 1,
        events: Mutex::new(Vec::new()),
    });
    let t = T { hub, rec, sub };
    t.frame(
        "r1",
        json!({"type":"announce","sessions":[{"sessionId":"s1"}]}),
    );
    t
}

fn datas(ev: &[(String, Value)]) -> Vec<Value> {
    ev.iter()
        .map(|(_, p)| p.get("data").cloned().unwrap_or(Value::Null))
        .collect()
}

// ── 열람(F2) ──

#[test]
fn answers_only_whether_local() {
    let t = setup();
    assert!(t.hub.is_local("s1"));
    assert!(!t.hub.is_local("other"));
}

#[test]
fn refuses_subscribe_before_view_key() {
    let t = setup();
    assert_eq!(t.subscribe("s1", VIEW), Err(Refusal::NotViewer));
    assert!(t.to_runner().is_empty());
}

#[test]
fn opens_only_with_granted_view_key() {
    let t = setup();
    t.hub.grant_view("s1", VIEW);
    assert_eq!(t.subscribe("s1", VIEW2), Err(Refusal::NotViewer));
    t.hub.grant_view("s1", "short");
    assert_eq!(t.subscribe("s1", "short"), Err(Refusal::NotViewer));
    assert_eq!(t.subscribe("other", VIEW), Err(Refusal::NoSuchSession));
    assert_eq!(t.subscribe("s1", VIEW), Ok(()));
}

#[test]
fn revoking_view_key_ends_its_subscriptions() {
    let t = setup();
    t.hub.grant_view("s1", VIEW);
    t.subscribe("s1", VIEW).unwrap();
    t.frame("r1", json!({"type":"replay","sessionId":"s1","data":""}));
    t.hub.revoke_view("s1", VIEW);
    assert!(t.events().contains(&(
        "terminalEnded".into(),
        json!({"sessionId":"s1","reason":"revoked"})
    )));
    t.frame(
        "r1",
        json!({"type":"output","sessionId":"s1","data":"YQ=="}),
    );
    assert_eq!(
        t.events()
            .iter()
            .filter(|(e, _)| e == "terminalOutput")
            .count(),
        1
    );
    assert_eq!(t.subscribe("s1", VIEW), Err(Refusal::NotViewer));
}

#[test]
fn replay_then_buffered_live_in_order() {
    let t = setup();
    t.hub.grant_view("s1", VIEW);
    assert_eq!(t.subscribe("s1", VIEW), Ok(()));
    assert_eq!(
        t.to_runner(),
        vec![(
            "r1".to_string(),
            json!({"type":"replay.request","sessionId":"s1"})
        )]
    );
    t.frame(
        "r1",
        json!({"type":"output","sessionId":"s1","data":"TElWRQ=="}),
    );
    assert!(t.events().is_empty());
    t.frame(
        "r1",
        json!({"type":"replay","sessionId":"s1","data":"UkVQTEFZ"}),
    );
    t.frame(
        "r1",
        json!({"type":"output","sessionId":"s1","data":"TkVYVA=="}),
    );
    assert_eq!(
        datas(&t.events()),
        vec![json!("UkVQTEFZ"), json!("TElWRQ=="), json!("TkVYVA==")]
    );
    assert_eq!(t.events()[0].1["replay"], json!(true));
}

#[test]
fn gives_up_waiting_for_replay_after_cap() {
    let t = setup();
    t.hub.grant_view("s1", VIEW);
    t.subscribe("s1", VIEW).unwrap();
    for _ in 0..=MAX_AWAITING_CHUNKS {
        t.frame(
            "r1",
            json!({"type":"output","sessionId":"s1","data":"YQ=="}),
        );
    }
    assert_eq!(t.events().len(), MAX_AWAITING_CHUNKS + 1);
    t.frame(
        "r1",
        json!({"type":"output","sessionId":"s1","data":"Yg=="}),
    );
    assert_eq!(t.events().len(), MAX_AWAITING_CHUNKS + 2);
}

#[test]
fn dropped_subscriber_gets_nothing_more() {
    let t = setup();
    t.hub.grant_view("s1", VIEW);
    t.subscribe("s1", VIEW).unwrap();
    t.frame("r1", json!({"type":"replay","sessionId":"s1","data":""}));
    t.hub.drop_subscriber(t.sub.id);
    t.frame(
        "r1",
        json!({"type":"output","sessionId":"s1","data":"YQ=="}),
    );
    assert_eq!(t.events().len(), 1);
}

#[test]
fn unsubscribe_stops_output() {
    let t = setup();
    t.hub.grant_view("s1", VIEW);
    t.subscribe("s1", VIEW).unwrap();
    t.hub.unsubscribe(t.sub.as_ref(), "s1");
    t.frame(
        "r1",
        json!({"type":"replay","sessionId":"s1","data":"eA=="}),
    );
    t.frame(
        "r1",
        json!({"type":"output","sessionId":"s1","data":"YQ=="}),
    );
    assert!(t.events().is_empty());
}

// ── 쓰기(F1) ──

#[test]
fn refuses_input_and_resize_before_writer_key() {
    let t = setup();
    assert_eq!(t.hub.input("s1", W1, "YQ=="), Err(Refusal::NotWriter));
    assert_eq!(
        t.hub.resize("s1", W1, &json!(80), &json!(24)),
        Err(Refusal::NotWriter)
    );
    assert!(t.to_runner().is_empty());
}

#[test]
fn short_writer_key_is_not_permission() {
    let t = setup();
    t.hub.grant_writer("s1", Some("7"), None);
    assert_eq!(t.hub.input("s1", "7", "YQ=="), Err(Refusal::NotWriter));
}

#[test]
fn only_current_writer_key() {
    let t = setup();
    t.hub.grant_writer("s1", Some(W1), None);
    assert_eq!(t.hub.input("s1", W1, "YQ=="), Ok(()));
    t.hub.grant_writer("s1", Some(W2), None);
    assert_eq!(t.hub.input("s1", W1, "Yg=="), Err(Refusal::NotWriter));
    t.hub.grant_writer("s1", None, None);
    assert_eq!(t.hub.input("s1", W2, "Yw=="), Err(Refusal::NotWriter));
    assert_eq!(
        t.to_runner(),
        vec![(
            "r1".to_string(),
            json!({"type":"input","sessionId":"s1","data":"YQ=="})
        )]
    );
}

#[test]
fn view_key_is_not_write_permission() {
    let t = setup();
    t.hub.grant_view("s1", VIEW);
    assert_eq!(t.hub.input("s1", VIEW, "YQ=="), Err(Refusal::NotWriter));
}

#[test]
fn counts_bytes_only_and_keeps_them_after_session_end() {
    let t = setup();
    t.hub.grant_writer("s1", Some(W1), None);
    t.hub.input("s1", W1, "YWJj").unwrap(); // 3바이트
    t.hub.input("s1", W1, "YQ==").unwrap(); // 1바이트
    t.frame("r1", json!({"type":"session.ended","sessionId":"s1"}));
    assert_eq!(t.hub.take_input_bytes("s1"), 4);
    assert_eq!(t.hub.take_input_bytes("s1"), 0);
}

#[test]
fn resize_range_matches_server_hub() {
    let t = setup();
    t.hub.grant_writer("s1", Some(W1), None);
    assert_eq!(
        t.hub.resize("s1", W1, &json!(0), &json!(24)),
        Err(Refusal::BadSize)
    );
    assert_eq!(
        t.hub.resize("s1", W1, &json!(80), &json!(1001)),
        Err(Refusal::BadSize)
    );
    assert_eq!(
        t.hub.resize("s1", W1, &json!(80.5), &json!(24)),
        Err(Refusal::BadSize)
    );
    assert_eq!(t.hub.resize("s1", W1, &json!(120), &json!(40)), Ok(()));
    assert_eq!(
        t.to_runner().last().unwrap().1,
        json!({"type":"resize","sessionId":"s1","cols":120,"rows":40})
    );
}

#[test]
fn session_end_or_runner_death_notifies_and_forgets_keys() {
    let t = setup();
    t.hub.grant_view("s1", VIEW);
    t.subscribe("s1", VIEW).unwrap();
    t.hub.grant_writer("s1", Some(W1), None);
    t.hub.forget_runner("r1");
    assert!(
        t.events()
            .contains(&("terminalEnded".into(), json!({"sessionId":"s1"})))
    );
    t.frame(
        "r1",
        json!({"type":"session.started","session":{"sessionId":"s1"}}),
    );
    assert_eq!(t.hub.input("s1", W1, "YQ=="), Err(Refusal::NotWriter));
    assert_eq!(t.subscribe("s1", VIEW), Err(Refusal::NotViewer));
}

#[test]
fn announce_drops_sessions_no_longer_listed() {
    let t = setup();
    t.hub.grant_view("s1", VIEW);
    t.subscribe("s1", VIEW).unwrap();
    t.frame(
        "r1",
        json!({"type":"announce","sessions":[{"sessionId":"s2"}]}),
    );
    assert!(!t.hub.is_local("s1"));
    assert!(t.hub.is_local("s2"));
    assert!(
        t.events()
            .contains(&("terminalEnded".into(), json!({"sessionId":"s1"})))
    );
}

#[test]
fn runner_gone_refuses_subscribe_and_input() {
    let t = setup();
    t.hub.grant_view("s1", VIEW);
    t.hub.grant_writer("s1", Some(W1), None);
    t.rec.unlinked.store(true, Ordering::SeqCst);
    assert_eq!(t.subscribe("s1", VIEW), Err(Refusal::RunnerGone));
    assert_eq!(t.hub.input("s1", W1, "YQ=="), Err(Refusal::RunnerGone));
    assert_eq!(t.hub.take_input_bytes("s1"), 0);
    // 실패한 구독은 자리를 남기지 않는다 — 링크가 돌아온 뒤 출력이 새지 않는다.
    t.rec.unlinked.store(false, Ordering::SeqCst);
    t.frame(
        "r1",
        json!({"type":"output","sessionId":"s1","data":"YQ=="}),
    );
    assert!(t.events().is_empty());
}

// ── 러너끼리(n3) ──

#[test]
fn other_runner_cannot_claim_session() {
    let t = setup();
    t.frame(
        "r2",
        json!({"type":"session.started","session":{"sessionId":"s1"}}),
    );
    assert!(
        t.rec
            .logs
            .lock()
            .unwrap()
            .iter()
            .any(|l| l.contains("무시"))
    );
    t.hub.grant_view("s1", VIEW);
    t.hub.grant_writer("s1", Some(W1), None);
    t.subscribe("s1", VIEW).unwrap();
    t.hub.input("s1", W1, "YQ==").unwrap();
    assert!(t.to_runner().iter().all(|(r, _)| r == "r1"));
    t.frame("r1", json!({"type":"replay","sessionId":"s1","data":""}));
    t.frame(
        "r2",
        json!({"type":"output","sessionId":"s1","data":"ZXZpbA=="}),
    );
    t.frame("r2", json!({"type":"session.ended","sessionId":"s1"}));
    assert_eq!(datas(&t.events()), vec![json!("")]);
    assert!(t.hub.is_local("s1"));
    assert_eq!(t.hub.owner_of("s1").as_deref(), Some("r1"));
}

// ── 감사 보고(gen) ──

#[test]
fn reports_bytes_per_gen_after_window() {
    let t = setup();
    t.hub.grant_writer("s1", Some(W1), Some(7));
    t.hub.input("s1", W1, "YWJj").unwrap();
    t.hub.input("s1", W1, "YQ==").unwrap();
    assert!(
        t.rec.reports.lock().unwrap().is_empty(),
        "창 안에서는 모은다"
    );
    assert_eq!(t.rec.scheduled.lock().unwrap().len(), 1, "창은 하나만 건다");
    t.run_scheduled();
    assert_eq!(
        *t.rec.reports.lock().unwrap(),
        vec![("r1".into(), "s1".into(), 7, 4)]
    );
}

#[test]
fn flushes_old_gen_before_new_writer_key() {
    let t = setup();
    t.hub.grant_writer("s1", Some(W1), Some(1));
    t.hub.input("s1", W1, "YWJj").unwrap();
    t.hub.grant_writer("s1", Some(W2), Some(2));
    t.hub.input("s1", W2, "YQ==").unwrap();
    t.frame("r1", json!({"type":"session.ended","sessionId":"s1"}));
    t.run_scheduled(); // 이미 털린 뒤라 아무것도 더 안 나간다
    assert_eq!(
        *t.rec.reports.lock().unwrap(),
        vec![
            ("r1".into(), "s1".into(), 1, 3),
            ("r1".into(), "s1".into(), 2, 1)
        ]
    );
}

#[test]
fn no_report_without_gen() {
    let t = setup();
    t.hub.grant_writer("s1", Some(W1), None);
    t.hub.input("s1", W1, "YWJj").unwrap();
    t.run_scheduled();
    assert!(t.rec.reports.lock().unwrap().is_empty());
    assert!(t.rec.scheduled.lock().unwrap().is_empty());
}

#[test]
fn key_compare_and_byte_length() {
    assert!(key_equals(W1, W1));
    assert!(!key_equals(W1, W2));
    assert!(!key_equals(W1, "a"));
    assert_eq!(base64_byte_length(""), 0);
    assert_eq!(base64_byte_length("YQ=="), 1);
    assert_eq!(base64_byte_length("YWI="), 2);
    assert_eq!(base64_byte_length("YWJj"), 3);
}
