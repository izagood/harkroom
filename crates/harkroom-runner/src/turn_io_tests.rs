//! 턴 수명·관문 실구현 시험 — 진짜 레지스트리·릴레이 세션·원장에 붙여 정리 순서와 관문 알림을 본다.

use super::*;
use crate::pty::AttentionKind;
use crate::relay_session::{OpenSessionInput, RelaySessions};
use crate::turn_gate::{CallHumanCtx, GateState, call_human};
use crate::turn_life::{TurnLife, register_turn, settle_turn, watch_fence};
use crate::turn_registry::TurnKind;
use serde_json::Value;
use std::sync::mpsc;
use std::time::Instant;

#[derive(Default, Clone)]
struct FakePoster {
    fails: Arc<Mutex<Vec<(String, FailOpts)>>>,
    unreacts: Arc<Mutex<usize>>,
}

impl TurnPoster for FakePoster {
    fn fail(&mut self, body: &str, opts: &FailOpts) -> Result<(), String> {
        self.fails
            .lock()
            .unwrap()
            .push((body.to_owned(), opts.clone()));
        Ok(())
    }
    fn remove_working_reaction(&mut self) -> Result<(), String> {
        *self.unreacts.lock().unwrap() += 1;
        Ok(())
    }
}

type Sent = Arc<Mutex<Vec<Value>>>;

fn relay() -> (Arc<RelaySessions>, Sent) {
    let sent: Sent = Arc::new(Mutex::new(Vec::new()));
    let l = RelaySessions::new(None, Box::new(|_| {}));
    let s = sent.clone();
    l.set_sink(Arc::new(move |f: &Value| s.lock().unwrap().push(f.clone())));
    (l, sent)
}

struct Built {
    io: TurnIo<FakePoster>,
    registry: Arc<Mutex<TurnRegistry>>,
    ledger: Arc<Mutex<AttentionLedger>>,
    terms: Arc<Mutex<usize>>,
    sent: Sent,
    poster: FakePoster,
    provider_done: Arc<Mutex<usize>>,
}

fn build() -> Built {
    let (relay, sent) = relay();
    let session = relay.open_session(OpenSessionInput {
        agent_account_id: "a1".into(),
        channel_id: "c1".into(),
        thread_root_id: Some("t1".into()),
        harness: "claude".into(),
        accepts_input: true,
        ..Default::default()
    });
    let registry = Arc::new(Mutex::new(TurnRegistry::new()));
    let ledger = Arc::new(Mutex::new(AttentionLedger::default()));
    let terms = Arc::new(Mutex::new(0usize));
    let provider_done = Arc::new(Mutex::new(0usize));
    let poster = FakePoster::default();
    let t = terms.clone();
    let p = provider_done.clone();
    let io = TurnIo {
        thread_key: "c1:t1".into(),
        registry: registry.clone(),
        record: TurnRecord {
            kind: TurnKind::Mention,
            session_id: Some(session.session_id().to_owned()),
            opened_by_handle: None,
        },
        session: Some(session),
        ledger: Some(ledger.clone()),
        poster: poster.clone(),
        terminate: Box::new(move || *t.lock().unwrap() += 1),
        mark_gate: None,
        arm_gate: Some(Box::new(|| Timer::after(Duration::from_secs(3600), || {}))),
        provider_done: Some(Box::new(move || *p.lock().unwrap() += 1)),
        probe: Some(Timer::every(Duration::from_secs(3600), || true)),
        reclaim_timer: None,
        silence: None,
        gate_watch: None,
        fence_listening: Arc::new(AtomicBool::new(false)),
        log_prefix: "[t] ".into(),
        log: Box::new(|_| {}),
    };
    Built {
        io,
        registry,
        ledger,
        terms,
        sent,
        poster,
        provider_done,
    }
}

fn live() -> EndState {
    EndState {
        has_controls: true,
        ..EndState::default()
    }
}

#[test]
fn timer_after_fires_once_and_cancel_stops_it() {
    let (tx, rx) = mpsc::channel();
    let _t = Timer::after(Duration::from_millis(20), move || tx.send(()).unwrap());
    assert!(rx.recv_timeout(Duration::from_secs(2)).is_ok());
    let (tx2, rx2) = mpsc::channel::<()>();
    let t2 = Timer::after(Duration::from_millis(200), move || tx2.send(()).unwrap());
    t2.cancel();
    assert!(rx2.recv_timeout(Duration::from_millis(400)).is_err());
}

#[test]
fn timer_every_repeats_until_cancel_or_false() {
    let n = Arc::new(Mutex::new(0u32));
    let c = n.clone();
    let t = Timer::every(Duration::from_millis(10), move || {
        *c.lock().unwrap() += 1;
        true
    });
    let start = Instant::now();
    while *n.lock().unwrap() < 3 && start.elapsed() < Duration::from_secs(2) {
        std::thread::yield_now();
    }
    t.cancel();
    let after = *n.lock().unwrap();
    assert!(after >= 3);
    std::thread::sleep(Duration::from_millis(60));
    assert!(*n.lock().unwrap() <= after + 1, "끈 뒤에는 더 돌지 않는다");
    // false 를 내면 스스로 멈춘다.
    let m = Arc::new(Mutex::new(0u32));
    let d = m.clone();
    let _t2 = Timer::every(Duration::from_millis(5), move || {
        *d.lock().unwrap() += 1;
        false
    });
    std::thread::sleep(Duration::from_millis(60));
    assert_eq!(*m.lock().unwrap(), 1);
}

#[test]
fn attention_ranks_map_three_ways() {
    let r = |pool, account| GateRanks { pool, account };
    assert_eq!(
        attention_ranks(r(Some(2), GateAccountRank::Rank(1))),
        (Some(2), Some(Some(1)))
    );
    assert_eq!(
        attention_ranks(r(None, GateAccountRank::DefaultLogin)),
        (None, Some(None))
    );
    assert_eq!(
        attention_ranks(r(None, GateAccountRank::Unknown)),
        (None, None)
    );
}

#[test]
fn register_then_settle_releases_only_own_and_cleans_in_order() {
    let mut b = build();
    let mut life = TurnLife::default();
    let mut end = live();
    let mut gate = GateState::default();
    register_turn(&mut life, &mut end, &mut gate, &mut b.io).unwrap();
    assert!(b.registry.lock().unwrap().get("c1:t1").is_some());
    watch_fence(&mut life, false, &mut b.io);
    assert!(b.io.fence_listening.load(Ordering::SeqCst));

    settle_turn(&mut life, &mut end, &mut gate, &mut b.io);
    assert!(
        b.registry.lock().unwrap().get("c1:t1").is_none(),
        "내 등록은 푼다"
    );
    assert!(!b.io.fence_listening.load(Ordering::SeqCst));
    assert!(b.io.probe.is_none(), "탐침 타이머를 껐다");
    assert!(b.io.session.is_none(), "세션을 닫았다");
    assert_eq!(*b.provider_done.lock().unwrap(), 1);
    assert_eq!(*b.poster.unreacts.lock().unwrap(), 1);
    let types: Vec<String> = b
        .sent
        .lock()
        .unwrap()
        .iter()
        .filter_map(|f| f["type"].as_str().map(str::to_owned))
        .collect();
    assert!(types.contains(&"session.ended".to_string()), "{types:?}");
    // 두 번째 settle 은 아무것도 하지 않는다.
    settle_turn(&mut life, &mut end, &mut gate, &mut b.io);
    assert_eq!(*b.poster.unreacts.lock().unwrap(), 1);
}

#[test]
fn rejected_register_does_not_release_the_other_turn() {
    let mut b = build();
    b.registry
        .lock()
        .unwrap()
        .register(
            "c1:t1",
            TurnRecord {
                kind: TurnKind::Interactive,
                session_id: None,
                opened_by_handle: Some("someone".into()),
            },
        )
        .unwrap();
    let mut life = TurnLife::default();
    let mut end = live();
    let mut gate = GateState::default();
    assert!(register_turn(&mut life, &mut end, &mut gate, &mut b.io).is_err());
    let reg = b.registry.lock().unwrap();
    assert_eq!(
        reg.get("c1:t1").map(|r| r.kind),
        Some(TurnKind::Interactive),
        "남의 자리는 그대로"
    );
}

#[test]
fn call_human_sends_ranks_not_label_and_holds_ledger_until_settle() {
    let mut b = build();
    let mut end = live();
    let mut gate = GateState::default();
    let ctx = CallHumanCtx {
        account_label: "pool-a-acct1".into(),
        ranks: GateRanks {
            pool: Some(2),
            account: GateAccountRank::Rank(1),
        },
        mention_id: "m1".into(),
        session_key: "s1".into(),
    };
    call_human(
        &mut end,
        &mut gate,
        &ctx,
        "관문 화면",
        AttentionKind::Startup,
        &mut b.io,
    );
    let frames = b.sent.lock().unwrap().clone();
    let att = frames
        .iter()
        .find(|f| f["type"] == "attention.required")
        .expect("관문 알림");
    assert_eq!(
        (
            att["claudePoolRank"].as_u64(),
            att["claudeAccountRank"].as_u64()
        ),
        (Some(2), Some(1))
    );
    assert!(
        !att.to_string().contains("pool-a-acct1"),
        "계정 이름은 서버로 가지 않는다"
    );
    // 관문 실패 글도 순번만.
    let fails = b.poster.fails.lock().unwrap().clone();
    assert_eq!(fails.len(), 1);
    assert_eq!(fails[0].1.code.as_deref(), Some("account_gate"));
    assert!(!fails[0].0.contains("pool-a-acct1"));
    assert_eq!(b.ledger.lock().unwrap().holder("pool-a-acct1"), Some("s1"));
    assert!(b.io.gate_watch.is_some(), "감시를 걸었다");

    let mut life = TurnLife::default();
    settle_turn(&mut life, &mut end, &mut gate, &mut b.io);
    assert_eq!(
        b.ledger.lock().unwrap().holder("pool-a-acct1"),
        None,
        "원장을 놓았다"
    );
    assert!(b.io.gate_watch.is_none());
}

#[test]
fn reclaim_terminates_only_live_pty() {
    let mut b = build();
    let mut end = live();
    LifeIo::reclaim(&mut b.io, &mut end);
    assert_eq!(*b.terms.lock().unwrap(), 1);
    let mut gone = EndState {
        exited: true,
        has_controls: true,
        ..EndState::default()
    };
    LifeIo::reclaim(&mut b.io, &mut gone);
    assert_eq!(*b.terms.lock().unwrap(), 1, "끝난 PTY 는 죽이지 않는다");
}

#[test]
fn gate_fail_opts_carry_ranks_only() {
    let fail = crate::turn_notice::gate_fail(
        GateRanks {
            pool: Some(1),
            account: GateAccountRank::Rank(3),
        },
        true,
        "m9",
    );
    let o = gate_fail_opts(&fail);
    assert_eq!(
        (o.claude_pool_rank, o.claude_account_rank),
        (Some(1), Some(3))
    );
    assert_eq!(o.mention_id.as_deref(), Some("m9"));
    assert!(!o.retryable || o.retryable == fail.retryable);
}
