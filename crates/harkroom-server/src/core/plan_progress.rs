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
//! 사람 담당·담당 없는 단계·다른 스레드에 이어진 그룹의 단계는 판정하지 않는다.
//!
//! 단계별 조용함 시계([`Clock`], s65) — 단계가 `active` 로 바뀐 시각은 문서에 없어서, 루프가 그 단계를 `active` 로 처음 본 때부터
//! 잰다([`tick_clock`]). 시계가 있으면 멈춤은 「신호 없음 + 담당의 최근 글 없음 + 시계가 정해진 시간을 넘김」이다.
//! 신호가 보이면 시계는 다시 시작한다. 관리자를 깨운 표시(`wokenAt`)는 단계가 `active` 를 벗어날 때까지 남는다 — 한 단계는
//! `active` 로 있는 동안 한 번만 깨운다([`wake_due`]).
//!
//! 건드리지 않는 것:
//! - 카드가 안 달린 단계의 막힘·풀림(손으로 막은 단계는 손으로 푼다). 모르는 카드(지워졌거나 답할 카드가 아님)는 없는 것으로 본다.
//! - 답 없이 닫힌 카드(만료·대체)만 달린 `blocked` 단계 — 풀지 않는다.
//! - `done` 단계.
use serde_json::Value;
use serde_json::json;
use std::collections::{BTreeMap, HashMap, HashSet};

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
    /// 열린 위임이 적힌 단계 id — 그 위임이 **누구에게 갔든** 그 단계의 신호다(담당이 남에게 넘긴 일도 움직이는 중이다).
    pub step_open: HashSet<String>,
    /// 단계가 안 적힌 열린 위임이 있는 담당. 어느 단계 것인지 모르므로 그 담당의 `active` 단계 모두의 신호로 친다.
    pub loose_delegations: HashSet<String>,
    /// 살아 있는 턴 임대·걸린 예약·열린 PR 감시가 있는 담당. 단계를 가를 수 없는 신호다 — 그 담당에게 단계가 적힌 열린
    /// 위임이 있으면 그 단계 것으로 보고, 없으면 그 담당의 `active` 단계 모두의 신호로 친다.
    pub turns: HashSet<String>,
    /// 이 스레드에 자기가 세운 열린 카드(권한 카드 제외)가 있는 담당 — 사람 답을 기다리는 중이다. 카드가 어느 단계 것인지는
    /// 모르므로 그 담당의 `active` 단계 모두의 신호로 친다.
    pub asking: HashSet<String>,
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

/// 판정 대상 단계 하나 — 에이전트가 맡은 `active` 단계.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StepView {
    pub id: String,
    /// 담당(소문자).
    pub who: String,
    /// 신호가 하나라도 있다([`Signals`] 와 단계에 달린 열린 카드).
    pub signal: bool,
    /// 담당이 정해진 시간 안에 이 스레드에 글을 썼다.
    pub recent: bool,
}

/// 에이전트가 맡은 `active` 단계마다 신호를 본다(문서 순서). `cards`·`agents` 는 [`judge`] 와 같고, `signals` 는 이 스레드 것이다.
pub fn stall_views(
    doc: &Value,
    cards: &HashMap<String, Card>,
    agents: &HashSet<String>,
    signals: &Signals,
) -> Vec<StepView> {
    let active = active_steps(doc);
    let mut out = vec![];
    for (id, who) in &active {
        if !agents.contains(who) {
            continue;
        }
        let open_card = steps(doc)
            .iter()
            .find(|s| s["id"].as_str() == Some(id))
            .is_some_and(|s| step_cards(s).any(|c| cards.get(&c) == Some(&Card::Open)));
        let own = signals.step_open.contains(id)
            || signals
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
        let shared = signals.loose_delegations.contains(who)
            || signals.asking.contains(who)
            || (!elsewhere && signals.turns.contains(who));
        out.push(StepView {
            id: id.clone(),
            who: who.clone(),
            signal: open_card || own || shared,
            recent: signals.recent.contains(who),
        });
    }
    out
}

/// 계획 한 장의 멈춤을 판정한다 — 시계 없이(신호와 최근 글만). `quiet` 은 `cap` 개까지만 낸다(넘으면 `truncated`).
pub fn judge_stall(
    doc: &Value,
    cards: &HashMap<String, Card>,
    agents: &HashSet<String>,
    signals: &Signals,
    cap: usize,
) -> Stall {
    stall_of(&stall_views(doc, cards, agents, signals), None, cap)
}

/// 단계 보기 → 판정. `clock` 이 있으면(시계, 지금, 멈춤으로 볼 초) 시계가 그 초를 넘긴 단계만 멈춤이다.
pub fn stall_of(views: &[StepView], clock: Option<(&Clock, i64, i64)>, cap: usize) -> Stall {
    let mut out = Stall::default();
    for v in views.iter().filter(|v| !v.signal) {
        if out.quiet.len() >= cap {
            out.truncated = true;
            break;
        }
        out.quiet.push(v.id.clone());
        let long = clock.is_none_or(|(c, now, after)| {
            c.steps
                .get(&v.id)
                .is_some_and(|s| now - s.quiet_at >= after)
        });
        if long && !v.recent {
            out.would_stall.push(v.id.clone());
        }
    }
    out
}

/// 시계가 이 초보다 오래 안 보였으면(스위치를 껐다 켰거나 계획이 창 밖에 있었다) 버리고 새로 잰다.
pub const CLOCK_STALE_SEC: i64 = 3600;
/// 시계를 다시 적는 최소 간격 — 본 때(`seenAt`)와 신호가 있는 단계의 시각은 이 간격으로만 고쳐 쓴다(tick 마다 쓰지 않게).
pub const CLOCK_WRITE_SEC: i64 = 600;

/// 단계 하나의 시계(epoch 초).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StepClock {
    /// 이때부터 신호가 없다 — `active` 로 처음 본 때, 또는 마지막으로 신호를 본 때.
    pub quiet_at: i64,
    /// 루프가 이 단계를 멈춤으로 판정하기 시작한 때. 멈춤이 아니게 되면 지워진다 — 읽는 쪽은 이 표시만 본다.
    pub marked_at: Option<i64>,
    /// 이 단계로 관리자를 깨운 때. 단계가 `active` 를 벗어나면 지워진다.
    pub woken_at: Option<i64>,
}

/// 계획 한 장의 조용함 시계 — `thread_plan.stall` 칸.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Clock {
    /// 루프가 이 계획을 마지막으로 본 때(0 = 아직 없음).
    pub seen_at: i64,
    /// 이 계획으로 관리자를 마지막으로 깨운 때.
    pub last_woken_at: Option<i64>,
    pub steps: BTreeMap<String, StepClock>,
}

impl Clock {
    /// 칸 값 → 시계. 모양이 틀린 것은 없는 것으로 읽는다.
    pub fn parse(v: &Value) -> Self {
        let steps = v["steps"]
            .as_object()
            .into_iter()
            .flatten()
            .filter_map(|(id, s)| {
                Some((
                    id.clone(),
                    StepClock {
                        quiet_at: s["quietAt"].as_i64()?,
                        marked_at: s["markedAt"].as_i64(),
                        woken_at: s["wokenAt"].as_i64(),
                    },
                ))
            })
            .collect();
        Self {
            seen_at: v["seenAt"].as_i64().unwrap_or(0),
            last_woken_at: v["lastWokenAt"].as_i64(),
            steps,
        }
    }

    pub fn to_json(&self) -> Value {
        let steps: serde_json::Map<String, Value> = self
            .steps
            .iter()
            .map(|(id, s)| {
                let mut o = json!({ "quietAt": s.quiet_at });
                if let Some(m) = s.marked_at {
                    o["markedAt"] = json!(m);
                }
                if let Some(w) = s.woken_at {
                    o["wokenAt"] = json!(w);
                }
                (id.clone(), o)
            })
            .collect();
        let mut o = json!({ "seenAt": self.seen_at, "steps": steps });
        if let Some(w) = self.last_woken_at {
            o["lastWokenAt"] = json!(w);
        }
        o
    }

    /// 루프가 최근에 본 시계인가 — 아니면 그 안의 시각은 믿지 않는다.
    pub fn live(&self, now: i64) -> bool {
        self.seen_at > 0 && now - self.seen_at <= CLOCK_STALE_SEC
    }
}

/// 시계를 한 번 돌린다 — (새 시계, 칸을 다시 써야 하나). `views` 는 지금 판정 대상인 단계 전부다.
/// - 낡은 시계(`!live`)는 버린다: 모든 단계가 지금부터다. 스위치를 켠 순간 이미 `active` 인 단계도 그렇게 켠 때부터 잰다.
/// - 처음 보는 단계는 지금부터. 신호가 있는 단계는 지금으로 다시([`CLOCK_WRITE_SEC`] 간격으로만). 대상에서 빠진 단계는 지운다.
pub fn tick_clock(prev: &Clock, now: i64, views: &[StepView]) -> (Clock, bool) {
    let live = prev.live(now);
    let mut next = Clock {
        seen_at: prev.seen_at,
        last_woken_at: prev.last_woken_at.filter(|_| live),
        steps: BTreeMap::new(),
    };
    let mut dirty = !live && (prev.seen_at != 0 || !prev.steps.is_empty());
    for v in views {
        let fresh = StepClock {
            quiet_at: now,
            marked_at: None,
            woken_at: None,
        };
        let step = match prev.steps.get(&v.id).filter(|_| live) {
            None => {
                dirty = true;
                fresh
            }
            // 앞으로 간 시각(시계가 뒤로 돌았다)은 지금으로 고친다.
            Some(s) if s.quiet_at > now || (v.signal && now - s.quiet_at >= CLOCK_WRITE_SEC) => {
                dirty = true;
                StepClock {
                    quiet_at: now,
                    marked_at: None,
                    woken_at: s.woken_at,
                }
            }
            Some(s) => *s,
        };
        next.steps.insert(v.id.clone(), step);
    }
    if live && next.steps.len() != prev.steps.len() {
        dirty = true;
    }
    // 대상 단계가 없고 적을 것도 없으면 본 때를 남기지 않는다(판정할 것이 없는 계획은 쓰지 않는다).
    if next.steps.is_empty() {
        if dirty {
            next.seen_at = 0;
            next.last_woken_at = None;
        }
        return (next, dirty);
    }
    if dirty || now - prev.seen_at >= CLOCK_WRITE_SEC || prev.seen_at > now {
        next.seen_at = now;
        dirty = true;
    }
    (next, dirty)
}

/// 이번에 관리자를 깨울 단계 — 멈춘 단계 중 아직 안 깨운 것. 한 계획은 `after_sec` 에 한 번만 깨운다(그 사이 새로 멈춘 단계는
/// 다음 차례에 묶인다).
pub fn wake_due(clock: &Clock, stalled: &[String], now: i64, after_sec: i64) -> Vec<String> {
    if clock
        .last_woken_at
        .is_some_and(|at| at <= now && now - at < after_sec)
    {
        return vec![];
    }
    stalled
        .iter()
        .filter(|id| clock.steps.get(*id).is_some_and(|s| s.woken_at.is_none()))
        .cloned()
        .collect()
}

/// 멈춤 표시를 판정에 맞춘다 — 멈춘 단계에는 표시를(처음 값을 지킨다), 아닌 단계에서는 지운다. 바뀌었으면 `true`.
pub fn mark_stalled(clock: &mut Clock, stalled: &[String], now: i64) -> bool {
    let mut changed = false;
    for (id, s) in clock.steps.iter_mut() {
        let on = stalled.contains(id);
        if on != s.marked_at.is_some() {
            s.marked_at = on.then_some(now);
            changed = true;
        }
    }
    changed
}

/// 깨운 표시를 적는다.
pub fn mark_woken(clock: &mut Clock, ids: &[String], now: i64) {
    for id in ids {
        if let Some(s) = clock.steps.get_mut(id) {
            s.woken_at = Some(now);
        }
    }
    clock.last_woken_at = Some(now);
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
            asking: other.clone(),
            recent: other,
            ..Signals::default()
        };
        assert_eq!(stall(&d, &[], &s).counts(), (1, 1));
    }

    #[test]
    fn open_delegation_on_the_step_counts_whoever_holds_it() {
        // 담당이 그 단계 일을 남에게 넘겼다 — 담당 자신에게 열린 위임은 없지만 단계는 움직이는 중이다.
        let d = doc(vec![
            agent_step("s1", "active", vec![]),
            agent_step("s2", "active", vec![]),
        ]);
        let s = Signals {
            step_open: HashSet::from(["s1".to_string()]),
            ..Signals::default()
        };
        assert_eq!(stall(&d, &[], &s).quiet, ["s2"]);
    }

    #[test]
    fn assignees_own_open_card_in_the_thread_covers_its_active_steps() {
        let d = doc(vec![
            agent_step("s1", "active", vec![]),
            agent_step("s2", "active", vec![]),
        ]);
        let s = Signals {
            asking: who(),
            ..Signals::default()
        };
        assert_eq!(stall(&d, &[], &s).counts(), (0, 0));
    }

    fn view(id: &str, signal: bool, recent: bool) -> StepView {
        StepView {
            id: id.to_string(),
            who: AGENT.to_string(),
            signal,
            recent,
        }
    }

    const H: i64 = 3600;
    const T0: i64 = 1_000_000;

    #[test]
    fn a_step_just_seen_active_is_not_stalled_until_the_clock_runs_out() {
        let views = [view("s1", false, false)];
        // 처음 본다(스위치를 방금 켰거나 방금 active 로 바뀌었다) — 지금부터 잰다.
        let (c, dirty) = tick_clock(&Clock::default(), T0, &views);
        assert!(dirty);
        assert_eq!(c.steps["s1"].quiet_at, T0);
        assert_eq!(c.seen_at, T0);
        let v = stall_of(&views, Some((&c, T0, 6 * H)), 20);
        assert_eq!(v.counts(), (1, 0));
        // 시간이 다 가기 전에는 멈춤이 아니고, 넘기면 멈춤이다.
        let (c1, _) = tick_clock(&c, T0 + 300, &views);
        assert_eq!(c1, c, "쓸 것이 없으면 그대로");
        let mut c = c;
        for t in (T0..T0 + 6 * H).step_by(600) {
            c = tick_clock(&c, t, &views).0;
            assert_eq!(stall_of(&views, Some((&c, t, 6 * H)), 20).counts(), (1, 0));
        }
        let t = T0 + 6 * H;
        c = tick_clock(&c, t, &views).0;
        assert_eq!(c.steps["s1"].quiet_at, T0);
        assert_eq!(
            stall_of(&views, Some((&c, t, 6 * H)), 20).would_stall,
            ["s1"]
        );
        // 담당이 최근에 썼으면 시계가 넘어도 멈춤이 아니다.
        let wrote = [view("s1", false, true)];
        assert_eq!(stall_of(&wrote, Some((&c, t, 6 * H)), 20).counts(), (1, 0));
    }

    #[test]
    fn a_signal_restarts_the_clock_and_a_step_leaving_active_drops_it() {
        let quiet = [view("s1", false, false)];
        let busy = [view("s1", true, false)];
        let (c, _) = tick_clock(&Clock::default(), T0, &quiet);
        // 신호가 있어도 간격 안에서는 다시 쓰지 않는다.
        let (c1, dirty) = tick_clock(&c, T0 + 60, &busy);
        assert!(!dirty);
        assert_eq!(c1.steps["s1"].quiet_at, T0);
        let (c2, dirty) = tick_clock(&c1, T0 + CLOCK_WRITE_SEC, &busy);
        assert!(dirty);
        assert_eq!(c2.steps["s1"].quiet_at, T0 + CLOCK_WRITE_SEC);
        // 신호가 5시간 이어지다 끊겼다 — 끊긴 뒤부터 6시간이다.
        let mut c = c2;
        let end = T0 + 5 * H;
        for t in (c.seen_at..=end).step_by(600) {
            c = tick_clock(&c, t, &busy).0;
        }
        let last = c.steps["s1"].quiet_at;
        assert!(end - last < CLOCK_WRITE_SEC);
        let mut t = end;
        while t < last + 6 * H {
            c = tick_clock(&c, t, &quiet).0;
            assert_eq!(stall_of(&quiet, Some((&c, t, 6 * H)), 20).counts(), (1, 0));
            t += 600;
        }
        c = tick_clock(&c, t, &quiet).0;
        let v = stall_of(&quiet, Some((&c, t, 6 * H)), 20);
        assert_eq!(v.counts(), (1, 1));
        // 멈춤 표시는 처음 값을 지키고, 신호가 오면 지워진다.
        assert!(mark_stalled(&mut c, &v.would_stall, t));
        assert!(!mark_stalled(&mut c, &v.would_stall, t + 60));
        assert_eq!(c.steps["s1"].marked_at, Some(t));
        let back = tick_clock(&c, t + 60, &busy).0;
        assert_eq!(back.steps["s1"].marked_at, None);
        assert!(mark_stalled(&mut c, &[], t + 60));
        assert_eq!(c.steps["s1"].marked_at, None);
        // 단계가 대상에서 빠지면(끝남·막힘·담당 바뀜) 시계도 지운다. 다시 active 가 되면 그때부터다.
        let (gone, dirty) = tick_clock(&c, t + 60, &[]);
        assert!(dirty && gone.steps.is_empty());
        assert_eq!(gone.seen_at, 0);
        let (again, _) = tick_clock(&gone, t + 120, &quiet);
        assert_eq!(again.steps["s1"].quiet_at, t + 120);
        // 대상이 없고 시계도 비었으면 쓰지 않는다.
        assert_eq!(
            tick_clock(&Clock::default(), T0, &[]),
            (Clock::default(), false)
        );
    }

    #[test]
    fn a_stale_clock_is_thrown_away() {
        let views = [view("s1", false, false)];
        let (mut c, _) = tick_clock(&Clock::default(), T0, &views);
        mark_woken(&mut c, &["s1".to_string()], T0);
        // 한 시간 넘게 안 보였다(스위치를 껐다 켰다) — 옛 시각과 깨운 표시를 버리고 지금부터 다시 잰다.
        let t = T0 + 30 * H;
        let (c2, dirty) = tick_clock(&c, t, &views);
        assert!(dirty);
        assert_eq!(
            c2.steps["s1"],
            StepClock {
                quiet_at: t,
                marked_at: None,
                woken_at: None
            }
        );
        assert_eq!(c2.last_woken_at, None);
        assert_eq!(stall_of(&views, Some((&c2, t, 6 * H)), 20).counts(), (1, 0));
        // 앞으로 간 시각은 지금으로 고친다.
        let mut ahead = c2.clone();
        ahead.steps.get_mut("s1").unwrap().quiet_at = t + 900;
        assert_eq!(
            tick_clock(&ahead, t + 60, &views).0.steps["s1"].quiet_at,
            t + 60
        );
    }

    #[test]
    fn manager_is_woken_once_per_step_and_once_per_window_per_plan() {
        let views = [view("s1", false, false), view("s2", false, false)];
        let (mut c, _) = tick_clock(&Clock::default(), T0, &[view("s1", false, false)]);
        c = tick_clock(&c, T0 + 600, &views).0;
        let t = T0 + 6 * H;
        c = tick_clock(&c, t, &views).0;
        let stalled = stall_of(&views, Some((&c, t, 6 * H)), 20).would_stall;
        assert_eq!(stalled, ["s1"]);
        assert_eq!(wake_due(&c, &stalled, t, 6 * H), ["s1"]);
        mark_woken(&mut c, &["s1".to_string()], t);
        assert_eq!(c.steps["s1"].woken_at, Some(t));
        // 10분 뒤 s2 도 멈췄다 — 이 계획은 방금 깨웠으니 기다린다. s1 은 다시 깨우지 않는다.
        let t2 = t + 600;
        c = tick_clock(&c, t2, &views).0;
        let stalled = stall_of(&views, Some((&c, t2, 6 * H)), 20).would_stall;
        assert_eq!(stalled, ["s1", "s2"]);
        assert!(wake_due(&c, &stalled, t2, 6 * H).is_empty());
        let t3 = t + 6 * H;
        assert_eq!(wake_due(&c, &stalled, t3, 6 * H), ["s2"]);
        mark_woken(&mut c, &["s2".to_string()], t3);
        assert!(wake_due(&c, &stalled, t3 + 100 * H, 6 * H).is_empty());
        // 신호가 왔다 가도 깨운 표시는 남는다 — active 로 있는 동안 한 번이다.
        let busy = [view("s1", true, false), view("s2", false, false)];
        let c4 = tick_clock(&c, t3 + 600, &busy).0;
        assert_eq!(c4.steps["s1"].quiet_at, t3 + 600);
        assert_eq!(c4.steps["s1"].woken_at, Some(t));
    }

    #[test]
    fn clock_round_trips_and_reads_garbage_as_empty() {
        let mut c = tick_clock(&Clock::default(), T0, &[view("s1", false, false)]).0;
        assert_eq!(
            c.to_json(),
            json!({"seenAt": T0, "steps": {"s1": {"quietAt": T0}}})
        );
        mark_woken(&mut c, &["s1".to_string()], T0 + 5);
        assert_eq!(Clock::parse(&c.to_json()), c);
        for bad in [
            json!(null),
            json!({}),
            json!([1]),
            json!({"steps": {"s1": {"quietAt": "x"}}}),
        ] {
            assert_eq!(Clock::parse(&bad), Clock::default());
        }
        assert!(!Clock::default().live(T0));
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
