//! [`WatchNudgeIo`] — 재촉 바이트가 그 시도 감시 자리의 손잡이(`write_on_watch`)로만 가는지, 제출 시계가 값과 함께 꺼지는지.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::*;
use crate::pty::AttentionKind;
use crate::pty_turn::{
    PromptHooks, PtyControls, PtyPlan, PtyTurnOptions, PtyTurnSink, run_pty_turn,
};
use crate::turn_watch::{WatchSink, terminate_on_watch};

#[derive(Clone, Default)]
struct Out(Arc<Mutex<Vec<u8>>>);
impl Out {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.0.lock().unwrap()).into_owned()
    }
}
impl PromptHooks for Out {}
impl PtyTurnSink for Out {
    fn on_spawn(&mut self, _c: PtyControls) {}
    fn on_output(&mut self, frame: &[u8]) {
        self.0.lock().unwrap().extend_from_slice(frame);
    }
    fn on_injected(&mut self) {}
    fn on_attention(&mut self, _s: &str, _k: AttentionKind) {}
    fn on_turn_gate(&mut self, _s: &str) {}
}

fn io(watch: &Watch) -> WatchNudgeIo<'static> {
    WatchNudgeIo::new(
        "k".into(),
        || 1,
        true,
        NudgeCaller::Human,
        watch.clone(),
        Box::new(|| None),
        Box::new(|| None),
    )
}

/// 한 줄을 읽어 되돌려 쓰는 셸을 PTY 로 띄운다. 손잡이가 감시 자리에 적힐 때까지 기다린다.
fn spawn_echo(watch: &Watch, out: &Out) -> std::thread::JoinHandle<()> {
    let (w, mut o) = (watch.clone(), out.clone());
    let h = std::thread::spawn(move || {
        let plan = PtyPlan {
            command: "/bin/sh".into(),
            args: vec![
                "-c".into(),
                r#"printf READY; IFS= read -r l; printf 'GOT[%s]' "$l""#.into(),
            ],
            env: vec![("PATH".into(), "/usr/bin:/bin".into())],
            stdin_file: None,
        };
        let now = || 1;
        let mut sink = WatchSink {
            inner: &mut o,
            watch: w,
            now_ms: &now,
            stop_on_spawn: None,
        };
        let _ = run_pty_turn(
            &plan,
            PtyTurnOptions {
                timeout_ms: 5_000,
                ..PtyTurnOptions::at(std::env::temp_dir())
            },
            &mut sink,
        );
    });
    let t = Instant::now();
    while !(watch.lock().unwrap().end.has_controls && out.text().contains("READY")) {
        assert!(t.elapsed() < Duration::from_secs(5), "PTY 가 뜨지 않았다");
        std::thread::sleep(Duration::from_millis(5));
    }
    h
}

#[test]
fn nothing_is_written_before_spawn_or_after_exit() {
    let watch = Watch::default();
    let mut n = io(&watch);
    assert!(!n.write_pty(b"x"), "띄우기 전에는 손잡이가 없다");
    assert!(!n.exited());
    watch.lock().unwrap().end.exited = true;
    assert!(n.exited());
    assert!(!n.write_pty(b"x"));
}

#[test]
fn paste_and_enter_reach_the_pty_through_the_watch_handle() {
    let watch = Watch::default();
    let out = Out::default();
    let h = spawn_echo(&watch, &out);
    let mut n = io(&watch);
    assert!(n.write_pty(b"hi"));
    n.submit_later(Duration::from_millis(20));
    h.join().unwrap();
    assert!(out.text().contains("GOT[hi]"), "{}", out.text());
}

#[test]
fn pending_enter_dies_with_the_io() {
    let watch = Watch::default();
    let out = Out::default();
    let h = spawn_echo(&watch, &out);
    let mut n = io(&watch);
    assert!(n.write_pty(b"hi"));
    n.submit_later(Duration::from_millis(200));
    drop(n); // 시도 끝·패닉 풀림 — 서 있던 제출 시계도 꺼진다.
    std::thread::sleep(Duration::from_millis(500));
    let sent = out.text().contains("GOT[");
    terminate_on_watch(&watch)();
    h.join().unwrap();
    assert!(!sent, "값이 떨어진 뒤 Enter 가 갔다: {}", out.text());
}

#[test]
fn nudge_or_expire_pastes_only_through_write_on_watch() {
    use crate::turn_end::EndState;
    use crate::turn_probe::ProbeState;
    use crate::turn_probe_rest::{NudgeTarget, nudge_or_expire};

    let watch = Watch::default();
    let out = Out::default();
    let h = spawn_echo(&watch, &out);
    let read = Arc::new(AtomicBool::new(false));
    let r = read.clone();
    let mut n = WatchNudgeIo::new(
        "k".into(),
        || 10_000,
        true,
        NudgeCaller::Human,
        watch.clone(),
        Box::new(move || {
            r.store(true, Ordering::SeqCst);
            None
        }),
        Box::new(|| None),
    );
    let mut end = EndState {
        has_controls: true,
        finished: true,
        pending: Some(0),
        ..EndState::default()
    };
    let mut probe = ProbeState::default();
    nudge_or_expire(
        &mut end,
        &mut probe,
        &mut n,
        &NudgeTarget {
            channel_id: "c".into(),
            thread_root_id: Some("root".into()),
        },
        120_000,
    );
    assert!(read.load(Ordering::SeqCst), "마지막 말을 읽어 판정했다");
    assert_eq!(probe.lane_nudged_at_ms, 10_000, "재촉했다");
    // 붙여넣기 + 1초 뒤 Enter → 셸이 한 줄을 받는다.
    h.join().unwrap();
    assert!(out.text().contains("GOT["), "{}", out.text());
}
