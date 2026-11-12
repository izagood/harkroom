//! 정본 `test/turnRegistry.test.ts`·`test/mentionQueue.test.ts` 의 판정 대조.

use super::*;

fn rec(kind: TurnKind, who: Option<&str>) -> TurnRecord {
    TurnRecord {
        kind,
        session_id: None,
        opened_by_handle: who.map(str::to_string),
    }
}

#[test]
fn register_twice_is_refused_and_release_is_idempotent() {
    let mut r = TurnRegistry::new();
    r.register("t1", rec(TurnKind::Mention, None)).unwrap();
    let e = r
        .register("t1", rec(TurnKind::Interactive, None))
        .unwrap_err();
    assert_eq!(e.existing, TurnKind::Mention);
    assert!(e.to_string().contains("'t1'"));
    r.release("t1");
    r.release("t1");
    assert!(r.get("t1").is_none());
    r.register("t1", rec(TurnKind::Interactive, None)).unwrap();
}

#[test]
fn only_interactive_turns_control_the_thread() {
    let mut r = TurnRegistry::new();
    r.register("m", rec(TurnKind::Mention, None)).unwrap();
    r.register("i", rec(TurnKind::Interactive, Some("jb")))
        .unwrap();
    assert_eq!(r.control_of("m"), None);
    assert_eq!(r.control_of("none"), None);
    assert_eq!(
        r.control_of("i"),
        Some(ThreadControl {
            opened_by_handle: Some("jb".into())
        })
    );
    assert_eq!(r.keys_of(TurnKind::Interactive), vec!["i".to_string()]);
    assert_eq!(r.keys_of(TurnKind::Mention), vec!["m".to_string()]);
}

#[test]
fn reservation_is_not_a_turn() {
    let mut r = TurnRegistry::new();
    r.reserve_mention("t");
    assert!(r.mention_starting("t"));
    assert!(r.get("t").is_none());
    assert_eq!(r.control_of("t"), None);
    // 예약이 있어도 등록은 된다 — 등록되면 「시작 중」이 아니다.
    r.register("t", rec(TurnKind::Mention, None)).unwrap();
    assert!(!r.mention_starting("t"));
    r.unreserve_mention("t");
    r.release("t");
    assert!(!r.mention_starting("t"));
}

#[test]
fn defer_notifies_once_per_entry_and_tracks_episode() {
    let mut q = MentionQueue::new();
    let a = q.defer("t", 1, 10, 1_000);
    assert_eq!(
        a,
        DeferResult {
            should_notify: true,
            pending: 1,
            held_ms: 0,
            warned: false
        }
    );
    let b = q.defer("t", 1, 10, 4_000);
    assert!(!b.should_notify);
    assert_eq!((b.pending, b.held_ms), (1, 3_000));
    let c = q.defer("t", 2, 7, 5_000);
    assert!(c.should_notify);
    assert_eq!(c.pending, 2);
    assert_eq!(q.min_seq("t"), Some(7));
    q.mark_warned("t");
    assert!(q.defer("t", 2, 7, 6_000).warned);
    // 시계가 뒤로 가도 음수 경과는 없다.
    assert_eq!(q.defer("t", 3, 9, 0).held_ms, 0);
    q.clear("t");
    assert_eq!(q.min_seq("t"), None);
    let d = q.defer("t", 1, 10, 9_000);
    assert!(d.should_notify && !d.warned && d.held_ms == 0);
}

#[test]
fn mark_warned_on_unknown_thread_is_harmless() {
    let mut q = MentionQueue::new();
    q.mark_warned("x");
    assert_eq!(q.min_seq("x"), None);
}
