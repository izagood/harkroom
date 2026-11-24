//! 계획 진행 판정(K1, 그림자)의 순수 함수 — 계획 문서 한 장과 「카드 상태·에이전트 계정」을 받아, 서버가 손을 댄다면
//! 무엇을 했을지를 낸다. I/O 가 없고 문서를 고치지 않는다. 부르는 곳은 `loops::plan_progress` 하나다(수만 기록한다).
//!
//! 판정 셋:
//! - `would_block` — 단계의 `links` 에 사람이 답할 카드(`kind: "card"`)가 달려 있고 그중 하나라도 아직 열려 있는데, 단계가
//!   `pending`·`active` 다.
//! - `would_unblock` — 단계가 `blocked` 이고, 달린 카드 중 열린 것이 없으며 하나 이상이 **답으로** 닫혔다.
//! - `would_start` — 단계가 `pending` 이고 담당(`assigneeId`)이 에이전트이며, `dependsOn` 이 모두 끝났고 열린 카드가 없다.
//!
//! 건드리지 않는 것:
//! - 카드가 안 달린 단계의 막힘·풀림(손으로 막은 단계는 손으로 푼다). 모르는 카드(지워졌거나 답할 카드가 아님)는 없는 것으로 본다.
//! - 답 없이 닫힌 카드(만료·대체)만 달린 `blocked` 단계 — 풀지 않는다.
//! - `done` 단계.
use serde_json::Value;
use std::collections::{HashMap, HashSet};

/// 카드 하나의 상태 — 카드 글 `meta.ask` 에서 읽는다([`card_state`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Card {
    /// 아직 답을 기다린다.
    Open,
    /// 답으로 닫혔다(`answeredWith`).
    Answered,
    /// 답 없이 닫혔다(만료·대체 등, `closedAt` 만).
    Closed,
}

/// 카드 글의 `meta.ask` → 상태. 답이 있으면 닫힘 표시가 같이 있어도 `Answered` 다.
pub fn card_state(ask: &Value) -> Card {
    let present = |k: &str| ask.get(k).is_some_and(|v| !v.is_null());
    if present("answeredWith") {
        Card::Answered
    } else if present("closedAt") {
        Card::Closed
    } else {
        Card::Open
    }
}

/// 한 계획의 판정 — 단계 id 들(문서의 단계 순서).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Verdicts {
    pub would_block: Vec<String>,
    pub would_unblock: Vec<String>,
    pub would_start: Vec<String>,
    /// 상한에 걸려 뒤 단계의 판정을 버렸다.
    pub truncated: bool,
}

impl Verdicts {
    pub fn len(&self) -> usize {
        self.would_block.len() + self.would_unblock.len() + self.would_start.len()
    }
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
    /// (막힘, 풀림, 시작) 수.
    pub fn counts(&self) -> (usize, usize, usize) {
        (
            self.would_block.len(),
            self.would_unblock.len(),
            self.would_start.len(),
        )
    }
}

fn steps(doc: &Value) -> &[Value] {
    doc["steps"].as_array().map_or(&[], Vec::as_slice)
}

fn step_cards(step: &Value) -> impl Iterator<Item = String> + '_ {
    step["links"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|l| l["kind"].as_str() == Some("card"))
        .filter_map(|l| l["messageId"].as_str())
        .map(str::to_lowercase)
}

/// 문서의 끝나지 않은 단계에 달린 카드 글 id(소문자, 겹침 없음, 문서 순서).
pub fn card_ids(doc: &Value) -> Vec<String> {
    let mut seen = HashSet::new();
    steps(doc)
        .iter()
        .filter(|s| s["state"].as_str() != Some("done"))
        .flat_map(step_cards)
        .filter(|id| seen.insert(id.clone()))
        .collect()
}

/// 문서의 `pending` 단계 담당 id(소문자, 겹침 없음, 문서 순서).
pub fn assignee_ids(doc: &Value) -> Vec<String> {
    let mut seen = HashSet::new();
    steps(doc)
        .iter()
        .filter(|s| s["state"].as_str() == Some("pending"))
        .filter_map(|s| s["assigneeId"].as_str())
        .map(str::to_lowercase)
        .filter(|id| seen.insert(id.clone()))
        .collect()
}

/// 앞 단계 하나가 끝났나. 단계 id 면 그 단계가 `done`, 그룹 id 면 그 그룹의 단계가 하나 이상이고 모두 `done`.
/// 다른 스레드에 이어진 그룹(`linkedRootId`)·모르는 id 는 끝나지 않은 것으로 본다(여기서 알 수 없다).
fn dep_done(doc: &Value, dep: &str) -> bool {
    if let Some(s) = steps(doc).iter().find(|s| s["id"].as_str() == Some(dep)) {
        return s["state"].as_str() == Some("done");
    }
    let group = doc["groups"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|g| g["id"].as_str() == Some(dep));
    let Some(group) = group else { return false };
    if group.get("linkedRootId").is_some_and(|v| !v.is_null()) {
        return false;
    }
    let mut members = steps(doc)
        .iter()
        .filter(|s| s["groupId"].as_str() == Some(dep))
        .peekable();
    members.peek().is_some() && members.all(|s| s["state"].as_str() == Some("done"))
}

/// 계획 한 장을 판정한다. `cards` 는 카드 글 id(소문자) → 상태, `agents` 는 에이전트 계정 id(소문자).
/// 판정은 합쳐서 `cap` 개까지만 낸다(넘으면 `truncated`).
pub fn judge(
    doc: &Value,
    cards: &HashMap<String, Card>,
    agents: &HashSet<String>,
    cap: usize,
) -> Verdicts {
    let mut out = Verdicts::default();
    for step in steps(doc) {
        let (Some(id), Some(state)) = (step["id"].as_str(), step["state"].as_str()) else {
            continue;
        };
        if state == "done" {
            continue;
        }
        let known: Vec<Card> = step_cards(step)
            .filter_map(|c| cards.get(&c).copied())
            .collect();
        let open = known.contains(&Card::Open);
        let answered = known.contains(&Card::Answered);
        let which = if open {
            match state {
                "pending" | "active" => 0,
                _ => continue,
            }
        } else if state == "blocked" {
            if !answered {
                continue;
            }
            1
        } else if state == "pending"
            && step["assigneeId"]
                .as_str()
                .is_some_and(|a| agents.contains(&a.to_lowercase()))
            && step["dependsOn"]
                .as_array()
                .into_iter()
                .flatten()
                .all(|d| d.as_str().is_some_and(|d| dep_done(doc, d)))
        {
            2
        } else {
            continue;
        };
        if out.len() >= cap {
            out.truncated = true;
            break;
        }
        match which {
            0 => &mut out.would_block,
            1 => &mut out.would_unblock,
            _ => &mut out.would_start,
        }
        .push(id.to_string());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const AGENT: &str = "a0000000-0000-0000-0000-000000000001";
    const HUMAN: &str = "b0000000-0000-0000-0000-000000000002";

    fn card(id: &str) -> Value {
        json!({"kind": "card", "messageId": id})
    }

    fn step(id: &str, state: &str, links: Vec<Value>, deps: &[&str]) -> Value {
        json!({"id": id, "groupId": null, "title": id, "state": state, "links": links, "dependsOn": deps})
    }

    fn with(mut s: Value, k: &str, v: Value) -> Value {
        s[k] = v;
        s
    }

    fn doc(steps: Vec<Value>) -> Value {
        json!({"goal": "", "groups": [], "steps": steps})
    }

    fn cards(list: &[(&str, Card)]) -> HashMap<String, Card> {
        list.iter().map(|(k, v)| (k.to_string(), *v)).collect()
    }

    fn agents() -> HashSet<String> {
        HashSet::from([AGENT.to_string()])
    }

    fn run(d: &Value, c: &[(&str, Card)]) -> Verdicts {
        judge(d, &cards(c), &agents(), 100)
    }

    #[test]
    fn card_state_reads_ask_meta() {
        assert_eq!(card_state(&json!({"question": "q"})), Card::Open);
        assert_eq!(
            card_state(&json!({"answeredWith": null, "closedAt": null})),
            Card::Open
        );
        assert_eq!(card_state(&json!({"answeredWith": "yes"})), Card::Answered);
        assert_eq!(
            card_state(&json!({"answeredWith": "yes", "closedAt": "t"})),
            Card::Answered
        );
        assert_eq!(
            card_state(&json!({"closedAt": "t", "closedReason": "expired"})),
            Card::Closed
        );
    }

    #[test]
    fn open_card_blocks_pending_and_active_steps() {
        let d = doc(vec![
            step("s1", "pending", vec![card("c1")], &[]),
            step("s2", "active", vec![card("c1")], &[]),
        ]);
        let v = run(&d, &[("c1", Card::Open)]);
        assert_eq!(v.would_block, ["s1", "s2"]);
        assert!(v.would_unblock.is_empty() && v.would_start.is_empty());
    }

    #[test]
    fn already_blocked_step_with_open_card_gets_no_verdict() {
        let d = doc(vec![step("s1", "blocked", vec![card("c1")], &[])]);
        assert!(run(&d, &[("c1", Card::Open)]).is_empty());
    }

    #[test]
    fn answered_card_unblocks_a_blocked_step() {
        let d = doc(vec![step("s1", "blocked", vec![card("c1")], &[])]);
        let v = run(&d, &[("c1", Card::Answered)]);
        assert_eq!(v.would_unblock, ["s1"]);
        assert_eq!(v.counts(), (0, 1, 0));
    }

    #[test]
    fn several_cards_one_still_open_keeps_the_step_blocked() {
        let links = vec![card("c1"), card("c2")];
        let blocked = doc(vec![step("s1", "blocked", links.clone(), &[])]);
        let state = [("c1", Card::Answered), ("c2", Card::Open)];
        assert!(run(&blocked, &state).is_empty());
        // 같은 카드 꼴에서 아직 안 막힌 단계는 막는다.
        let active = doc(vec![step("s1", "active", links.clone(), &[])]);
        assert_eq!(run(&active, &state).would_block, ["s1"]);
        // 둘 다 답으로 닫히면 푼다.
        let both = [("c1", Card::Answered), ("c2", Card::Answered)];
        assert_eq!(run(&blocked, &both).would_unblock, ["s1"]);
    }

    #[test]
    fn hand_blocked_step_without_a_card_is_left_alone() {
        let hand = with(
            step("s1", "blocked", vec![], &[]),
            "blockedReason",
            json!("waiting"),
        );
        let pr = step(
            "s2",
            "blocked",
            vec![json!({"kind": "pr", "repo": "o/r", "number": 1})],
            &[],
        );
        let d = doc(vec![hand, pr]);
        assert!(run(&d, &[("c1", Card::Answered)]).is_empty());
    }

    #[test]
    fn card_closed_without_an_answer_does_not_unblock() {
        let d = doc(vec![step("s1", "blocked", vec![card("c1")], &[])]);
        assert!(run(&d, &[("c1", Card::Closed)]).is_empty());
        // 답 없이 닫힌 카드는 막지도 않는다.
        let d = doc(vec![step("s1", "active", vec![card("c1")], &[])]);
        assert!(run(&d, &[("c1", Card::Closed)]).is_empty());
    }

    #[test]
    fn unknown_card_counts_as_no_card() {
        let d = doc(vec![
            step("s1", "blocked", vec![card("gone")], &[]),
            step("s2", "active", vec![card("gone")], &[]),
        ]);
        assert!(run(&d, &[]).is_empty());
    }

    #[test]
    fn done_step_is_never_touched() {
        let d = doc(vec![step("s1", "done", vec![card("c1")], &[])]);
        assert!(run(&d, &[("c1", Card::Open)]).is_empty());
        assert!(card_ids(&d).is_empty());
    }

    #[test]
    fn card_ids_are_lowercased_and_unique() {
        let d = doc(vec![
            step("s1", "pending", vec![card("C1"), card("c2")], &[]),
            step("s2", "blocked", vec![card("c1")], &[]),
        ]);
        assert_eq!(card_ids(&d), ["c1", "c2"]);
        assert_eq!(run(&d, &[("c1", Card::Open)]).would_block, ["s1"]);
    }

    #[test]
    fn pending_agent_step_with_done_deps_would_start() {
        let d = doc(vec![
            step("s1", "done", vec![], &[]),
            with(
                step("s2", "pending", vec![], &["s1"]),
                "assigneeId",
                json!(AGENT),
            ),
            with(
                step("s3", "pending", vec![], &["s2"]),
                "assigneeId",
                json!(AGENT),
            ),
            with(
                step("s4", "pending", vec![], &[]),
                "assigneeId",
                json!(AGENT),
            ),
        ]);
        let v = run(&d, &[]);
        assert_eq!(v.would_start, ["s2", "s4"]);
        assert_eq!(assignee_ids(&d), [AGENT]);
    }

    #[test]
    fn human_or_unassigned_or_non_pending_steps_do_not_start() {
        let d = doc(vec![
            with(
                step("s1", "pending", vec![], &[]),
                "assigneeId",
                json!(HUMAN),
            ),
            step("s2", "pending", vec![], &[]),
            with(
                step("s3", "active", vec![], &[]),
                "assigneeId",
                json!(AGENT),
            ),
            with(
                step("s4", "pending", vec![], &["nope"]),
                "assigneeId",
                json!(AGENT),
            ),
        ]);
        assert!(run(&d, &[]).is_empty());
    }

    #[test]
    fn open_card_wins_over_start_and_answered_card_allows_it() {
        let s = with(
            step("s1", "pending", vec![card("c1")], &[]),
            "assigneeId",
            json!(AGENT),
        );
        let d = doc(vec![s]);
        assert_eq!(run(&d, &[("c1", Card::Open)]).counts(), (1, 0, 0));
        assert_eq!(run(&d, &[("c1", Card::Answered)]).counts(), (0, 0, 1));
    }

    #[test]
    fn group_dependency_needs_every_member_done() {
        let member =
            |id: &str, state: &str| with(step(id, state, vec![], &[]), "groupId", json!("g1"));
        let last = with(
            step("s9", "pending", vec![], &["g1"]),
            "assigneeId",
            json!(AGENT),
        );
        let groups = json!([
            {"id": "g1", "title": "", "dependsOn": []},
            {"id": "g2", "title": "", "dependsOn": []},
            {"id": "g3", "title": "", "linkedRootId": "r", "dependsOn": []}
        ]);
        let mk = |steps: Vec<Value>| json!({"goal": "", "groups": groups, "steps": steps});
        let d = mk(vec![
            member("a", "done"),
            member("b", "active"),
            last.clone(),
        ]);
        assert!(run(&d, &[]).is_empty());
        let d = mk(vec![member("a", "done"), member("b", "done"), last]);
        assert_eq!(run(&d, &[]).would_start, ["s9"]);
        // 빈 그룹·다른 스레드에 이어진 그룹은 끝난 것으로 치지 않는다.
        for g in ["g2", "g3"] {
            let s = with(
                step("s1", "pending", vec![], &[g]),
                "assigneeId",
                json!(AGENT),
            );
            assert!(run(&mk(vec![s]), &[]).is_empty());
        }
    }

    #[test]
    fn cap_truncates_in_document_order() {
        let d = doc((0..5)
            .map(|i| step(&format!("s{i}"), "active", vec![card("c1")], &[]))
            .collect());
        let v = judge(&d, &cards(&[("c1", Card::Open)]), &agents(), 3);
        assert_eq!(v.would_block, ["s0", "s1", "s2"]);
        assert!(v.truncated);
        let v = judge(&d, &cards(&[("c1", Card::Open)]), &agents(), 5);
        assert_eq!(v.len(), 5);
        assert!(!v.truncated);
    }

    #[test]
    fn malformed_doc_yields_nothing() {
        for d in [
            json!(null),
            json!({}),
            json!({"steps": "x"}),
            json!({"steps": [1, {"id": "s"}]}),
        ] {
            assert!(run(&d, &[("c1", Card::Open)]).is_empty());
            assert!(card_ids(&d).is_empty() && assignee_ids(&d).is_empty());
        }
    }
}
