//! 계획 진행 판정(K1, 그림자)의 순수 함수 — 계획 문서 한 장과 「카드 상태·에이전트 계정」을 받아, 서버가 손을 댄다면
//! 무엇을 했을지를 낸다. I/O 가 없고 문서를 고치지 않는다. 부르는 곳은 `loops::plan_progress` 하나다(수만 기록한다).
//!
//! 판정 셋:
//! - `would_block` — 단계의 `links` 에 사람이 답할 카드(`kind: "card"`)가 달려 있고 그중 하나라도 아직 열려 있는데, 단계가
//!   `pending`·`active` 다.
//! - `would_unblock` — 단계가 `blocked` 이고, 달린 카드 중 열린 것이 없으며 하나 이상이 **답으로** 닫혔다.
//! - `would_start` — 단계가 `pending` 이고 담당(`assigneeId`)이 에이전트이며, `dependsOn` 이 모두 끝났고 열린 카드가 없다.
//!
//! 멈춤 판정([`judge_stall`], s64 그림자) — `active` 단계인데 아무도 움직이지 않는 것을 센다:
//! - `quiet` — 담당(단계 → 없으면 그룹)이 에이전트이고, 그 단계에 **신호가 하나도 없다**. 신호는 열린 카드(단계 `links`),
//!   열린 위임, 살아 있는 턴 임대, 걸린 예약, 열린 PR 감시다([`Signals`]).
//! - `would_stall` — `quiet` 이면서 담당이 그 스레드에 정해진 시간 안에 쓴 글도 없다([`Signals::recent`]).
//!
//! 사람 담당·담당 없는 단계·다른 스레드에 이어진 그룹의 단계는 판정하지 않는다. 단계가 `active` 로 바뀐 시각은 문서에 없어서
//! 방금 바뀐 단계와 오래된 단계를 가르지 못한다(단계별 시계는 뒤 단계의 몫이다).
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

/// 한 스레드의 멈춤 판정 신호 — 계정 id 는 소문자.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Signals {
    /// 단계가 적힌 열린 위임 — (담당, 단계 id). 그 단계만의 신호다.
    pub step_delegations: HashSet<(String, String)>,
    /// 단계가 안 적힌 열린 위임이 있는 담당. 어느 단계 것인지 모르므로 그 담당의 `active` 단계 모두의 신호로 친다.
    pub loose_delegations: HashSet<String>,
    /// 살아 있는 턴 임대·걸린 예약·열린 PR 감시가 있는 담당. 단계를 가를 수 없는 신호다 — 그 담당에게 단계가 적힌 열린
    /// 위임이 있으면 그 단계 것으로 보고, 없으면 그 담당의 `active` 단계 모두의 신호로 친다.
    pub turns: HashSet<String>,
    /// 정해진 시간 안에 이 스레드에 글을 쓴 담당.
    pub recent: HashSet<String>,
}

/// 한 계획의 멈춤 판정 — 단계 id 들(문서의 단계 순서). `would_stall` 은 `quiet` 의 부분집합이다.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Stall {
    pub quiet: Vec<String>,
    pub would_stall: Vec<String>,
    /// 상한에 걸려 뒤 단계의 판정을 버렸다.
    pub truncated: bool,
}

impl Stall {
    /// (조용함, 멈춤) 수.
    pub fn counts(&self) -> (usize, usize) {
        (self.quiet.len(), self.would_stall.len())
    }
}

/// 단계의 담당(소문자) — 단계에 없으면 그룹 것을 물려받는다. 다른 스레드에 이어진 그룹의 단계는 담당이 없는 것으로 본다.
fn step_assignee(doc: &Value, step: &Value) -> Option<String> {
    let group = step["groupId"].as_str().and_then(|g| {
        doc["groups"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|x| x["id"].as_str() == Some(g))
    });
    if group.is_some_and(|g| g.get("linkedRootId").is_some_and(|v| !v.is_null())) {
        return None;
    }
    step["assigneeId"]
        .as_str()
        .or_else(|| group.and_then(|g| g["assigneeId"].as_str()))
        .map(str::to_lowercase)
}

/// `active` 단계와 그 담당 — (단계 id, 담당 id). 담당이 없는 단계는 빠진다. 문서 순서.
pub fn active_steps(doc: &Value) -> Vec<(String, String)> {
    steps(doc)
        .iter()
        .filter(|s| s["state"].as_str() == Some("active"))
        .filter_map(|s| Some((s["id"].as_str()?.to_string(), step_assignee(doc, s)?)))
        .collect()
}

/// 계획 한 장의 멈춤을 판정한다. `cards`·`agents` 는 [`judge`] 와 같고, `signals` 는 이 스레드 것이다.
/// `quiet` 은 `cap` 개까지만 낸다(넘으면 `truncated`).
pub fn judge_stall(
    doc: &Value,
    cards: &HashMap<String, Card>,
    agents: &HashSet<String>,
    signals: &Signals,
    cap: usize,
) -> Stall {
    let active = active_steps(doc);
    let mut out = Stall::default();
    for (id, who) in &active {
        if !agents.contains(who) {
            continue;
        }
        let open_card = steps(doc)
            .iter()
            .find(|s| s["id"].as_str() == Some(id))
            .is_some_and(|s| step_cards(s).any(|c| cards.get(&c) == Some(&Card::Open)));
        let own = signals
            .step_delegations
            .contains(&(who.clone(), id.clone()));
        // 이 담당의 다른 `active` 단계에 단계가 적힌 열린 위임이 있으면, 가를 수 없는 신호는 그 단계 것이다.
        let elsewhere = active.iter().any(|(other, w)| {
            w == who
                && other != id
                && signals
                    .step_delegations
                    .contains(&(w.clone(), other.clone()))
        });
        let shared =
            signals.loose_delegations.contains(who) || (!elsewhere && signals.turns.contains(who));
        if open_card || own || shared {
            continue;
        }
        if out.quiet.len() >= cap {
            out.truncated = true;
            break;
        }
        out.quiet.push(id.clone());
        if !signals.recent.contains(who) {
            out.would_stall.push(id.clone());
        }
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

    fn agent_step(id: &str, state: &str, links: Vec<Value>) -> Value {
        with(step(id, state, links, &[]), "assigneeId", json!(AGENT))
    }

    fn stall(d: &Value, c: &[(&str, Card)], s: &Signals) -> Stall {
        judge_stall(d, &cards(c), &agents(), s, 100)
    }

    fn who() -> HashSet<String> {
        HashSet::from([AGENT.to_string()])
    }

    #[test]
    fn active_agent_step_without_signal_is_quiet_and_would_stall() {
        let d = doc(vec![
            agent_step("s1", "active", vec![]),
            agent_step("s2", "pending", vec![]),
            agent_step("s3", "blocked", vec![]),
            agent_step("s4", "done", vec![]),
        ]);
        let v = stall(&d, &[], &Signals::default());
        assert_eq!(v.quiet, ["s1"]);
        assert_eq!(v.would_stall, ["s1"]);
        assert_eq!(v.counts(), (1, 1));
    }

    #[test]
    fn recent_writing_keeps_a_quiet_step_from_stalling() {
        let d = doc(vec![agent_step("s1", "active", vec![])]);
        let s = Signals {
            recent: who(),
            ..Signals::default()
        };
        let v = stall(&d, &[], &s);
        assert_eq!(v.counts(), (1, 0));
    }

    #[test]
    fn human_and_unassigned_active_steps_are_not_judged() {
        let d = doc(vec![
            with(
                step("s1", "active", vec![], &[]),
                "assigneeId",
                json!(HUMAN),
            ),
            step("s2", "active", vec![], &[]),
        ]);
        assert_eq!(stall(&d, &[], &Signals::default()), Stall::default());
        assert_eq!(active_steps(&d), [("s1".to_string(), HUMAN.to_string())]);
    }

    #[test]
    fn each_signal_alone_keeps_the_step_from_being_quiet() {
        let d = doc(vec![agent_step("s1", "active", vec![card("c1")])]);
        let none = Signals::default();
        // 열린 카드만 신호다 — 답했거나 답 없이 닫힌 카드는 아니다.
        assert_eq!(stall(&d, &[("c1", Card::Open)], &none).counts(), (0, 0));
        assert_eq!(stall(&d, &[("c1", Card::Answered)], &none).counts(), (1, 1));
        assert_eq!(stall(&d, &[("c1", Card::Closed)], &none).counts(), (1, 1));
        let own = Signals {
            step_delegations: HashSet::from([(AGENT.to_string(), "s1".to_string())]),
            ..Signals::default()
        };
        let loose = Signals {
            loose_delegations: who(),
            ..Signals::default()
        };
        let turns = Signals {
            turns: who(),
            ..Signals::default()
        };
        for s in [own, loose, turns] {
            assert_eq!(stall(&d, &[], &s).counts(), (0, 0), "{s:?}");
        }
    }

    #[test]
    fn step_delegation_does_not_hide_the_assignees_other_steps() {
        let d = doc(vec![
            agent_step("s1", "active", vec![]),
            agent_step("s2", "active", vec![]),
        ]);
        // s2 에 단계가 적힌 열린 위임이 있고 턴도 돈다 — 그 턴은 s2 것이라 s1 은 조용하다.
        let s = Signals {
            step_delegations: HashSet::from([(AGENT.to_string(), "s2".to_string())]),
            turns: who(),
            recent: who(),
            ..Signals::default()
        };
        let v = stall(&d, &[], &s);
        assert_eq!(v.quiet, ["s1"]);
        assert!(v.would_stall.is_empty());
        // 단계를 모르는 위임은 둘 다 가린다.
        let s = Signals {
            loose_delegations: who(),
            ..s
        };
        assert_eq!(stall(&d, &[], &s).counts(), (0, 0));
        // 단계가 적힌 위임이 없으면 가를 수 없는 신호는 둘 다의 것이다.
        let s = Signals {
            turns: who(),
            ..Signals::default()
        };
        assert_eq!(stall(&d, &[], &s).counts(), (0, 0));
        // 끝난 단계에 적힌 위임은 다른 단계의 신호를 뺏지 않는다.
        let d = doc(vec![
            agent_step("s1", "active", vec![]),
            agent_step("s2", "done", vec![]),
        ]);
        let s = Signals {
            step_delegations: HashSet::from([(AGENT.to_string(), "s2".to_string())]),
            turns: who(),
            ..Signals::default()
        };
        assert_eq!(stall(&d, &[], &s).counts(), (0, 0));
    }

    #[test]
    fn another_accounts_signals_do_not_count() {
        let d = doc(vec![agent_step("s1", "active", vec![])]);
        let other = HashSet::from([HUMAN.to_string()]);
        let s = Signals {
            step_delegations: HashSet::from([(HUMAN.to_string(), "s1".to_string())]),
            loose_delegations: other.clone(),
            turns: other.clone(),
            recent: other,
        };
        assert_eq!(stall(&d, &[], &s).counts(), (1, 1));
    }

    #[test]
    fn group_assignee_is_inherited_and_linked_groups_are_skipped() {
        let groups = json!([
            {"id": "g1", "title": "", "assigneeId": AGENT.to_uppercase(), "dependsOn": []},
            {"id": "g2", "title": "", "assigneeId": AGENT, "linkedRootId": "r", "dependsOn": []},
            {"id": "g3", "title": "", "assigneeId": HUMAN, "dependsOn": []}
        ]);
        let in_group =
            |id: &str, g: &str| with(step(id, "active", vec![], &[]), "groupId", json!(g));
        let d = json!({"goal": "", "groups": groups, "steps": [
            in_group("s1", "g1"),
            in_group("s2", "g2"),
            in_group("s3", "g3"),
            with(in_group("s4", "g3"), "assigneeId", json!(AGENT)),
        ]});
        assert_eq!(stall(&d, &[], &Signals::default()).quiet, ["s1", "s4"]);
    }

    #[test]
    fn stall_cap_truncates_in_document_order() {
        let d = doc((0..4)
            .map(|i| agent_step(&format!("s{i}"), "active", vec![]))
            .collect());
        let v = judge_stall(&d, &cards(&[]), &agents(), &Signals::default(), 2);
        assert_eq!(v.quiet, ["s0", "s1"]);
        assert!(v.truncated);
        let v = judge_stall(&d, &cards(&[]), &agents(), &Signals::default(), 4);
        assert_eq!(v.counts(), (4, 4));
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
            assert!(active_steps(&d).is_empty());
            assert_eq!(stall(&d, &[], &Signals::default()), Stall::default());
        }
    }
}
