//! 깨움 신호(E2b)의 계약 — 꺼짐은 그림자, 켜짐은 한 번 깨움, 같은 id 는 한 번만, 남의 것·틀린 꼴은 무시.

use super::*;
use serde_json::json;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

fn bound(enabled: bool) -> (WakeSignal, Arc<AtomicUsize>) {
    let n = Arc::new(AtomicUsize::new(0));
    let sig = WakeSignal::new(enabled);
    let k = Arc::clone(&n);
    sig.bind(
        "agent-1",
        Box::new(move || {
            k.fetch_add(1, Ordering::SeqCst);
        }),
    );
    (sig, n)
}

fn wake(id: &str, agent: &str) -> serde_json::Value {
    json!({"type": "wake", "wakeId": id, "agentId": agent, "messageId": "m1"})
}

#[test]
fn switch_reads_only_on() {
    assert!(wake_turn_enabled(Some("on")));
    assert!(wake_turn_enabled(Some(" on ")));
    for v in [
        None,
        Some(""),
        Some("off"),
        Some("1"),
        Some("true"),
        Some("ON"),
    ] {
        assert!(!wake_turn_enabled(v), "{v:?}");
    }
}

#[test]
fn off_is_shadow_and_never_kicks() {
    let (sig, n) = bound(false);
    assert_eq!(sig.on_frame(&wake("w1", "agent-1")), WakeNote::Shadow);
    assert_eq!(sig.on_frame(&json!({})), WakeNote::Shadow);
    assert_eq!(n.load(Ordering::SeqCst), 0);
}

#[test]
fn on_kicks_once_per_wake_id() {
    let (sig, n) = bound(true);
    assert_eq!(sig.on_frame(&wake("w1", "agent-1")), WakeNote::Kicked);
    assert_eq!(sig.on_frame(&wake("w1", "agent-1")), WakeNote::Duplicate);
    assert_eq!(n.load(Ordering::SeqCst), 1);
    assert_eq!(sig.on_frame(&wake("w2", "agent-1")), WakeNote::Kicked);
    assert_eq!(n.load(Ordering::SeqCst), 2);
}

#[test]
fn other_agent_and_bad_frames_are_ignored() {
    let (sig, n) = bound(true);
    let long = "a".repeat(200);
    for f in [
        wake("w1", "agent-2"),
        json!({"type": "wake", "agentId": "agent-1"}),
        json!({"type": "wake", "wakeId": 7, "agentId": "agent-1"}),
        json!({"type": "wake", "wakeId": "", "agentId": "agent-1"}),
        wake("w 1\n", "agent-1"),
        wake(&long, "agent-1"),
        json!("wake"),
    ] {
        assert_eq!(sig.on_frame(&f), WakeNote::Ignored, "{f}");
    }
    assert_eq!(n.load(Ordering::SeqCst), 0);
    // 무시된 id 는 기억하지 않는다 — 남의 것으로 온 id 가 내 것으로 다시 오면 깨운다.
    assert_eq!(sig.on_frame(&wake("w1", "agent-1")), WakeNote::Kicked);
}

#[test]
fn unbound_signal_ignores() {
    let sig = WakeSignal::new(true);
    assert_eq!(sig.on_frame(&wake("w1", "agent-1")), WakeNote::Ignored);
}

#[test]
fn seen_ids_are_bounded() {
    let (sig, n) = bound(true);
    for i in 0..=SEEN_CAP {
        assert_eq!(
            sig.on_frame(&wake(&format!("w{i}"), "agent-1")),
            WakeNote::Kicked
        );
    }
    // 가장 오래된 것은 잊혔다 — 다시 오면 폴 한 번이 더 돈다(중복 방지는 스케줄러 몫).
    assert_eq!(sig.on_frame(&wake("w0", "agent-1")), WakeNote::Kicked);
    assert_eq!(n.load(Ordering::SeqCst), SEEN_CAP + 2);
}
