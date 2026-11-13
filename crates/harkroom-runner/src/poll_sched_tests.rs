//! 폴 루프 스케줄러 쪽(L3b) — 잠금 밖 띄우기·받는 쪽 고리·물러나기.
use std::sync::mpsc;
use std::time::Duration;

use serde_json::json;

use super::*;

#[derive(Default)]
struct Sink {
    log: Mutex<Vec<String>>,
    panic_on_slot: bool,
}
impl Sink {
    fn push(&self, s: String) {
        self.log.lock().unwrap().push(s);
    }
    fn lines(&self) -> Vec<String> {
        self.log.lock().unwrap().clone()
    }
}
impl EventSink for Sink {
    fn release_turn_slot(&self, k: &str) {
        if self.panic_on_slot {
            panic!("sink");
        }
        self.push(format!("slot:{k}"));
    }
    fn notice_fenced(&self, c: &str, a: &str) {
        self.push(format!("fenced:{c}:{a}"));
    }
    fn turn_outcome(&self, ok: bool) {
        self.push(format!("outcome:{ok}"));
    }
    fn stop_requested(&self, at: &str) {
        self.push(format!("stop:{at}"));
    }
    fn executable_missing(&self) {
        self.push("missing".into());
    }
}

fn launch(id: i64) -> Launch {
    Launch {
        lead_entry: json!({"id": id}),
        lead_mention: json!({"id": format!("m{id}"), "channelId": "c"}),
        bundled: vec![],
        anchor: "a".into(),
        thread_key: "c/a".into(),
        tried: 1,
        claim: None,
        slot_held: false,
    }
}

#[test]
fn thread_key_splits_to_channel_and_anchor() {
    assert_eq!(split_thread_key("c/a"), Some(("c", "a")));
    assert_eq!(split_thread_key("c/_root"), None);
    assert_eq!(split_thread_key("c"), None);
    assert_eq!(split_thread_key("/a"), None);
}

#[test]
fn events_reach_the_sink_and_turn_end_counts_down() {
    let (sink, running) = (Sink::default(), Running::default());
    running.started();
    handle_event(SchedEvent::SlotReleased("c/a".into()), &sink, &running);
    handle_event(SchedEvent::Fenced("c/a".into()), &sink, &running);
    handle_event(SchedEvent::Fenced("broken".into()), &sink, &running);
    handle_event(SchedEvent::Outcome(false), &sink, &running);
    handle_event(SchedEvent::StopRequested("t".into()), &sink, &running);
    handle_event(SchedEvent::ExecutableMissing, &sink, &running);
    assert_eq!(running.count(), 1);
    handle_event(
        SchedEvent::TurnEnded {
            thread_key: "c/a".into(),
            mention_id: "m".into(),
        },
        &sink,
        &running,
    );
    assert_eq!(running.count(), 0);
    assert_eq!(
        sink.lines(),
        [
            "slot:c/a",
            "fenced:c:a",
            "outcome:false",
            "stop:t",
            "missing"
        ]
    );
}

#[test]
fn a_panicking_event_does_not_kill_the_pump() {
    let sink = Sink {
        panic_on_slot: true,
        ..Sink::default()
    };
    let running = Running::default();
    running.started();
    let (tx, rx) = mpsc::channel();
    tx.send(SchedEvent::SlotReleased("c/a".into())).unwrap();
    tx.send(SchedEvent::TurnEnded {
        thread_key: "c/a".into(),
        mention_id: "m".into(),
    })
    .unwrap();
    tx.send(SchedEvent::Outcome(true)).unwrap();
    drop(tx);
    pump_events(rx, &sink, &running);
    assert_eq!(running.count(), 0);
    assert_eq!(sink.lines(), ["outcome:true"]);
}

type Seen = Arc<Mutex<Vec<(String, bool)>>>;

/// 띄우개 — 띄울 때 장부가 잠겨 있지 않은지 본다.
struct Probe {
    ledger: Arc<Mutex<Ledger>>,
    seen: Seen,
}
impl MentionLauncher for Probe {
    fn launch(&mut self, _launch: Launch, mention_id: String) {
        let free = self.ledger.try_lock().is_ok();
        self.seen.lock().unwrap().push((mention_id, free));
    }
}

fn scheduler(fail: bool) -> (RunnerScheduler, Seen, Arc<Running>) {
    let ledger = Arc::new(Mutex::new(Ledger::new(&[], 0)));
    let seen = Arc::new(Mutex::new(Vec::new()));
    let running = Arc::new(Running::default());
    let admit: Box<AdmitFn> = Box::new(move |_l, _b, _c, q| {
        q.0.push((launch(1), "m1".into()));
        q.0.push((launch(2), "m2".into()));
        if fail {
            return Err("markRead".into());
        }
        Ok(AdmitOutcome {
            started: 2,
            ..AdmitOutcome::default()
        })
    });
    let probe = Probe {
        ledger: Arc::clone(&ledger),
        seen: Arc::clone(&seen),
    };
    let s = RunnerScheduler::new(ledger, admit, Box::new(probe), Arc::clone(&running));
    (s, seen, running)
}

#[test]
fn launches_happen_after_the_ledger_is_unlocked() {
    let (s, seen, running) = scheduler(false);
    let out = s
        .admit(&json!({"entries": []}), &BatchContext::default())
        .unwrap();
    assert_eq!(out.started, 2);
    assert_eq!(
        *seen.lock().unwrap(),
        [("m1".to_string(), true), ("m2".to_string(), true)]
    );
    assert_eq!(running.count(), 2);
}

#[test]
fn a_failed_admit_still_launches_what_it_decided() {
    let (s, seen, running) = scheduler(true);
    let e = s
        .admit(&json!({"entries": []}), &BatchContext::default())
        .unwrap_err();
    assert!(e.message.contains("markRead"));
    assert_eq!(seen.lock().unwrap().len(), 2);
    assert_eq!(running.count(), 2);
}

#[test]
fn drain_waits_for_every_turn_end() {
    let (s, _seen, running) = scheduler(false);
    s.admit(&json!({"entries": []}), &BatchContext::default())
        .unwrap();
    let (tx, rx) = mpsc::channel();
    let pump = spawn_event_pump(rx, Arc::new(Sink::default()), Arc::clone(&running)).unwrap();
    let ender = std::thread::spawn(move || {
        for m in ["m1", "m2"] {
            std::thread::sleep(Duration::from_millis(30));
            tx.send(SchedEvent::TurnEnded {
                thread_key: "c/a".into(),
                mention_id: m.into(),
            })
            .unwrap();
        }
    });
    s.drain();
    assert_eq!(running.count(), 0);
    ender.join().unwrap();
    pump.join().unwrap();
}

/// security nit(#2091): 물러나기는 시한까지만 기다린다 — `TurnEnded` 가 오지 않아도 걸리지 않는다.
#[test]
fn drain_gives_up_after_its_limit() {
    let (s, _seen, running) = scheduler(false);
    let s = s.with_drain_limit(std::time::Duration::from_millis(50));
    s.admit(&json!({"entries": []}), &BatchContext::default())
        .unwrap();
    let t = std::time::Instant::now();
    s.drain();
    assert!(
        t.elapsed() < std::time::Duration::from_secs(5),
        "시한 뒤 돌아온다"
    );
    assert_eq!(running.count(), 2, "끝나지 않은 멘션은 그대로 센다");
    assert_eq!(
        running.wait_idle_for(std::time::Duration::from_millis(1)),
        2
    );
}
