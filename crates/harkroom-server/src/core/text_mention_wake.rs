//! C2 — **글자 멘션 깨움 걷기**. 에이전트가 쓴 글 본문의 `@handle` 은 에이전트를 깨우지 않는다(inbox 항목·깨움·회신권·암묵 위임을
//! 만들지 않는다). 에이전트가 에이전트를 부르는 길은 `agent.call` 도구다.
//!
//! - 스위치 `HARKROOM_TEXT_MENTION_WAKE` — `off`·`0`·`false` 일 때만 걷는다. 없거나 그 밖의 값이면 지금 동작 그대로다
//!   ([`apply`] 가 아무것도 건드리지 않는다).
//! - 판정은 순수 함수 [`wakes`] 하나다(저자 종류·대상 종류·글이 생긴 길 → 깨움 여부).
//! - **새 길을 열지 않는다** — 호출 게이트([`super::mention_calls::resolve`])가 이미 정한 부름에서 **빼기만** 한다.
//! - 걷은 멘션은 C1 경고(`mention_not_called`, 이유 [`REASON`])로 부른 쪽에 돌아가고, 건수는 `measure_event` 에 갈래·수만 남는다.
use super::mention_calls::Resolved;
use super::mention_parse::TargetKind;

/// 걷은 멘션의 경고 이유(`warnings[].reason`).
pub const REASON: &str = "text_mention_off";

/// 글쓴이 종류.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Author {
    Human,
    Agent,
}

/// 멘션 대상 종류.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Callee {
    Human,
    Agent,
    /// 팀 — 팀원은 에이전트뿐이다.
    Team,
}

/// 글이 생긴 길.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    /// 본문을 글쓴이가 그대로 적은 글(`message.post`·`progress`·`turn.wake`·REST).
    Text,
    /// 도구가 만든 호출 — `agent.call`·`message.delegate`·`message.ask`·`message.report`/`fail`·서버 안쪽 서비스 호출(자동화 포함).
    Tool,
    /// 시스템 줄·서버 알림 줄·계획 자동 진행 깨움.
    System,
}

/// 스위치 — `off`·`0`·`false` 만 걷음(참). 없거나 모르는 값이면 거짓(지금 동작).
pub fn stripped(raw: Option<&str>) -> bool {
    let v = raw.unwrap_or("").trim().to_lowercase();
    v == "off" || v == "0" || v == "false"
}

/// 이 멘션이 대상을 깨우는가. `off` 는 [`stripped`] 결과다. 걷는 것은 「에이전트가 글자로 적은 에이전트·팀 멘션」 하나뿐이다.
pub fn wakes(off: bool, author: Author, callee: Callee, route: Route) -> bool {
    !(off && author == Author::Agent && callee != Callee::Human && route == Route::Text)
}

/// 걷은 것 — 갈래별 수.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Stripped {
    pub accounts: usize,
    pub teams: usize,
}

/// 판정([`wakes`])대로 부름에서 에이전트 계정·팀을 뺀다. 사람 계정 부름은 그대로다. 뺀 계정은 `missed_handles` 에 [`REASON`] 으로 싣는다
/// (게이트가 이미 막은 계정·글쓴이 자신은 싣지 않는다 — 앞의 것은 이미 `gate_denied` 경고가 있다).
/// 뒤따르는 inbox 넣기·회신권·암묵 위임은 모두 `called_ids`·`team_plans`·`target_call` 만 보므로 뺀 대상에는 아무것도 서지 않는다.
pub fn apply(
    off: bool,
    author: Author,
    route: Route,
    author_id: &str,
    r: &mut Resolved,
) -> Stripped {
    let mut out = Stripped::default();
    if !wakes(off, author, Callee::Agent, route) {
        let agents: Vec<(String, String)> = std::mem::take(&mut r.called_agents);
        r.called_ids
            .retain(|id| !agents.iter().any(|(a, _)| a == id));
        for (id, handle) in &agents {
            if id == author_id || r.denied_ids.contains(id) {
                continue;
            }
            out.accounts += 1;
            if !r.missed_handles.iter().any(|(h, _)| h == handle) {
                r.missed_handles.push((handle.clone(), REASON));
            }
        }
    }
    if !wakes(off, author, Callee::Team, route) {
        let before = r.target_call.len();
        r.target_call.retain(|t| t.kind != TargetKind::Team);
        out.teams = before - r.target_call.len();
        r.team_plans.clear();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::mention_calls::TeamPlan;
    use crate::core::mention_parse::Target;
    use std::collections::HashSet;

    #[test]
    fn switch_default_keeps_behavior() {
        for keep in [
            None,
            Some(""),
            Some("  "),
            Some("on"),
            Some("1"),
            Some("weird"),
        ] {
            assert!(!stripped(keep), "{keep:?}");
        }
        for off in ["off", "0", "false", " OFF ", "False"] {
            assert!(stripped(Some(off)), "{off}");
        }
    }

    #[test]
    fn decision_table() {
        use Author as A;
        use Callee as C;
        use Route as R;
        // (걷음 스위치, 저자, 대상, 길) → 깨움.
        let table = [
            // 스위치가 꺼져 있으면(기본) 전부 깨운다.
            (false, A::Agent, C::Agent, R::Text, true),
            (false, A::Agent, C::Team, R::Text, true),
            (false, A::Human, C::Agent, R::Text, true),
            // 걷음 — 에이전트 글의 글자 멘션만 에이전트·팀을 못 깨운다.
            (true, A::Agent, C::Agent, R::Text, false),
            (true, A::Agent, C::Team, R::Text, false),
            // ① 사람 글은 그대로.
            (true, A::Human, C::Agent, R::Text, true),
            (true, A::Human, C::Team, R::Text, true),
            (true, A::Human, C::Human, R::Text, true),
            // ② 에이전트 글이 사람을 멘션.
            (true, A::Agent, C::Human, R::Text, true),
            // ③ 도구가 만든 호출.
            (true, A::Agent, C::Agent, R::Tool, true),
            (true, A::Agent, C::Team, R::Tool, true),
            (true, A::Agent, C::Human, R::Tool, true),
            // ④⑤ 시스템·자동 진행 줄.
            (true, A::Agent, C::Agent, R::System, true),
            (true, A::Human, C::Agent, R::System, true),
            (true, A::Agent, C::Team, R::System, true),
        ];
        for (off, a, c, r, want) in table {
            assert_eq!(wakes(off, a, c, r), want, "{off} {a:?} {c:?} {r:?}");
        }
    }

    fn resolved() -> Resolved {
        Resolved {
            normalized_body: "@bot @blocked @human @squad 봐줘".into(),
            account_handles: HashSet::new(),
            called_ids: vec!["bot".into(), "blocked".into(), "human".into()],
            called_agents: vec![
                ("bot".into(), "bot".into()),
                ("blocked".into(), "blocked".into()),
            ],
            denied_ids: HashSet::from(["blocked".to_string()]),
            team_plans: vec![TeamPlan {
                team_id: "t1".into(),
                recipients: vec!["m1".into()],
                via_lead: false,
            }],
            target_call: vec![
                Target {
                    kind: TargetKind::Team,
                    id: "t1".into(),
                },
                Target {
                    kind: TargetKind::Group,
                    id: "g1".into(),
                },
            ],
            channel_called: false,
            call_meta: serde_json::Map::new(),
            missed: Vec::new(),
            missed_handles: vec![("blocked".into(), "gate_denied")],
        }
    }

    #[test]
    fn switch_off_changes_nothing() {
        let mut r = resolved();
        let s = apply(false, Author::Agent, Route::Text, "me", &mut r);
        assert_eq!(s, Stripped::default());
        assert_eq!(r, resolved());
    }

    #[test]
    fn human_tool_system_untouched() {
        for (a, route) in [
            (Author::Human, Route::Text),
            (Author::Agent, Route::Tool),
            (Author::Agent, Route::System),
        ] {
            let mut r = resolved();
            assert_eq!(apply(true, a, route, "me", &mut r), Stripped::default());
            assert_eq!(r, resolved(), "{a:?} {route:?}");
        }
    }

    /// 걷으면 에이전트·팀 부름이 빠지고 사람 부름·집합은 남는다. 암묵 위임·회신권은 `called_ids` 에서 담당을 고르므로
    /// (`msg_post` 의 `called_ids ∩ inbox 가 간 계정`) 걷힌 에이전트에게는 의무가 서지 않는다 — 남는 것은 사람뿐이다.
    #[test]
    fn agent_text_mentions_stripped_and_no_obligation_candidates() {
        let mut r = resolved();
        let s = apply(true, Author::Agent, Route::Text, "me", &mut r);
        assert_eq!(
            s,
            Stripped {
                accounts: 1,
                teams: 1
            }
        );
        assert_eq!(r.called_ids, vec!["human".to_string()]);
        assert!(r.team_plans.is_empty());
        assert_eq!(r.target_call.len(), 1);
        assert_eq!(r.target_call[0].kind, TargetKind::Group);
        // 경고 — 게이트가 막은 것은 옛 이유 그대로, 걷힌 것은 새 이유.
        assert_eq!(
            r.missed_handles,
            vec![
                ("blocked".to_string(), "gate_denied"),
                ("bot".to_string(), REASON)
            ]
        );
        // 암묵 위임 담당 후보(에이전트)가 없다.
        let agents = ["bot", "blocked"];
        assert!(!r.called_ids.iter().any(|c| agents.contains(&c.as_str())));
    }
}
