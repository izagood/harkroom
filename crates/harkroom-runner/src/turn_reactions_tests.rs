use super::*;
use crate::mention_target::build_mention_target;
use serde_json::{Value, json};
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Default)]
struct Rec {
    calls: Mutex<Vec<String>>,
    fail_add: bool,
    /// 달기 한 번이 걸리는 시간(서버 왕복 흉내).
    add_delay: Duration,
}

impl Rec {
    fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }
    fn push(&self, s: String) {
        self.calls.lock().unwrap_or_else(|p| p.into_inner()).push(s);
    }
}

impl Reactor for Rec {
    fn add(&self, c: &str, m: &str, e: &str) -> Result<(), String> {
        std::thread::sleep(self.add_delay);
        self.push(format!("+{c}/{m}/{e}"));
        if self.fail_add {
            Err("boom".into())
        } else {
            Ok(())
        }
    }
    fn remove(&self, c: &str, m: &str, e: &str) -> Result<(), String> {
        self.push(format!("-{c}/{m}/{e}"));
        Ok(())
    }
}

fn mention() -> Value {
    json!({ "id": "m1", "channelId": "c1", "body": "hi", "meta": null })
}

fn target(reason: &str, bundled: &[Value]) -> MentionTarget {
    build_mention_target(&json!({ "reason": reason }), &mention(), "root", bundled)
}

#[test]
fn received_marks_mention_then_bundled_rows_then_working() {
    let t = target("mention", &[json!({ "id": "b1" }), json!({ "id": "m1" })]);
    assert_eq!(received_ids(&t), vec!["m1".to_string(), "b1".to_string()]);
    let r = Rec::default();
    let lines = add_all(&r, "c1", &received_ids(&t), Some("m1"));
    assert!(lines.is_empty());
    assert_eq!(r.calls(), vec!["+c1/m1/👀", "+c1/b1/👀", "+c1/m1/💬"]);
}

#[test]
fn wake_marks_only_the_mention() {
    let t = target("wake", &[json!({ "id": "b1" })]);
    assert_eq!(received_ids(&t), vec!["m1".to_string()]);
}

#[test]
fn guard_adds_then_removes_on_drop() {
    let r = Rec::default();
    let t = target("mention", &[]);
    std::thread::scope(|s| {
        let _g = TurnReactions::start(s, &r, &t, &|_| {});
    });
    assert_eq!(r.calls(), vec!["+c1/m1/👀", "+c1/m1/💬", "-c1/m1/💬"]);
}

/// 달기는 턴 시작을 막지 않는다 — 달기 왕복이 길어도 `start` 는 바로 돌아오고, 몸통이 도는 동안 곁에서 달린다.
#[test]
fn start_does_not_wait_for_the_adds() {
    let r = Rec {
        add_delay: Duration::from_millis(300),
        ..Default::default()
    };
    let t = target("mention", &[]);
    std::thread::scope(|s| {
        let t0 = Instant::now();
        let _g = TurnReactions::start(s, &r, &t, &|_| {});
        assert!(
            t0.elapsed() < Duration::from_millis(150),
            "달기 두 번(600ms)을 기다리지 않는다"
        );
        assert!(r.calls().is_empty(), "몸통이 먼저 나아간다");
    });
    assert_eq!(r.calls(), vec!["+c1/m1/👀", "+c1/m1/💬", "-c1/m1/💬"]);
}

/// 임대 거절·준비 실패처럼 몸통이 달기보다 **먼저** 끝나도 떼기가 달기를 앞지르지 않는다 — 👀·💬 는 빠지지 않고
/// 순서는 👀 → 💬 달기 → 💬 떼기다. 앞지르면 💬 가 영영 남는다.
#[test]
fn body_ending_before_the_adds_still_removes_last() {
    let r = Rec {
        add_delay: Duration::from_millis(80),
        ..Default::default()
    };
    let t = target("mention", &[json!({ "id": "b1" })]);
    std::thread::scope(|s| {
        // 몸통이 곧바로 끝난다(턴을 띄우지 못했다).
        drop(TurnReactions::start(s, &r, &t, &|_| {}));
        assert_eq!(
            r.calls(),
            vec!["+c1/m1/👀", "+c1/b1/👀", "+c1/m1/💬", "-c1/m1/💬"],
            "가드가 떨어진 그 자리에서 달기를 기다린 뒤 뗐다"
        );
    });
}

#[test]
fn working_reaction_removed_even_on_panic() {
    let r = Rec {
        add_delay: Duration::from_millis(40),
        ..Default::default()
    };
    let t = target("mention", &[]);
    let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        std::thread::scope(|s| {
            let _g = TurnReactions::start(s, &r, &t, &|_| {});
            panic!("턴 패닉");
        })
    }));
    assert!(res.is_err());
    assert_eq!(r.calls(), vec!["+c1/m1/👀", "+c1/m1/💬", "-c1/m1/💬"]);
}

#[test]
fn add_failure_is_logged_and_still_removes() {
    let r = Rec {
        fail_add: true,
        ..Default::default()
    };
    let t = target("mention", &[]);
    let logs = Mutex::new(Vec::<String>::new());
    let log = |l: &str| logs.lock().unwrap().push(l.to_string());
    std::thread::scope(|s| drop(TurnReactions::start(s, &r, &t, &log)));
    let logs = logs.lock().unwrap();
    assert_eq!(logs.len(), 2);
    assert!(logs[0].contains("받았음") && logs[1].contains("진행 중"));
    assert_eq!(r.calls().last().map(String::as_str), Some("-c1/m1/💬"));
}

#[test]
fn no_mention_id_means_no_reactions_at_all() {
    let r = Rec::default();
    let mut t = target("mention", &[]);
    t.mention_id.clear();
    std::thread::scope(|s| drop(TurnReactions::start(s, &r, &t, &|_| {})));
    assert!(r.calls().is_empty());
}
