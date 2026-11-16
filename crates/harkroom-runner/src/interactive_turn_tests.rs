use super::*;
use crate::turn_registry::MentionReservation;

#[test]
fn empty_thread_registers_interactive_and_opens_session_once() {
    let c = SharedControl::default();
    let mut opened = 0;
    let got = claim(&c, "c/r", "h", None, || {
        opened += 1;
        "s1".into()
    });
    assert_eq!(got, Claim::Registered("s1".into()));
    assert_eq!(opened, 1);
    let ctl = lock_control(&c).registry.control_of("c/r");
    assert_eq!(ctl.unwrap().opened_by_handle.as_deref(), Some("h"));
}

#[test]
fn second_open_on_same_thread_attaches_instead_of_second_pty() {
    let c = SharedControl::default();
    claim(&c, "c/r", "h", None, || "s1".into());
    let got = claim(&c, "c/r", "h2", None, || panic!("둘째 세션을 열면 안 된다"));
    assert_eq!(got, Claim::Attach("s1".into()));
}

#[test]
fn running_mention_session_is_attached_not_replaced() {
    let c = SharedControl::default();
    let got = claim(&c, "c/r", "h", Some("m1".into()), || {
        panic!("멘션이 도는데 새 세션을 열면 안 된다")
    });
    assert_eq!(got, Claim::Attach("m1".into()));
    assert!(lock_control(&c).registry.get("c/r").is_none());
}

#[test]
fn reserved_mention_blocks_spawn_and_reservation_is_refused_after_register() {
    let c = SharedControl::default();
    let r = MentionReservation::try_reserve(&c, "c/r").unwrap();
    assert_eq!(
        claim(&c, "c/r", "h", None, || panic!("예약 중에는 열지 않는다")),
        Claim::MentionStarting
    );
    drop(r);
    assert_eq!(
        claim(&c, "c/r", "h", None, || "s1".into()),
        Claim::Registered("s1".into())
    );
    // 조종 중에는 멘션 예약이 서지 않는다 — 스레드당 턴 하나.
    assert!(MentionReservation::try_reserve(&c, "c/r").is_none());
}

#[test]
fn registered_turn_without_relay_is_refused() {
    let c = SharedControl::default();
    lock_control(&c)
        .registry
        .register(
            "c/r",
            TurnRecord {
                kind: TurnKind::Mention,
                session_id: None,
                opened_by_handle: None,
            },
        )
        .unwrap();
    assert_eq!(
        claim(&c, "c/r", "h", None, || panic!("열지 않는다")),
        Claim::NoRelay
    );
}

#[test]
fn last_fed_seq_is_clamped_below_pending_mention() {
    // 대기 멘션 seq 50 — 그 멘션은 아직 먹이지 않았다.
    assert_eq!(advance_last_fed_seq(10, 80, Some(50)), 49);
    assert_eq!(advance_last_fed_seq(10, 30, Some(50)), 30);
    assert_eq!(advance_last_fed_seq(10, 80, None), 80);
    // 뒤로 가지 않는다.
    assert_eq!(advance_last_fed_seq(60, 80, Some(50)), 60);
    assert_eq!(advance_last_fed_seq(0, 80, Some(0)), 0);
}

#[test]
fn settle_reads_min_then_clears_queue_then_releases() {
    let c = SharedControl::default();
    claim(&c, "c/r", "h", None, || "s1".into());
    lock_control(&c).queue.defer("c/r", 1, 50, 0);
    lock_control(&c).queue.defer("c/r", 2, 42, 0);
    let mut seen = None;
    settle(&c, "c/r", |min| {
        // 저장하는 동안에는 아직 조종 중이다 — 받아들이기가 유예를 풀지 않는다.
        assert!(lock_control(&c).registry.control_of("c/r").is_some());
        seen = min;
    });
    assert_eq!(seen, Some(42));
    let ctl = lock_control(&c);
    assert_eq!(ctl.queue.min_seq("c/r"), None);
    assert!(ctl.registry.get("c/r").is_none());
}
