//! 정본 `test/stop.test.ts`·`test/idleStop.test.ts`·`test/stoppableSleep.test.ts`·main 루프 계약의 대조.

use super::*;
use serde_json::json;
use std::cell::{Cell, RefCell};
use std::sync::Arc;
use std::time::Instant;

const START: i64 = 1_762_900_000_000; // 2025-11-11T22:26:40Z

fn iso(ms: i64) -> String {
    // 테스트용: START 근처만 쓴다 — 초 단위 차이만 만든다.
    let secs = (ms - START) / 1000;
    format!(
        "2025-11-11T22:{:02}:{:02}.000Z",
        26 + (40 + secs) / 60,
        (40 + secs) % 60
    )
}

#[test]
fn iso_helper_round_trips() {
    assert_eq!(crate::omp_home::parse_iso_utc_ms(&iso(START)), Some(START));
    assert_eq!(
        crate::omp_home::parse_iso_utc_ms(&iso(START + 5_000)),
        Some(START + 5_000)
    );
}

#[test]
fn stop_request_only_after_my_start() {
    assert!(!stop_requested_for_runner(None, START));
    assert!(!stop_requested_for_runner(Some(""), START));
    assert!(!stop_requested_for_runner(Some("어제"), START));
    assert!(!stop_requested_for_runner(Some(&iso(START)), START));
    assert!(!stop_requested_for_runner(Some(&iso(START - 1_000)), START));
    assert!(stop_requested_for_runner(Some(&iso(START + 1_000)), START));
    // `±HH:MM` 꼴도 읽는다(#1965 security 낮음) — 같은 순간이면 같은 ms.
    assert_eq!(
        parse_iso_offset_ms("2030-01-01T09:00:00.250+09:00"),
        parse_iso_offset_ms("2030-01-01T00:00:00.250Z")
    );
    assert_eq!(
        parse_iso_offset_ms("2029-12-31T19:30:00-04:30"),
        parse_iso_offset_ms("2030-01-01T00:00:00Z")
    );
    assert!(stop_requested_for_runner(
        Some("2099-01-01T00:00:00+09:00"),
        START
    ));
    for bad in [
        "2030-01-01T00:00:00+0900",
        "2030-01-01T00:00:00+24:00",
        "2030-01-01T00:00:00*09:00",
        "2030-01-01T00:00:00",
    ] {
        assert_eq!(parse_iso_offset_ms(bad), None, "{bad}");
    }
}

#[test]
fn idle_stop_uses_batch_key_even_when_null() {
    let read = Cell::new(0);
    let def = || {
        read.set(read.get() + 1);
        Ok(json!({"stopRequestedAt": "2030-01-01T00:00:00.000Z"}))
    };
    assert_eq!(
        idle_stop_requested_at(&json!({"entries": [], "stopRequestedAt": null}), def).unwrap(),
        None
    );
    assert_eq!(read.get(), 0, "키가 있으면 정의를 읽지 않는다");
    assert_eq!(
        idle_stop_requested_at(&json!({"stopRequestedAt": "x"}), || unreachable!()).unwrap(),
        Some("x".into())
    );
    // 키가 없으면(옛 서버) 정의를 읽는다.
    let got = idle_stop_requested_at(&json!({"entries": []}), || {
        Ok(json!({"stopRequestedAt": "2030-01-01T00:00:00.000Z"}))
    })
    .unwrap();
    assert_eq!(got.as_deref(), Some("2030-01-01T00:00:00.000Z"));
    assert_eq!(
        idle_stop_requested_at(&json!({}), || Ok(json!({}))).unwrap(),
        None
    );
    let e = idle_stop_requested_at(&json!({}), || {
        Err(HarkroomError::new("boom".into(), Some(500)))
    })
    .unwrap_err();
    assert_eq!(e.status, Some(500));
}

#[test]
fn entry_id_lists_keep_only_positive_integers() {
    let got = parse_entry_ids(Some(" 3, 0,-1,x,7 ,,3.5,9"));
    let mut v: Vec<i64> = got.into_iter().collect();
    v.sort();
    assert_eq!(v, vec![3, 7, 9]);
    assert!(parse_entry_ids(None).is_empty());
}

#[test]
fn handover_hold_releases_by_operator_or_backstop() {
    let h = HandoverHold::new([1, 2].into_iter().collect(), START);
    assert_eq!(h.held_entry_ids(START + 1).len(), 2);
    h.release();
    assert!(h.held_entry_ids(START + 2).is_empty());
    let h2 = HandoverHold::new([5].into_iter().collect(), START);
    assert_eq!(h2.held_entry_ids(START + HANDOVER_HOLD_MS).len(), 1);
    assert!(h2.held_entry_ids(START + HANDOVER_HOLD_MS + 1).is_empty());
}

#[test]
fn stoppable_sleep_wakes_only_the_current_sleeper() {
    let s = Arc::new(StoppableSleep::new());
    assert!(s.sleep(10), "깨우지 않으면 끝까지 잔다");
    let s2 = s.clone();
    let t = std::thread::spawn(move || {
        let t0 = Instant::now();
        let full = s2.sleep(10_000);
        (full, t0.elapsed())
    });
    std::thread::sleep(Duration::from_millis(50));
    s.wake();
    let (full, took) = t.join().unwrap();
    assert!(!full);
    assert!(took < Duration::from_secs(2), "{took:?}");
    // 깨운 뒤의 sleep 은 다시 끝까지 잔다.
    assert!(s.sleep(5));
}

#[test]
fn self_rename_follows_accounts() {
    let mut me = Me {
        id: "a1".into(),
        handle: "old".into(),
    };
    assert_eq!(
        apply_self_rename(&mut me, &[json!({"id":"zz","handle":"x"})]),
        None
    );
    assert_eq!(
        apply_self_rename(&mut me, &[json!({"id":"a1","handle":"old"})]),
        None
    );
    assert_eq!(
        apply_self_rename(&mut me, &[json!({"id":"a1","handle":"new"})]),
        Some("old".into())
    );
    assert_eq!(me.handle, "new");
}

#[test]
fn batch_context_maps_channels_and_kinds() {
    let ctx = BatchContext::new(
        &[("c1".into(), "task".into())],
        &[
            json!({"id":"h","handle":"jb","kind":"human"}),
            json!({"id":"g","handle":"bot","kind":"agent"}),
            json!({"id":"x","handle":"sys"}),
            json!({"handle":"no-id","kind":"agent"}),
        ],
    );
    assert_eq!(ctx.channel_name("c1"), "task");
    assert_eq!(ctx.channel_name("dm-1"), "dm");
    assert_eq!(ctx.handles.len(), 3);
    assert!(ctx.human_ids.contains("h") && ctx.agent_ids.contains("g"));
    assert!(!ctx.agent_ids.contains("x") && !ctx.human_ids.contains("x"));
}

// ---- 루프 ----

type Polled = Result<Value, HarkroomError>;

struct FakeSource {
    polls: RefCell<Vec<Polled>>,
    holdings_seen: RefCell<Vec<Vec<i64>>>,
    defs: Cell<usize>,
    resets: Cell<usize>,
    on_empty: Box<dyn Fn()>,
}

impl FakeSource {
    fn new(polls: Vec<Polled>) -> Self {
        Self {
            polls: RefCell::new(polls.into_iter().rev().collect()),
            holdings_seen: RefCell::new(vec![]),
            defs: Cell::new(0),
            resets: Cell::new(0),
            on_empty: Box::new(|| {}),
        }
    }
}

impl PollSource for FakeSource {
    fn poll(&self, holding: &[i64]) -> Result<Value, HarkroomError> {
        self.holdings_seen.borrow_mut().push(holding.to_vec());
        match self.polls.borrow_mut().pop() {
            Some(p) => p,
            None => {
                (self.on_empty)();
                Ok(json!({"entries": [], "messages": [], "stopRequestedAt": null}))
            }
        }
    }
    fn definition(&self) -> Result<Value, HarkroomError> {
        self.defs.set(self.defs.get() + 1);
        Ok(json!({}))
    }
    fn channels(&self) -> Result<Vec<(String, String)>, HarkroomError> {
        Ok(vec![("c1".into(), "task".into())])
    }
    fn accounts(&self) -> Result<Vec<Value>, HarkroomError> {
        Ok(vec![
            json!({"id":"me","handle":"renamed","kind":"agent"}),
            json!({"id":"h","handle":"jb","kind":"human"}),
        ])
    }
    fn reset(&self) {
        self.resets.set(self.resets.get() + 1);
    }
}

#[derive(Default)]
struct FakeScheduler {
    admitted: RefCell<Vec<(Value, BatchContext)>>,
    outcome: Cell<AdmitOutcome>,
    events: RefCell<Vec<String>>,
}

impl Scheduler for FakeScheduler {
    fn admit(&self, batch: &Value, ctx: &BatchContext) -> AdmitOutcome {
        self.admitted
            .borrow_mut()
            .push((batch.clone(), ctx.clone()));
        self.outcome.get()
    }
    fn holding_entries(&self) -> Vec<i64> {
        vec![41]
    }
    fn done_entries(&self) -> Vec<i64> {
        vec![40]
    }
    fn drain(&self) {
        self.events.borrow_mut().push("drain".into());
    }
}

fn entry_batch() -> Value {
    json!({"entries": [{"id": 41}], "messages": [], "memoryRev": "r9"})
}

#[test]
fn loop_admits_batches_retries_errors_and_retreats_in_order() {
    let lp = PollLoop::new(
        Me {
            id: "me".into(),
            handle: "old".into(),
        },
        START,
    );
    let src = FakeSource::new(vec![
        Ok(json!({"entries": [], "messages": [], "stopRequestedAt": null})),
        Ok(entry_batch()),
        Err(HarkroomError::new("transport".into(), None)),
        Ok(json!({"entries": [], "messages": [], "stopRequestedAt": iso(START + 2_000)})),
    ]);
    let sched = FakeScheduler::default();
    let revs = RefCell::new(vec![]);
    let unrecoverable = Cell::new(0);
    let note = |r: Option<&str>| revs.borrow_mut().push(r.map(str::to_string));
    let exit = |_: &HarkroomError| unrecoverable.set(unrecoverable.get() + 1);
    let stopped = |h: &[i64], d: &[i64]| {
        sched
            .events
            .borrow_mut()
            .push(format!("pollStopped {h:?} {d:?}"))
    };
    let hooks = LoopHooks {
        note_memory_rev: &note,
        exit_if_unrecoverable: &exit,
        notify_poll_stopped: &stopped,
    };
    let t0 = Instant::now();
    lp.run(&src, &sched, &hooks);
    // transport 오류 한 번 → 1초 백오프.
    assert!(t0.elapsed() >= Duration::from_millis(900));
    assert!(!lp.running());
    assert_eq!(src.polls.borrow().len(), 0, "종료 요청이 든 폴에서 멈춘다");
    assert_eq!(src.resets.get(), 1);
    assert_eq!(unrecoverable.get(), 1, "오류는 먼저 물러남 판정을 지난다");
    assert_eq!(src.defs.get(), 0, "빈 폴에 키가 있으면 정의를 안 읽는다");
    assert_eq!(src.holdings_seen.borrow()[0], vec![41]);
    let admitted = sched.admitted.borrow();
    assert_eq!(admitted.len(), 1);
    assert_eq!(admitted[0].1.channel_name("c1"), "task");
    assert_eq!(
        admitted[0].1.handles.get("h").map(String::as_str),
        Some("jb")
    );
    assert_eq!(lp.me().handle, "renamed");
    assert_eq!(revs.borrow()[1].as_deref(), Some("r9"));
    assert_eq!(
        *sched.events.borrow(),
        vec!["pollStopped [41] [40]".to_string(), "drain".to_string()],
        "알림이 drain 보다 먼저"
    );
}

#[test]
fn stop_during_idle_admit_sleep_wakes_the_loop() {
    let lp = Arc::new(PollLoop::new(
        Me {
            id: "me".into(),
            handle: "me".into(),
        },
        START,
    ));
    let lp2 = lp.clone();
    let worker = std::thread::spawn(move || {
        let src = FakeSource::new(vec![Ok(entry_batch())]);
        let sched = FakeScheduler::default();
        sched.outcome.set(AdmitOutcome {
            started: 0,
            deferred: 1,
            blocked: 0,
        });
        let note = |_: Option<&str>| {};
        let exit = |_: &HarkroomError| {};
        let stopped = |_: &[i64], _: &[i64]| {};
        let hooks = LoopHooks {
            note_memory_rev: &note,
            exit_if_unrecoverable: &exit,
            notify_poll_stopped: &stopped,
        };
        let t0 = Instant::now();
        lp2.run(&src, &sched, &hooks);
        (t0.elapsed(), sched.admitted.borrow().len())
    });
    std::thread::sleep(Duration::from_millis(200));
    lp.stop();
    let (took, admitted) = worker.join().unwrap();
    assert_eq!(admitted, 1);
    assert!(
        took < Duration::from_secs(3),
        "5초 쉼이 깨져야 한다: {took:?}"
    );
}

#[test]
fn old_server_empty_poll_reads_definition_for_stop() {
    let lp = PollLoop::new(
        Me {
            id: "me".into(),
            handle: "me".into(),
        },
        START,
    );
    struct OldServer {
        polls: Cell<usize>,
    }
    impl PollSource for OldServer {
        fn poll(&self, _: &[i64]) -> Result<Value, HarkroomError> {
            self.polls.set(self.polls.get() + 1);
            Ok(json!({"entries": [], "messages": []}))
        }
        fn definition(&self) -> Result<Value, HarkroomError> {
            Ok(
                json!({"stopRequestedAt": if self.polls.get() >= 2 { json!("2025-11-11T22:27:00.000Z") } else { Value::Null }}),
            )
        }
        fn channels(&self) -> Result<Vec<(String, String)>, HarkroomError> {
            unreachable!()
        }
        fn accounts(&self) -> Result<Vec<Value>, HarkroomError> {
            unreachable!()
        }
        fn reset(&self) {}
    }
    let src = OldServer {
        polls: Cell::new(0),
    };
    let sched = FakeScheduler::default();
    let note = |_: Option<&str>| {};
    let exit = |_: &HarkroomError| {};
    let stopped = |_: &[i64], _: &[i64]| {};
    lp.run(
        &src,
        &sched,
        &LoopHooks {
            note_memory_rev: &note,
            exit_if_unrecoverable: &exit,
            notify_poll_stopped: &stopped,
        },
    );
    assert_eq!(src.polls.get(), 2);
}
