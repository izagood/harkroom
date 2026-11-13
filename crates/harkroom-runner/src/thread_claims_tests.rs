//! [`ThreadClaims`] — 잡기·박동·잃음·놓기(정본 `threadClaims.ts`).
use std::collections::VecDeque;
use std::sync::atomic::AtomicU32;

use super::*;

#[derive(Default)]
struct Fake {
    /// 차례로 줄 답. 비면 `Held`.
    replies: Mutex<VecDeque<Result<ClaimOutcome, String>>>,
    claims: AtomicU32,
    releases: AtomicU32,
}

impl Fake {
    fn with(r: Vec<Result<ClaimOutcome, String>>) -> Arc<Self> {
        Arc::new(Self {
            replies: Mutex::new(r.into()),
            ..Self::default()
        })
    }
}

impl ClaimClient for Fake {
    fn claim(&self, _c: &str, _r: &str, _h: &str, _t: u64) -> Result<ClaimOutcome, String> {
        self.claims.fetch_add(1, Ordering::SeqCst);
        lock(&self.replies)
            .pop_front()
            .unwrap_or(Ok(ClaimOutcome::Held))
    }
    fn release(&self, _c: &str, _r: &str, _h: &str) -> Result<(), String> {
        self.releases.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

fn claims(f: &Arc<Fake>) -> ThreadClaims<Fake> {
    ThreadClaims::with_timing(Arc::clone(f), "me".into(), 90, Duration::from_millis(5))
}

fn held(h: ClaimHold) -> Box<dyn ThreadClaimHandle> {
    match h {
        ClaimHold::Held(c) => c,
        _ => panic!("잡혀야 한다"),
    }
}

#[test]
fn one_per_thread_until_released() {
    let f = Fake::with(vec![]);
    let tc = claims(&f);
    let c = held(tc.hold("c", "t", None));
    assert!(
        matches!(tc.hold("c", "t", None), ClaimHold::Busy),
        "같은 스레드는 놓기 전까지 Busy"
    );
    // 다른 스레드는 따로 잡힌다(쥔 채로 둔다 — 떨구면 놓는다).
    let _u = held(tc.hold("c", "u", None));
    c.release();
    assert_eq!(f.releases.load(Ordering::SeqCst), 1);
    assert!(
        matches!(tc.hold("c", "t", None), ClaimHold::Held(_)),
        "놓은 뒤 다시 잡는다"
    );
}

#[test]
fn unconfirmed_or_taken_does_not_launch() {
    let f = Fake::with(vec![Err("link down".into()), Ok(ClaimOutcome::Taken)]);
    let tc = claims(&f);
    assert!(
        matches!(tc.hold("c", "t", None), ClaimHold::Busy),
        "확인 못 하면 띄우지 않는다"
    );
    assert!(
        matches!(tc.hold("c", "t", None), ClaimHold::Busy),
        "남이 쥐었다"
    );
    assert_eq!(tc.held_count(), 0, "쥔 것으로 남지 않는다");
}

#[test]
fn old_server_gives_a_claim_that_never_fences() {
    let f = Fake::with(vec![Ok(ClaimOutcome::Unsupported)]);
    let tc = claims(&f);
    let c = held(tc.hold("c", "t", None));
    assert!(!c.fenced());
    // 옛 서버여도 이 프로세스 안에서는 스레드당 하나 — 쥔 동안 같은 스레드는 `Busy`(서버는 묻지 않는다).
    assert_eq!(tc.held_count(), 1);
    assert!(matches!(tc.hold("c", "t", None), ClaimHold::Busy));
    c.release();
    assert_eq!(tc.held_count(), 0, "놓으면 지운다");
    let f2 = Fake::with(vec![Ok(ClaimOutcome::Unsupported)]);
    let tc2 = claims(&f2);
    drop(held(tc2.hold("c", "t", None)));
    assert_eq!(tc2.held_count(), 0, "떨어지면(Drop) 지운다");
}

/// 펜스: 박동이 `Taken` 을 받으면 잃음 표지가 서고 알림이 한 번, 박동은 멈춘다.
#[test]
fn heartbeat_taken_fences_once_and_stops() {
    let f = Fake::with(vec![
        Ok(ClaimOutcome::Held),
        Ok(ClaimOutcome::Held),
        Ok(ClaimOutcome::Taken),
    ]);
    let tc = claims(&f);
    let hits = Arc::new(AtomicU32::new(0));
    let h2 = Arc::clone(&hits);
    let c = held(tc.hold(
        "c",
        "t",
        Some(Arc::new(move || {
            h2.fetch_add(1, Ordering::SeqCst);
        })),
    ));
    let t = std::time::Instant::now();
    while !c.fenced() {
        assert!(t.elapsed() < Duration::from_secs(5), "잃음이 서야 한다");
        std::thread::sleep(Duration::from_millis(2));
    }
    let after = f.claims.load(Ordering::SeqCst);
    std::thread::sleep(Duration::from_millis(40));
    assert_eq!(f.claims.load(Ordering::SeqCst), after, "잃은 뒤 박동 없음");
    assert_eq!(hits.load(Ordering::SeqCst), 1, "알림 한 번");
    assert!(c.fenced(), "다시 내려가지 않는다");
}

/// 일시 오류로는 잃지 않는다.
#[test]
fn transient_heartbeat_error_does_not_fence() {
    let f = Fake::with(vec![
        Ok(ClaimOutcome::Held),
        Err("503".into()),
        Err("503".into()),
    ]);
    let tc = claims(&f);
    let c = held(tc.hold("c", "t", None));
    std::thread::sleep(Duration::from_millis(40));
    assert!(!c.fenced());
    assert!(f.claims.load(Ordering::SeqCst) > 3, "박동은 계속 민다");
}

/// 손잡이가 떨어지면(패닉 풀림 포함) 놓는다 — 박동도 멈춘다.
#[test]
fn dropping_the_handle_releases_and_stops_heartbeat() {
    let f = Fake::with(vec![]);
    let tc = claims(&f);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _c = held(tc.hold("c", "t", None));
        panic!("턴 도중 패닉");
    }));
    assert!(r.is_err());
    assert_eq!(f.releases.load(Ordering::SeqCst), 1, "패닉에도 놓는다");
    assert_eq!(tc.held_count(), 0);
    let after = f.claims.load(Ordering::SeqCst);
    std::thread::sleep(Duration::from_millis(30));
    assert_eq!(f.claims.load(Ordering::SeqCst), after, "놓은 뒤 박동 없음");
}
