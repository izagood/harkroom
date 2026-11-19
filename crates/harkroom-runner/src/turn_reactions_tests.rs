use super::*;
use crate::mention_target::build_mention_target;
use serde_json::{Value, json};
use std::cell::RefCell;

#[derive(Default)]
struct Rec {
    calls: RefCell<Vec<String>>,
    fail_add: bool,
}

impl Reactor for Rec {
    fn add(&self, c: &str, m: &str, e: &str) -> Result<(), String> {
        self.calls.borrow_mut().push(format!("+{c}/{m}/{e}"));
        if self.fail_add {
            Err("boom".into())
        } else {
            Ok(())
        }
    }
    fn remove(&self, c: &str, m: &str, e: &str) -> Result<(), String> {
        self.calls.borrow_mut().push(format!("-{c}/{m}/{e}"));
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
fn received_marks_mention_then_bundled_rows() {
    let t = target("mention", &[json!({ "id": "b1" }), json!({ "id": "m1" })]);
    assert_eq!(received_ids(&t), vec!["m1".to_string(), "b1".to_string()]);
    let r = Rec::default();
    mark_received(&r, &t, &|_| {});
    assert_eq!(*r.calls.borrow(), vec!["+c1/m1/👀", "+c1/b1/👀"]);
}

#[test]
fn wake_marks_only_the_mention() {
    let t = target("wake", &[json!({ "id": "b1" })]);
    assert_eq!(received_ids(&t), vec!["m1".to_string()]);
}

#[test]
fn working_reaction_adds_then_removes_on_drop() {
    let r = Rec::default();
    let t = target("mention", &[]);
    {
        let g = WorkingReaction::start(&r, &t, &|_| {});
        assert!(g.is_some());
        assert_eq!(*r.calls.borrow(), vec!["+c1/m1/💬"]);
    }
    assert_eq!(*r.calls.borrow(), vec!["+c1/m1/💬", "-c1/m1/💬"]);
}

#[test]
fn working_reaction_removed_even_on_panic() {
    let r = Rec::default();
    let t = target("mention", &[]);
    let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _g = WorkingReaction::start(&r, &t, &|_| {});
        panic!("턴 패닉");
    }));
    assert!(res.is_err());
    assert_eq!(
        r.calls.borrow().last().map(String::as_str),
        Some("-c1/m1/💬")
    );
}

#[test]
fn add_failure_is_logged_and_still_removes() {
    let r = Rec {
        fail_add: true,
        ..Default::default()
    };
    let t = target("mention", &[]);
    let logs = RefCell::new(Vec::<String>::new());
    let log = |l: &str| logs.borrow_mut().push(l.to_string());
    mark_received(&r, &t, &log);
    drop(WorkingReaction::start(&r, &t, &log));
    assert_eq!(logs.borrow().len(), 2);
    assert!(logs.borrow()[0].contains("받았음") && logs.borrow()[1].contains("진행 중"));
    assert_eq!(
        r.calls.borrow().last().map(String::as_str),
        Some("-c1/m1/💬")
    );
}

#[test]
fn no_mention_id_means_no_working_reaction() {
    let r = Rec::default();
    let mut t = target("mention", &[]);
    t.mention_id.clear();
    assert!(WorkingReaction::start(&r, &t, &|_| {}).is_none());
    assert!(r.calls.borrow().is_empty());
}
