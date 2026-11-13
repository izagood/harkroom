//! [`OnceRelease`] — 슬롯 놓기·턴 끝이 정상·패닉 모두에서 정확히 한 번.
use std::sync::{Arc, Mutex};

use super::*;

#[derive(Clone, Default)]
struct Rec(Arc<Mutex<Vec<String>>>);
impl SchedulerHooks for Rec {
    fn notice_fenced(&mut self) {}
    fn turn_outcome(&mut self, _ok: bool) {}
    fn stop_requested(&mut self, _at: &str) {}
    fn executable_missing(&mut self) {}
    fn release_slot(&mut self, k: &str) {
        self.0.lock().unwrap().push(format!("slot:{k}"));
    }
    fn turn_ended(&mut self, k: &str, m: &str) {
        self.0.lock().unwrap().push(format!("end:{k}:{m}"));
    }
}

#[test]
fn normal_path_releases_once() {
    let rec = Rec::default();
    {
        let mut r = OnceRelease::new(rec.clone(), "t", true, "m");
        r.release_slot("t");
        r.turn_ended("t", "m");
        r.release_slot("t");
        r.turn_ended("t", "m");
    }
    assert_eq!(*rec.0.lock().unwrap(), vec!["slot:t", "end:t:m"]);
}

#[test]
fn panic_path_releases_once_on_drop() {
    let rec = Rec::default();
    let r2 = rec.clone();
    let res = std::panic::catch_unwind(move || {
        let _r = OnceRelease::new(r2, "t", true, "m");
        panic!("run_one 도중 패닉");
    });
    assert!(res.is_err());
    assert_eq!(*rec.0.lock().unwrap(), vec!["slot:t", "end:t:m"]);
}

#[test]
fn half_done_then_panic_releases_the_rest_only() {
    let rec = Rec::default();
    let r2 = rec.clone();
    let res = std::panic::catch_unwind(move || {
        let mut r = OnceRelease::new(r2, "t", true, "m");
        r.release_slot("t");
        panic!("턴 끝 알리기 전 패닉");
    });
    assert!(res.is_err());
    assert_eq!(*rec.0.lock().unwrap(), vec!["slot:t", "end:t:m"]);
}

#[test]
fn slot_not_held_is_not_released() {
    let rec = Rec::default();
    drop(OnceRelease::new(rec.clone(), "t", false, "m"));
    assert_eq!(*rec.0.lock().unwrap(), vec!["end:t:m"]);
}
