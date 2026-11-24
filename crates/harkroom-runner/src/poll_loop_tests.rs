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
    fn admit(&self, batch: &Value, ctx: &BatchContext) -> Result<AdmitOutcome, HarkroomError> {
        self.admitted
            .borrow_mut()
            .push((batch.clone(), ctx.clone()));
        Ok(self.outcome.get())
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

#[test]
fn kick_cuts_the_current_rest_and_skips_one_pending_rest() {
    // 깨움 신호(E2b): 걸린 깨움은 다음 쉼 한 번을 건너뛰게 하고, 그다음 쉼은 다시 끝까지 잔다.
    let poll = PollLoop::new(
        Me {
            id: "me".into(),
            handle: "me".into(),
        },
        START,
    );
    poll.kick();
    let t = Instant::now();
    poll.rest(2_000);
    assert!(
        t.elapsed() < Duration::from_millis(500),
        "걸린 깨움이 쉼을 건너뛴다"
    );
    let t = Instant::now();
    poll.rest(60);
    assert!(
        t.elapsed() >= Duration::from_millis(50),
        "깨움이 없으면 평소대로 쉰다"
    );

    let poll = Arc::new(poll);
    let p = Arc::clone(&poll);
    let h = std::thread::spawn(move || {
        let t = Instant::now();
        p.rest(5_000);
        t.elapsed()
    });
    std::thread::sleep(Duration::from_millis(100));
    poll.kick();
    assert!(
        h.join().unwrap() < Duration::from_millis(2_000),
        "자는 중의 깨움이 쉼을 끊는다"
    );
    assert!(poll.running(), "깨움은 루프를 멈추지 않는다");
}

// ---- 채널·계정 목록 캐시 ----

/// 목록을 몇 번 읽었는지 세고, 시험이 목록을 바꿀 수 있는 서버.
struct ListSource {
    channels: RefCell<Vec<(String, String)>>,
    accounts: RefCell<Vec<Value>>,
    reads: Cell<(usize, usize)>,
    fail: Cell<bool>,
}

impl PollSource for ListSource {
    fn poll(&self, _: &[i64]) -> Result<Value, HarkroomError> {
        unreachable!("이 시험은 폴을 부르지 않는다")
    }
    fn definition(&self) -> Result<Value, HarkroomError> {
        Ok(json!({}))
    }
    fn channels(&self) -> Result<Vec<(String, String)>, HarkroomError> {
        if self.fail.get() {
            return Err(HarkroomError::new("transport".into(), None));
        }
        let (c, a) = self.reads.get();
        self.reads.set((c + 1, a));
        Ok(self.channels.borrow().clone())
    }
    fn accounts(&self) -> Result<Vec<Value>, HarkroomError> {
        let (c, a) = self.reads.get();
        self.reads.set((c, a + 1));
        Ok(self.accounts.borrow().clone())
    }
    fn reset(&self) {}
}

fn batch_of(channel: &str, author: &str) -> Value {
    json!({"entries": [{"id": 1, "messageId": "m"}],
           "messages": [{"id": "m", "channelId": channel, "authorId": author}]})
}

#[test]
fn directory_is_reread_only_for_unknown_ids_or_age() {
    let lp = PollLoop::new(
        Me {
            id: "me".into(),
            handle: "me".into(),
        },
        START,
    );
    let src = ListSource {
        channels: RefCell::new(vec![("c1".into(), "task".into())]),
        accounts: RefCell::new(vec![json!({"id":"h","handle":"jb","kind":"human"})]),
        reads: Cell::new((0, 0)),
        fail: Cell::new(false),
    };
    let names = |r: &Lists| BatchContext::new(&r.0, &r.1);

    // 처음에는 읽는다. 같은 채널·같은 글쓴이의 다음 배치는 읽지 않는다(멘션마다 왕복 두 번이 사라진다).
    lp.refresh_directory(&src, &batch_of("c1", "h"), 0).unwrap();
    assert_eq!(src.reads.get(), (1, 1));
    for now in [1_000, 60_000] {
        lp.refresh_directory(&src, &batch_of("c1", "h"), now)
            .unwrap();
    }
    assert_eq!(src.reads.get(), (1, 1), "아는 id 뿐이면 다시 읽지 않는다");

    // 새 채널이 생겼다 → 그 채널의 첫 배치에서 다시 읽고 이름이 보인다.
    src.channels
        .borrow_mut()
        .push(("c2".into(), "새채널".into()));
    let r = lp
        .refresh_directory(&src, &batch_of("c2", "h"), 61_000)
        .unwrap();
    assert_eq!(src.reads.get(), (2, 2));
    assert_eq!(names(&r).channel_name("c2"), "새채널");

    // 새 계정이 생겼다 → 그 계정이 쓴 첫 글에서 다시 읽고, 사람인지가 보인다(묶기·알림 판정이 이 표를 본다).
    src.accounts
        .borrow_mut()
        .push(json!({"id":"h2","handle":"new","kind":"human"}));
    let r = lp
        .refresh_directory(&src, &batch_of("c2", "h2"), 62_000)
        .unwrap();
    assert_eq!(src.reads.get(), (3, 3));
    let ctx = names(&r);
    assert!(ctx.human_ids.contains("h2"));
    assert_eq!(ctx.handles.get("h2").map(String::as_str), Some("new"));

    // 목록에 없는 채널(DM)은 한 번만 다시 읽는다 — 같은 DM 의 다음 글마다 읽지 않는다. 다른 모르는 id 로 다시 읽은
    // 뒤에도 「없음」은 넘겨받는다.
    lp.refresh_directory(&src, &batch_of("dm9", "h"), 63_000)
        .unwrap();
    assert_eq!(src.reads.get(), (4, 4));
    lp.refresh_directory(&src, &batch_of("dm9", "h"), 64_000)
        .unwrap();
    assert_eq!(
        src.reads.get(),
        (4, 4),
        "없다고 확인한 id 로 거듭 읽지 않는다"
    );
    lp.refresh_directory(&src, &batch_of("dm8", "h"), 65_000)
        .unwrap();
    lp.refresh_directory(&src, &batch_of("dm9", "h"), 66_000)
        .unwrap();
    assert_eq!(src.reads.get(), (5, 5));

    // 읽기가 실패하면 오류를 올리고 앞 목록은 남는다 — 아는 id 의 배치는 그대로 돈다.
    src.fail.set(true);
    assert!(
        lp.refresh_directory(&src, &batch_of("c3", "h"), 67_000)
            .is_err()
    );
    let r = lp
        .refresh_directory(&src, &batch_of("c2", "h2"), 68_000)
        .unwrap();
    assert_eq!(names(&r).channel_name("c2"), "새채널");
    src.fail.set(false);

    // 나이가 차면 모르는 id 가 없어도 다시 읽는다 — 이름 바뀜이 따라온다. 「없음」 표도 새로 시작한다.
    src.accounts.borrow_mut()[0] = json!({"id":"h","handle":"renamed","kind":"human"});
    let r = lp
        .refresh_directory(&src, &batch_of("c1", "h"), 65_000 + DIRECTORY_MAX_AGE_MS)
        .unwrap();
    assert_eq!(src.reads.get(), (6, 6));
    assert_eq!(
        names(&r).handles.get("h").map(String::as_str),
        Some("renamed")
    );
    lp.refresh_directory(&src, &batch_of("dm9", "h"), 66_000 + DIRECTORY_MAX_AGE_MS)
        .unwrap();
    assert_eq!(
        src.reads.get(),
        (7, 7),
        "나이로 읽은 뒤에는 없음 표가 비어 있다"
    );
}

#[test]
fn batch_ids_collects_channels_and_authors() {
    let ids = batch_ids(&json!({"messages": [
        {"id": "m1", "channelId": "c1", "authorId": "a"},
        {"id": "m2", "channelId": "c1", "authorId": ""},
        {"id": "m3"}
    ]}));
    assert_eq!(ids, HashSet::from(["c1".to_string(), "a".to_string()]));
    assert!(batch_ids(&json!({})).is_empty());
}
