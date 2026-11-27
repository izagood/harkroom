//! 자기 조각(F1a 자기 쪼개기)의 **게이트·쓰기** — `agent.call` 의 `expect: "report"` 가 `to` 에 부른 에이전트 자신 하나만 실었을 때
//! [`super::msg_post::answer_call`] 이 이 길로 보낸다. 옛 위임 도구(별칭)와 팀 명단 갈래(팀장이면 호출 게이트를 건너뛰던 길)는 걷혔다(U5) —
//! 남을 부르는 의무는 전부 `agent.call` 의 멘션 판정([`crate::core::msg_post::Origin::call_obligation`])을 지난다.
//!
//! - 차례: 채널 가시성 → 계획판 칸(`bad_request`·`self_link`) → 자기 조각 판정(스위치 `HARKROOM_SELF_SPLIT`) → 호출 게이트(꺼진 계정만 막는다)
//!   → 접속 확인 → 위임 글(`meta.kind = 'delegation'`) → 같은 tx 의 의무([`crate::core::delegate_write`]) → 이벤트.
//! - 거절(`forbidden` · `self_delegation` · `not_invokable`)은 **아무것도 쓰지 않는다**.
//! - 조각은 `team_id` 를 적지 않고, 같은 스레드의 다른 의무를 대체하지 않는다([`crate::core::delegate_write`]).
//! - 비지 않은 `agentModels` 는 접속 확인 뒤 [`super::msg_post::check_picks`], 글 tx 의 고르기, 커밋 뒤 시스템 줄·이벤트. 하네스 목록·고르기
//!   쓰기 권한이 없으면 답하지 않는다.
//! - 계획판 칸(`planRootId`·`planGroupId`)은 위임 글이 선 뒤 부모 계획의 그룹을 잇는다([`super::plan_write::link_plan_group`]). 결과·거절은
//!   답의 `plan` 칸에만 싣는다(위임은 되돌리지 않는다). 계획 쓰기 권한이 없으면 글을 쓰기 전에 물러난다.
//! - **답하지 않는 것**(`None` — fail-closed, 부른 쪽은 고정 오류를 받는다): `to` 가 나 하나가 아닌 요청 · 권한 없는 `agentModels`·계획판 칸 ·
//!   틀린 꼴의 인자 · 자른 자리가 서로게이트 쌍을 가르는 모델 신고 · DB 오류.
//! - 접속 확인은 DB `agent_presence`(`expires_at > now()`)를 읽는다.
use super::tools::err;
use crate::auth::Account;
use crate::core::audience::audience_for;
use crate::core::cause_link;
use crate::core::delegate_write;
use crate::core::invoke_gate::{self, Ctx, Via};
use crate::core::msg_edit::MAX_MESSAGE_BODY_CHARS;
use crate::core::msg_post::{self, Origin, Outcome, PostBody, PostState};
use crate::core::msg_read::{channel_visible, is_uuid};
use serde_json::Value;
use sqlx::PgPool;
use std::collections::HashMap;
use std::sync::OnceLock;

/// TS `DELEGATION_DEADLINE_MIN_SEC`·`MAX_SEC`.
pub(super) const DEADLINE_MIN: i64 = 60;
pub(super) const DEADLINE_MAX: i64 = 6 * 60 * 60;
/// TS `DELEGATION_DEADLINE_DEFAULT_SEC`.
pub(super) const DEADLINE_DEFAULT: i64 = 10 * 60;

/// TS `presence.online()` 의 DB 판 — 이 계정들 중 지금 접속한 것.
pub(super) const ONLINE_SQL: &str = "select account_id::text from agent_presence where account_id = any($1::uuid[]) and expires_at > now()";

/// 접속하지 않은 대상이 배정된 오퍼레이터 — 풀 에이전트 판정([`pool_wakeable`])에만 쓴다.
pub(super) const ASSIGNED_SQL: &str = "select agent_id::text, operator_id::text from agent_assignment where agent_id = any($1::uuid[])";

/// 러너가 내려가 있어도(접속 줄이 없어도) 부를 수 있는 풀 에이전트를 고른다 — `rows` 는 [`ASSIGNED_SQL`] 의 (에이전트, 배정된 오퍼레이터)다.
/// 그 오퍼레이터가 지금 붙어 있고, `wake` 프레임을 받으며, 그 에이전트를 「깨움으로 러너를 빌려 띄우는 풀 에이전트」로 알렸을 때만이다.
/// 풀 에이전트는 할 일이 없으면 러너를 반납해 접속 줄이 끊긴다 — 접속만 보면 부를 길이 없다(부름 → 깨움 → 러너 빌림으로 이어져야 한다).
/// 허브가 없으면(소켓이 꺼진 프로세스) 아무도 고르지 않는다 — 예전처럼 접속한 대상만 부른다.
pub(super) fn pool_wakeable(
    hub: Option<&crate::core::operator_hub::OperatorHub>,
    rows: Vec<(String, String)>,
) -> Vec<String> {
    let Some(hub) = hub else {
        return Vec::new();
    };
    rows.into_iter()
        .filter(|(agent, operator)| hub.wakes_pool_agent(operator, agent))
        .map(|(agent, _)| agent)
        .collect()
}

/// `ids` 중 `online` 에 없는 것(접속하지 않은 대상).
pub(super) fn offline_of(ids: &[String], online: &[String]) -> Vec<String> {
    ids.iter()
        .filter(|id| !online.contains(id))
        .cloned()
        .collect()
}

/// 대상 문장은 골든으로 받는다(`golden/sql_fragments.json`).
struct Sql {
    targets: String,
}

fn sql() -> &'static Sql {
    static S: OnceLock<Sql> = OnceLock::new();
    S.get_or_init(|| {
        let v: Value = serde_json::from_str(include_str!("../../../golden/sql_fragments.json"))
            .expect("golden/sql_fragments.json");
        let frag = |k: &str| {
            v[k].as_str()
                .unwrap_or_else(|| panic!("golden fragment {k}"))
                .to_string()
        };
        Sql {
            targets: frag("delegate_targets"),
        }
    })
}

#[derive(Debug, PartialEq, Eq)]
struct Args {
    channel: String,
    root: String,
    to: Vec<String>,
    body: String,
    deadline_sec: i64,
    /// 다듬은 모델 신고(빈 값이면 없음).
    model: Option<String>,
    /// 비지 않은 `agentModels`(zod 꼴만 본 것). 빈 배열은 없는 것과 같다.
    picks: Vec<super::msg_post::Pick>,
    /// 계획판 칸(P6-5) — TS 와 같은 차례(가시성 뒤, 자기 위임 앞)에서 거절하거나 위임 뒤에 잇는다.
    plan: PlanArg,
}

/// `planRootId`·`planGroupId` 의 꼴.
#[derive(Debug, PartialEq, Eq)]
enum PlanArg {
    None,
    /// 둘 중 하나만 — TS `bad_request`.
    OnlyOne,
    /// (부모 계획 스레드, 그룹 id).
    Link(String, String),
}

/// TS `bad_request`(계획판 칸 하나만) 문구.
pub(super) const PLAN_PAIR_MSG: &str =
    "planRootId 와 planGroupId 는 함께 준다(부모 계획의 스레드와 그 그룹)";
/// TS `PLAN_ERROR_MESSAGES.self_link`.
pub(super) const SELF_LINK_MSG: &str = "자기 스레드는 연결할 수 없다";

/// zod `planGroupId` — `/^g[1-9][0-9]{0,3}$/`.
pub(super) fn plan_group_ok(g: &str) -> bool {
    let b = g.as_bytes();
    (2..=5).contains(&b.len())
        && b[0] == b'g'
        && (b'1'..=b'9').contains(&b[1])
        && b[2..].iter().all(u8::is_ascii_digit)
}

/// 자기 조각 인자(`agent.call` 이 추려 넘긴 것)의 꼴. 틀린 꼴은 `None`.
fn parse(args: &Value) -> Option<Args> {
    let Value::Object(o) = args else { return None };
    // zod `.optional()` — 칸이 있으면 꼴이 맞아야 한다(null 도 틀린 꼴 → TS 의 검증 오류).
    let plan_root = match o.get("planRootId") {
        None => None,
        Some(v) => Some(v.as_str().filter(|s| is_uuid(s))?.to_owned()),
    };
    let plan_group = match o.get("planGroupId") {
        None => None,
        Some(v) => Some(v.as_str().filter(|s| plan_group_ok(s))?.to_owned()),
    };
    let plan = match (plan_root, plan_group) {
        (None, None) => PlanArg::None,
        (Some(r), Some(g)) => PlanArg::Link(r, g),
        _ => PlanArg::OnlyOne,
    };
    // 빈 `agentModels` 는 TS 에서도 고를 것이 없다(`cleanPicks([])` → 고르기 없음) — 없는 것과 같다.
    let picks = match o.get("agentModels") {
        None => Vec::new(),
        Some(v) => super::msg_post::parse_picks(v)?,
    };
    let uuid = |k: &str| o.get(k)?.as_str().filter(|s| is_uuid(s)).map(str::to_owned);
    let channel = uuid("channelId")?;
    let root = uuid("threadRootId")?;
    let n = o.get("body")?.as_str()?.encode_utf16().count();
    if n == 0 || n > MAX_MESSAGE_BODY_CHARS {
        return None;
    }
    let Value::Array(a) = o.get("to")? else {
        return None;
    };
    if a.is_empty() || a.len() > 8 {
        return None;
    }
    let mut to = Vec::with_capacity(a.len());
    for x in a {
        let h = x.as_str()?;
        let n = h.encode_utf16().count();
        if n == 0 || n > 64 {
            return None;
        }
        to.push(h.to_owned());
    }
    let deadline_sec = match o.get("deadlineSec") {
        None => DEADLINE_DEFAULT,
        Some(d @ Value::Number(_)) => {
            super::tools::js_int(d).filter(|d| (DEADLINE_MIN..=DEADLINE_MAX).contains(d))?
        }
        _ => return None,
    };
    let model = match o.get("model") {
        None => None,
        Some(Value::String(m))
            if (1..=cause_link::MODEL_ID_MAX).contains(&m.encode_utf16().count()) =>
        {
            // JS `trim().slice` 그대로 다듬는다 — 서로게이트 쌍이 갈리면 TS 로 넘긴다(`message.post` 와 같다).
            cause_link::trimmed_model(m)?
        }
        _ => return None,
    };
    let body = o.get("body")?.as_str()?.to_owned();
    Some(Args {
        channel,
        root,
        to,
        body,
        deadline_sec,
        model,
        picks,
        plan,
    })
}

/// 소문자 handle → (계정, 꺼짐).
type Members = HashMap<String, (String, bool)>;

/// `to` 에 내가 들어 있을 때의 갈래(F1a).
#[derive(Debug, PartialEq, Eq)]
enum SelfSplit {
    /// `to` 에 내가 없다 — 이 길의 일이 아니다(남을 부르는 의무는 `agent.call` 의 멘션 판정이 맡는다).
    No,
    /// 자기 조각 — `to` 가 나 하나뿐인 에이전트의 부름(스위치 켬).
    Piece,
    /// 그 밖(스위치 꺼짐 · 남과 섞임 · 사람) — `self_delegation`.
    Refused,
}

/// `HARKROOM_SELF_SPLIT` — `on`·`1`·`true` 만 켬. 없거나 다른 값이면 꺼짐(예전 그대로 `self_delegation`).
pub(crate) fn self_split_on(raw: Option<&str>) -> bool {
    matches!(
        raw.map(|v| v.trim().to_ascii_lowercase()).as_deref(),
        Some("on" | "1" | "true")
    )
}

fn self_split_for(wanted: &[String], mine: &str, is_agent: bool, on: bool) -> SelfSplit {
    if !wanted.iter().any(|w| w == mine) {
        return SelfSplit::No;
    }
    if on && is_agent && wanted.len() == 1 {
        SelfSplit::Piece
    } else {
        SelfSplit::Refused
    }
}

/// 답하지 않는 갈래 이름을 한 줄 남기고 `None` — 앞단은 요청을 하나하나 기록하지 않아 이 줄이 없으면 운영에서 갈래를 가를 수 없다.
fn to_ts<T>(branch: &str) -> Option<T> {
    eprintln!("front: self piece unanswered branch={branch}");
    None
}

/// `.ok()?` 로 삼키던 DB 오류를 갈래 이름과 함께 남긴다(그 뒤 `.ok()?` 로 물러난다).
fn ts_err<E: std::fmt::Display>(branch: &'static str) -> impl FnOnce(E) {
    move |e| eprintln!("front: self piece unanswered branch={branch} error={e}")
}

/// 자기 조각 — 거절·위임 결과면 그 글자, 그 밖은 `None`. `st` 는 의무 쓰기 칸이 있을 때만 있다.
#[allow(clippy::too_many_arguments)]
pub async fn answer(
    pool: &PgPool,
    st: Option<&PostState>,
    picks_ok: bool,
    me: &Account,
    args: &Value,
    cause: Option<&str>,
    turn: Option<&str>,
    operator: bool,
) -> Option<String> {
    let Some(a) = parse(args) else {
        return to_ts("parse");
    };
    // 고르기는 하네스 목록·고르기 쓰기 권한이 다 있을 때만 — 아니면 아무것도 답하지 않는다.
    if !a.picks.is_empty() && !picks_ok {
        return to_ts("picks_not_allowed");
    }
    match channel_visible(pool, &me.id, &a.channel).await {
        Ok(true) => {}
        Ok(false) => return Some(err("forbidden", "not a member of this dm channel")),
        Err(e) => {
            ts_err("channel_visible")(e);
            return None;
        }
    }
    // 가시성 뒤, 자기 위임 앞 — 계획판 칸의 짝·자기 연결.
    match &a.plan {
        PlanArg::OnlyOne => return Some(err("bad_request", PLAN_PAIR_MSG)),
        PlanArg::Link(r, _) if r.eq_ignore_ascii_case(&a.root) => {
            return Some(err("self_link", SELF_LINK_MSG));
        }
        _ => {}
    }
    // handle 견줌은 ASCII 소문자로 — ASCII 밖 handle 은 답하지 않는다.
    if !me.handle.is_ascii() || a.to.iter().any(|h| !h.is_ascii()) {
        return to_ts("non_ascii_handle");
    }
    let mine = me.handle.to_ascii_lowercase();
    let wanted: Vec<String> = a.to.iter().map(|h| h.to_ascii_lowercase()).collect();
    // F1a 자기 쪼개기 — `to` 가 나 하나뿐이고 스위치가 켜졌을 때만 지난다. 위임 행·부름에 `team_id` 를 적지 않는다.
    match self_split_for(
        &wanted,
        &mine,
        me.kind == "agent",
        self_split_on(crate::env_once::get(&crate::env_once::SELF_SPLIT)),
    ) {
        SelfSplit::No => to_ts("not_self_piece"),
        SelfSplit::Refused => Some(err("self_delegation", "you cannot delegate to yourself")),
        SelfSplit::Piece => {
            let members = match gate(pool, me, &a, &wanted, &[0]).await? {
                Ok(m) => m,
                Err(refused) => return Some(refused),
            };
            write_or_ts(st, me, &a, &wanted, &members, cause, turn, operator).await
        }
    }
}

/// 받는 쪽마다 멘션과 같은 호출 게이트. `Ok` 는 명단, `Err` 는 거절 글자. `only` 는 게이트로 잴 `wanted` 의 자리다.
async fn gate(
    pool: &PgPool,
    me: &Account,
    a: &Args,
    wanted: &[String],
    only: &[usize],
) -> Option<Result<Members, String>> {
    let (members, blocked) = gate_blocked(pool, &me.id, &a.channel, wanted, only).await?;
    if !blocked.is_empty() {
        let refused: Vec<String> = blocked.iter().map(|&i| a.to[i].clone()).collect();
        let msg = format!(
            "cannot delegate to: {} — not an agent you may invoke",
            refused.join(", ")
        );
        // `{ error: { code, message, handles } }` — 키 순서 그대로.
        let body = format!(
            "{{\"error\":{{\"code\":\"not_invokable\",\"message\":{},\"handles\":{}}}}}",
            Value::from(msg),
            Value::from(refused)
        );
        return Some(Err(super::respond::text_result(&body)));
    }
    Some(Ok(members))
}

/// [`gate`] 의 판정만 — (명단, 게이트가 막는 `wanted` 의 자리). 아무것도 쓰지 않는다. DB 오류는 `None`.
async fn gate_blocked(
    pool: &PgPool,
    me_id: &str,
    channel: &str,
    wanted: &[String],
    only: &[usize],
) -> Option<(Members, Vec<usize>)> {
    let mut conn = pool.acquire().await.map_err(ts_err("gate_acquire")).ok()?;
    let rows: Vec<(String, String, bool)> = sqlx::query_as(&*sql().targets)
        .bind(wanted)
        .fetch_all(&mut *conn)
        .await
        .map_err(ts_err("gate_targets"))
        .ok()?;
    let by_handle: HashMap<&str, &str> = rows
        .iter()
        .map(|(id, h, _)| (h.as_str(), id.as_str()))
        .collect();
    let ids: Vec<String> = rows.iter().map(|(id, _, _)| id.clone()).collect();
    // 소문자 handle → (계정, 꺼짐).
    let members: Members = rows
        .iter()
        .map(|(id, h, off)| (h.clone(), (id.clone(), *off)))
        .collect();
    let facts = invoke_gate::invoke_facts(&mut conn, &ids)
        .await
        .map_err(ts_err("invoke_facts"))
        .ok()?;
    let ctx = Ctx {
        caller_id: me_id,
        channel_id: channel,
        via: Via::Mention,
        reply_grant_thread_id: None,
    };
    let mut blocked: Vec<usize> = Vec::new();
    for (i, h) in wanted.iter().enumerate() {
        if !only.contains(&i) {
            continue;
        }
        let fact = by_handle.get(h.as_str()).and_then(|id| facts.get(*id));
        let ok = match fact {
            // 자기 조각(F1a) — 받는 쪽이 부른 에이전트 자신이면 호출 범위를 재지 않는다(범위는 「남이 나를 부를 수 있는가」다:
            // 범위가 owner 면 본인도 걸린다). 권한이 넓어지지 않는다 — 같은 계정이고, 조각 턴의 원인 사람·위임장은 위임 글 행에서 온다.
            // 꺼진 계정만 막는다. 이 길에는 [`SelfSplit::Piece`] 만 온다.
            Some(f) if f.agent_id == me_id => !f.off,
            Some(f) => invoke_gate::may_invoke(&mut conn, f, &ctx)
                .await
                .map_err(ts_err("may_invoke"))
                .ok()?,
            None => false,
        };
        if !ok {
            blocked.push(i);
        }
    }
    Some((members, blocked))
}

/// (쓰기 칸이 있으면) 위임 쓰기.
#[allow(clippy::too_many_arguments)]
async fn write_or_ts(
    st: Option<&PostState>,
    me: &Account,
    a: &Args,
    wanted: &[String],
    members: &Members,
    cause: Option<&str>,
    turn: Option<&str>,
    operator: bool,
) -> Option<String> {
    // 게이트를 다 지났다 — 쓰기 칸이 있으면 위임을 쓴다. 스레드당 넘기기 횟수 상한은 없다.
    let Some(st) = st else {
        return to_ts("write_core_off");
    };
    write(st, me, a, wanted, members, cause, turn, operator).await
}

/// 같은 값이 두 번 있나 — 접속한 담당 명단(`delegate_ids`)에 쓴다.
fn has_dup(ids: &[String]) -> bool {
    let mut seen = std::collections::HashSet::new();
    !ids.iter().all(|x| seen.insert(x.as_str()))
}

/// 접속 확인 → 위임 글 → 의무 → 결과.
#[allow(clippy::too_many_arguments)]
async fn write(
    st: &PostState,
    me: &Account,
    a: &Args,
    wanted: &[String],
    members: &Members,
    cause: Option<&str>,
    turn: Option<&str>,
    operator: bool,
) -> Option<String> {
    let mut ids: Vec<String> = Vec::with_capacity(wanted.len());
    for w in wanted {
        let Some(m) = members.get(w) else {
            return to_ts("member_missing");
        };
        ids.push(m.0.clone());
    }
    let mut online: Vec<String> = sqlx::query_scalar(ONLINE_SQL)
        .bind(&ids)
        .fetch_all(&st.read)
        .await
        .map_err(ts_err("online"))
        .ok()?;
    // 러너를 반납한 풀 에이전트는 접속 줄이 없어도 부를 수 있다 — 못 읽으면 예전처럼 접속한 대상만 부른다.
    let offline = offline_of(&ids, &online);
    if !offline.is_empty() {
        let rows: Vec<(String, String)> = sqlx::query_as(ASSIGNED_SQL)
            .bind(&offline)
            .fetch_all(&st.read)
            .await
            .unwrap_or_default();
        let hub = crate::core::operator_hub::process_hub();
        online.extend(pool_wakeable(hub.as_ref(), rows));
    }
    let mut delegated: Vec<String> = Vec::new();
    let mut delegate_ids: Vec<String> = Vec::new();
    let mut unreachable: Vec<String> = Vec::new();
    for (i, w) in wanted.iter().enumerate() {
        let (id, off) = members.get(w)?;
        if *off || !online.iter().any(|o| o == id) {
            unreachable.push(a.to[i].clone());
        } else {
            delegated.push(a.to[i].clone());
            delegate_ids.push(id.clone());
        }
    }
    // 같은 담당이 두 번이면 의무 행의 기본 키에 걸린다 — 쓰지 않고 물러난다(자기 조각은 `to` 가 하나라 닿지 않는 안전판).
    if has_dup(&delegate_ids) {
        return to_ts("duplicate_delegate");
    }
    // 계획 잇기는 위임 글 **뒤**라 되돌릴 수 없다 — 계획 쓰기 권한이 없으면 글을 쓰기 전에 물러난다.
    if matches!(a.plan, PlanArg::Link(..)) {
        use super::plan_write::{PLAN_WRITE_PRIVILEGES, PLAN_WRITE_SEQUENCE_PRIVILEGES};
        let missing = crate::write::missing_in(
            &st.write,
            PLAN_WRITE_PRIVILEGES,
            PLAN_WRITE_SEQUENCE_PRIVILEGES,
        )
        .await
        .map_err(ts_err("plan_privileges"))
        .ok()?;
        if !missing.is_empty() {
            return to_ts("plan_privileges_missing");
        }
    }
    if delegated.is_empty() {
        return Some(super::respond::text_result(&format!(
            "{{\"delegated\":[],\"unreachable\":{},\"message\":null}}",
            Value::from(unreachable)
        )));
    }
    // 모델 고르기 판정 — 접속 확인 뒤, 글 앞.
    let Some(picked) = super::msg_post::check_picks(st, &a.picks).await else {
        return to_ts("check_picks");
    };
    if let Some(refused) = picked {
        return Some(refused);
    }
    let hook = (!a.picks.is_empty()).then(|| {
        use crate::core::thread_model_set::clean_axis;
        let picks = a
            .picks
            .iter()
            .map(
                |(agent_id, model, effort)| crate::core::agent_model_picks::Pick {
                    agent_id: agent_id.clone(),
                    model: clean_axis(model.as_deref(), cause_link::MODEL_ID_MAX),
                    effort: clean_axis(effort.as_deref(), 64),
                },
            )
            .collect();
        crate::core::agent_model_picks::AgentPicks::new(&a.channel, Some(&a.root), &me.id, picks)
            .also_notify(&delegate_ids)
    });
    let deadline_at = msg_post::iso_ms(msg_post::now_ms() + a.deadline_sec * 1000);
    let mut delegation = serde_json::Map::new();
    delegation.insert("to".into(), Value::from(delegated.clone()));
    delegation.insert("open".into(), Value::from(delegate_ids.clone()));
    delegation.insert("unreachable".into(), Value::from(unreachable.clone()));
    delegation.insert("deadlineAt".into(), Value::from(deadline_at.clone()));
    let mut meta = serde_json::Map::new();
    meta.insert("kind".into(), Value::from("delegation"));
    meta.insert("delegation".into(), Value::Object(delegation));
    cause_link::reported_model_meta(
        &st.read,
        &me.id,
        a.model.as_deref(),
        Some(&a.root),
        &mut meta,
    )
    .await
    .map_err(ts_err("reported_model_meta"))
    .ok()?;
    let is_dm = msg_post::channel_is_dm(&st.read, &a.channel)
        .await
        .map_err(ts_err("channel_is_dm"))
        .ok()?;
    let audience = audience_for(&st.read, &a.channel)
        .await
        .map_err(ts_err("audience"))
        .ok()?
        .to_json();
    let origin = Origin {
        plan_auto_stamp: None,
        defer_inbox_events: false,
        chat_ask_rust: false,
        close_asks_after_commit: false,
        chain_cause: cause.filter(|_| operator),
        turn_id: turn.filter(|_| operator),
        meta,
        server_notice: false,
        tool_call: false,
        closes_delegation: false,
        call_obligation: None,
        delegation: Some(delegate_write::Plan {
            delegate_ids: &delegate_ids,
            deadline_at: &deadline_at,
            close_on: delegate_write::CloseOn::Report,
            plan_step_id: None,
        }),
        system: false,
        progress: false,
        wake: false,
        no_mentions: false,
        before_commit: hook.as_ref().map(|h| h as &dyn msg_post::BeforeCommit),
        // 자기 조각은 에이전트만 세운다 — 사람 작성자에게만 뜻이 있는 라우트 몫(카드 고르기·답글로 카드 닫기)은 끈다.
        service_call: false,
    };
    let post = PostBody {
        body: a.body.clone(),
        attachment_ids: Vec::new(),
        thread_root: Some(a.root.clone()),
        also_in_channel: false,
    };
    let out = msg_post::post_in_tx(
        st,
        &a.channel,
        &me.id,
        me.kind == "agent",
        &post,
        None,
        &audience,
        is_dm,
        &origin,
    )
    .await
    .map_err(ts_err("post_in_tx"))
    .ok()?;
    match out {
        // `ToTs` 의 갈래 이름은 [`msg_post::post_in_tx`] 가 이미 남겼다.
        Outcome::ToTs => to_ts("post_to_ts"),
        Outcome::Replayed(_) => to_ts("replayed"),
        Outcome::Rejected(_) => to_ts("rejected"),
        // 아무것도 쓰지 않았다 — `{ code: 'post_failed', message: 'bad_thread' }`(`message.post` 의 400 bad_thread 와 다르다).
        Outcome::BadThread => Some(err("post_failed", "bad_thread")),
        Outcome::BadAttachment => to_ts("bad_attachment"),
        Outcome::Posted {
            row, delegation_id, ..
        } => {
            // 지정 행은 게시 tx 에서 이미 커밋됐다 — 시스템 줄(`byKind: 'agent'`)·이벤트는 커밋 뒤.
            if let Some((root, changes)) = hook.as_ref().and_then(|h| h.changes()) {
                for (agent, axes) in &changes {
                    if let Err(e) = crate::core::thread_model_set::announce_agent_pick(
                        st,
                        &a.channel,
                        &root,
                        &me.id,
                        agent,
                        axes.as_ref(),
                    )
                    .await
                    {
                        eprintln!("self piece: agent pick announce failed: {e}");
                    }
                }
            }
            // 위임은 이미 섰다 — 계획 연결이 막혀도 위임을 되돌리지 않고 그 결과만 `plan` 칸에 싣는다.
            let mut plan_extra = String::new();
            if let PlanArg::Link(parent, group) = &a.plan {
                match super::plan_write::link_plan_group(
                    &st.read, &st.write, &me.id, parent, group, &a.root,
                )
                .await
                {
                    Ok(plan) => plan_extra = format!(",\"plan\":{plan}"),
                    // 위임이 이미 섰으므로 DB 오류는 기록만 하고 `plan` 칸 없이 답한다(`message.ask` 의 `planStepId` 와 같다).
                    Err(e) => eprintln!("self piece: plan link {group} failed: {e}"),
                }
            }
            let inner = format!(
                "{{\"message\":{row},\"delegationId\":{},\"delegated\":{},\"unreachable\":{},\"deadlineAt\":{}{plan_extra}}}",
                Value::from(delegation_id?),
                Value::from(delegated),
                Value::from(unreachable),
                Value::from(deadline_at)
            );
            Some(super::respond::text_result(&super::respond::minify(&inner)))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parked_pool_agent_is_callable_without_presence() {
        use crate::core::operator_hub::OperatorHub;
        let ids = vec!["a1".to_string(), "a2".to_string(), "a3".to_string()];
        assert_eq!(offline_of(&ids, &["a2".to_string()]), ["a1", "a3"]);
        let rows = || {
            vec![
                ("a1".to_string(), "op".to_string()),
                ("a3".to_string(), "op".to_string()),
            ]
        };
        // 허브가 없으면(소켓이 꺼진 프로세스) 아무도 고르지 않는다.
        assert!(pool_wakeable(None, rows()).is_empty());
        let hub = OperatorHub::new();
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let reg = hub.add_operator("op", tx);
        // 오퍼레이터가 붙어 있기만 해서는 아니다 — 풀 에이전트로 알린 것만이다.
        hub.on_operator_message(
            &reg,
            r#"{"type":"hello","protocol":1,"capabilities":{},"runners":[],"sessions":[],"wakeFrames":true}"#,
        );
        assert!(pool_wakeable(Some(&hub), rows()).is_empty());
        hub.on_operator_message(&reg, r#"{"type":"runner.parked","agentId":"a1"}"#);
        assert_eq!(pool_wakeable(Some(&hub), rows()), ["a1"]);
        // 다른 오퍼레이터에 배정된 에이전트는 이 오퍼레이터가 알렸어도 아니다(배정된 오퍼레이터의 알림만 본다).
        assert!(pool_wakeable(Some(&hub), vec![("a1".to_string(), "op2".to_string())]).is_empty());
    }

    #[test]
    fn dup_only_among_reachable_hands_to_ts() {
        let v = |xs: &[&str]| xs.iter().map(|x| (*x).to_owned()).collect::<Vec<_>>();
        assert!(!has_dup(&v(&[])));
        assert!(!has_dup(&v(&["a", "b"])));
        assert!(has_dup(&v(&["a", "b", "a"])));
    }

    #[test]
    fn golden_sql_loads() {
        let s = sql();
        assert!(s.targets.contains("lower(handle) = any($1::text[])"));
    }

    const C: &str = "11111111-1111-1111-1111-111111111111";
    const R: &str = "22222222-2222-2222-2222-222222222222";

    #[test]
    fn parse_like_zod() {
        let ok = json!({ "channelId": C, "threadRootId": R, "body": "해 줘", "to": ["Bot"], "deadlineSec": 600, "model": "m" });
        assert_eq!(parse(&ok).unwrap().to, vec!["Bot".to_owned()]);
        let empty = json!({ "channelId": C, "threadRootId": R, "body": "x", "to": ["a"], "agentModels": [] });
        assert!(parse(&empty).unwrap().picks.is_empty());
        let picked = json!({ "channelId": C, "threadRootId": R, "body": "x", "to": ["a"], "agentModels": [{ "agentId": C, "model": "opus" }] });
        assert_eq!(
            parse(&picked).unwrap().picks,
            vec![(C.to_owned(), Some("opus".to_owned()), None)]
        );
        for bad in [
            json!({ "channelId": C, "body": "x", "to": ["a"] }),
            json!({ "channelId": C, "threadRootId": R, "body": "", "to": ["a"] }),
            json!({ "channelId": C, "threadRootId": R, "body": "x", "to": [] }),
            json!({ "channelId": C, "threadRootId": R, "body": "x", "to": ["a"], "deadlineSec": 59 }),
            json!({ "channelId": C, "threadRootId": R, "body": "x", "to": ["a"], "deadlineSec": 1.5 }),
            json!({ "channelId": C, "threadRootId": R, "body": "x", "to": ["a"], "agentModels": [{ "agentId": "x" }] }),
            json!({ "channelId": C, "threadRootId": R, "body": "x", "to": ["a"], "agentModels": null }),
            json!({ "channelId": C, "threadRootId": R, "body": "x", "to": ["a"], "planRootId": "x", "planGroupId": "g1" }),
            json!({ "channelId": C, "threadRootId": R, "body": "x", "to": ["a"], "planRootId": C, "planGroupId": "g0" }),
            json!({ "channelId": C, "threadRootId": R, "body": "x", "to": ["a"], "planRootId": C, "planGroupId": "g10000" }),
            json!({ "channelId": C, "threadRootId": R, "body": "x", "to": ["a"], "planRootId": null, "planGroupId": "g1" }),
            json!({ "channelId": C, "threadRootId": R, "body": "x", "to": ["a","a","a","a","a","a","a","a","a"] }),
        ] {
            assert_eq!(parse(&bad), None, "{bad}");
        }
    }

    #[test]
    fn plan_fields_like_zod() {
        let base = |extra: Value| {
            let mut v = json!({ "channelId": C, "threadRootId": R, "body": "x", "to": ["a"] });
            v.as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            parse(&v).map(|a| a.plan)
        };
        assert_eq!(base(json!({})), Some(PlanArg::None));
        assert_eq!(base(json!({ "planRootId": C })), Some(PlanArg::OnlyOne));
        assert_eq!(base(json!({ "planGroupId": "g1" })), Some(PlanArg::OnlyOne));
        assert_eq!(
            base(json!({ "planRootId": C, "planGroupId": "g9999" })),
            Some(PlanArg::Link(C.to_owned(), "g9999".to_owned()))
        );
        for g in ["g1", "g10", "g999", "g9999"] {
            assert!(plan_group_ok(g), "{g}");
        }
        for g in ["g", "g0", "g01", "g10000", "s1", "G1", "g1 ", "g١"] {
            assert!(!plan_group_ok(g), "{g}");
        }
    }

    #[test]
    fn self_split_only_alone_agent_and_switched_on() {
        let w = |xs: &[&str]| xs.iter().map(|x| (*x).to_owned()).collect::<Vec<_>>();
        assert_eq!(self_split_for(&w(&["a"]), "me", true, true), SelfSplit::No);
        assert_eq!(
            self_split_for(&w(&["me"]), "me", true, true),
            SelfSplit::Piece
        );
        // 스위치 꺼짐 · 남과 섞임 · 같은 이름 두 번 · 사람 — 전부 예전 거절.
        assert_eq!(
            self_split_for(&w(&["me"]), "me", true, false),
            SelfSplit::Refused
        );
        assert_eq!(
            self_split_for(&w(&["me", "a"]), "me", true, true),
            SelfSplit::Refused
        );
        assert_eq!(
            self_split_for(&w(&["me", "me"]), "me", true, true),
            SelfSplit::Refused
        );
        assert_eq!(
            self_split_for(&w(&["me"]), "me", false, true),
            SelfSplit::Refused
        );
        for on in ["on", "1", "true", " ON "] {
            assert!(self_split_on(Some(on)), "{on}");
        }
        for off in [None, Some(""), Some("off"), Some("0"), Some("shadow")] {
            assert!(!self_split_on(off), "{off:?}");
        }
    }
}
