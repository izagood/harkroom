use super::*;

#[test]
fn spawn_without_news_starts_orphan_grace() {
    let mut l = InteractiveLife::new();
    assert_eq!(l.spawned(), vec![Act::StartOrphan]);
    assert_eq!(l.orphan_fired(), vec![Act::Terminate]);
    assert_eq!(l.kill_grace_fired(), vec![Act::Kill]);
}

#[test]
fn viewer_heard_before_spawn_is_replayed_not_zeroed() {
    let mut l = InteractiveLife::new();
    assert!(l.viewer_count(1).is_empty());
    assert!(
        l.spawned().is_empty(),
        "보고 있는 사람 앞에서 유예가 흐르면 안 된다"
    );
}

#[test]
fn viewer_returns_cancels_grace_and_zero_again_does_not_extend() {
    let mut l = InteractiveLife::new();
    l.spawned();
    assert!(
        l.viewer_count(0).is_empty(),
        "이미 유예 중 — 다시 세우지 않는다"
    );
    assert_eq!(l.viewer_count(2), vec![Act::CancelOrphan]);
    assert_eq!(l.viewer_count(0), vec![Act::StartOrphan]);
}

#[test]
fn cancel_reclaims_immediately_and_is_not_undone_by_viewers() {
    let mut l = InteractiveLife::new();
    l.spawned();
    assert_eq!(l.cancel("jb"), vec![Act::CancelOrphan, Act::Terminate]);
    assert!(l.viewer_count(1).is_empty());
    assert!(l.cancel("jb").is_empty());
    assert_eq!(l.canceled_by(), Some("jb"));
}

#[test]
fn cancel_before_spawn_is_taken_at_spawn() {
    let mut l = InteractiveLife::new();
    assert!(l.cancel("jb").is_empty(), "손잡이가 없다");
    assert_eq!(l.spawned(), vec![Act::Terminate]);
}

#[test]
fn exit_drops_timers_and_silences_everything() {
    let mut l = InteractiveLife::new();
    l.spawned();
    assert_eq!(l.exit(), vec![Act::CancelOrphan]);
    assert!(l.orphan_fired().is_empty());
    assert!(l.kill_grace_fired().is_empty());
    assert!(l.cancel("jb").is_empty());
    assert!(l.shutdown().is_empty());
}

#[test]
fn shutdown_reclaims_once() {
    let mut l = InteractiveLife::new();
    l.viewer_count(1);
    l.spawned();
    assert_eq!(l.shutdown(), vec![Act::Terminate]);
    assert!(l.shutdown().is_empty());
}
