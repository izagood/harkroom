//! S5.3 C3b-2c-4a — MCP `message.delegate` 의 **게이트·상한**(거절 갈래)만 Rust 가 답한다. TS `mcp/mcpPlugin.ts` 의 같은 도구를
//! 위에서부터 옮긴다: 채널 가시성 → 자기 위임 → 팀장 명단 → 에이전트만 → 호출 게이트(`openDelegationTargets`). 스레드당 넘기기 횟수 상한(`round_limit`)과 사슬 상한(`chain_limit`)은 없다(O1).
//!
//! - Rust 가 답하는 것: `forbidden` · `self_delegation` · `not_agent` · `not_invokable` — 모두 **아무것도 쓰지 않는** 거절이다.
//! - C3b-2c-4b: 게이트를 지난 요청도 맡는다 — 접속 확인 → 위임 글(`meta.kind = 'delegation'`) → 같은 tx 의 의무
//!   ([`crate::core::delegate_write`]) → 이벤트. 쓰기 칸(`McpWrites::delegate`)이 없으면 지금처럼 TS 로 넘긴다.
//! - S5.4-11c: 팀장 **에이전트**가 `to` 전원을 담는 자기 팀 **하나**에 넘기는 요청(팀 명단 갈래)도 맡는다 — TS 처럼 호출 게이트를
//!   건너뛰고 팀 명단의 (계정, 꺼짐)으로 접속을 본 뒤 위임 행·부름에 `team_id` 를 적는다. `to` 를 담는 팀이 둘 이상이면
//!   TS 처럼 같은 문장의 행 순서 첫 팀(S5.4-14c). 팀장이 사람이어도 같은 팀 갈래를 탄다(`route_for`).
//!   팀 명단 갈래에도 호출 범위를 적용한다: 팀장과 **소유자가 다른** 팀원은 호출 게이트를 거치고(`not_invokable`), 같은 소유자의
//!   팀원만 명단으로 지나간다. `team_id` 는 그대로 적는다.
//! - S5.4-14c: 비지 않은 `agentModels` 도 맡는다 — 접속 확인 뒤 TS `preparePicks`([`super::msg_post::check_picks`]), 글 tx 의
//!   `applyAgentPicks`(`notified` 에 넘겨받는 팀원을 더한다), 커밋 뒤 시스템 줄·이벤트. 하네스 목록(`relay_moved`)·고르기 쓰기 권한
//!   (`AGENT_MODEL_PICKS_PRIVILEGES`)이 없으면 TS.
//! - P6-5: 계획판 칸(`planRootId`·`planGroupId`)도 맡는다 — 가시성 뒤·자기 위임 앞에서 `bad_request`(하나만)·`self_link` 를 답하고,
//!   위임 글이 선 뒤 TS `linkPlanGroup` 처럼 부모 계획의 그룹을 잇는다([`super::plan_write::link_plan_group`]). 결과·거절은 답의
//!   `plan` 칸에만 싣는다(위임은 되돌리지 않는다). 계획 쓰기 권한(`PLAN_WRITE_PRIVILEGES`)이 없으면 글을 쓰기 전에 TS.
//! - **TS 로 넘기는 것**(`None` — fail-closed): 위 밖의 팀 명단 갈래 · 권한 없는 `agentModels`·계획판 칸 · zod 가 받지 않을 인자 ·
//!   자른 자리가 서로게이트 쌍을 가르는 모델 신고 · `to` 에 접속한 같은 담당이 두 번(TS 는 글만 남기고 `delegation_failed`) · 위임 스위치를 모름 · DB 오류.
//! - 접속 확인: TS 는 프로세스 메모리(`presence.online()`)를, Rust 는 DB `agent_presence`(`expires_at > now()`)를 읽는다. TS 는
//!   그 표를 담당마다 10초에 한 번만 고쳐 쓰므로(`PERSIST_EVERY_MS`) DB 의 만료가 메모리보다 최대 약 10초 이르다 — 폴을 멈춘 담당은
//!   Rust 쪽에서 최대 약 10초 **먼저** `unreachable` 이 된다(없는 것을 있다고 하지 않는 쪽). 처음 접속은 첫 폴에 바로 쓰인다.
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
const DEADLINE_MIN: i64 = 60;
const DEADLINE_MAX: i64 = 6 * 60 * 60;
/// TS `DELEGATION_DEADLINE_DEFAULT_SEC`.
const DEADLINE_DEFAULT: i64 = 10 * 60;

/// TS `presence.online()` 의 DB 판 — 이 계정들 중 지금 접속한 것.
const ONLINE_SQL: &str = "select account_id::text from agent_presence where account_id = any($1::uuid[]) and expires_at > now()";

/// 문장(팀장 명단·대상·라운드)은 TS 상수를 골든으로 받는다(`golden/sql_fragments.json`).
struct Sql {
    lead_team: String,
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
            lead_team: frag("delegate_lead_team"),
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
const PLAN_PAIR_MSG: &str = "planRootId 와 planGroupId 는 함께 준다(부모 계획의 스레드와 그 그룹)";
/// TS `PLAN_ERROR_MESSAGES.self_link`.
const SELF_LINK_MSG: &str = "자기 스레드는 연결할 수 없다";

/// zod `planGroupId` — `/^g[1-9][0-9]{0,3}$/`.
fn plan_group_ok(g: &str) -> bool {
    let b = g.as_bytes();
    (2..=5).contains(&b.len())
        && b[0] == b'g'
        && (b'1'..=b'9').contains(&b[1])
        && b[2..].iter().all(u8::is_ascii_digit)
}

/// zod `message.delegate` 의 `inputSchema` 중 Rust 가 맡는 것. 틀린 꼴·비지 않은 `agentModels`·계획판 칸은 `None`.
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

/// 소문자 handle → (계정, 꺼짐) — TS `LeadTeam['members']`.
type Members = HashMap<String, (String, bool)>;

/// TS `leadTeamFor` 의 판정.
#[derive(Debug, PartialEq, Eq)]
enum LeadPick {
    /// `to` 전원을 담는 팀이 없다 — 호출 게이트 갈래.
    NoTeam,
    /// 그런 팀 중 행 순서의 첫 팀 — (팀 id, 그 팀 명단). TS 처럼 같은 문장의 행 순서를 따른다(S5.4-14c: 둘 이상도 맡는다).
    One(String, Members),
}

/// `rows` 는 (팀, 소문자 handle, 계정, 꺼짐).
fn lead_team_pick(rows: &[(String, String, String, bool)], wanted: &[String]) -> LeadPick {
    let mut order: Vec<&str> = Vec::new();
    let mut by_team: HashMap<&str, Members> = HashMap::new();
    for (t, h, id, off) in rows {
        if !by_team.contains_key(t.as_str()) {
            order.push(t.as_str());
        }
        by_team
            .entry(t.as_str())
            .or_default()
            .insert(h.clone(), (id.clone(), *off));
    }
    // TS `for (const [teamId, members] of byTeam)` — 삽입 순서(= 행 순서)의 첫 팀.
    match order
        .into_iter()
        .find(|t| wanted.iter().all(|w| by_team[t].contains_key(w)))
    {
        None => LeadPick::NoTeam,
        Some(t) => LeadPick::One(t.to_owned(), by_team.remove(t).unwrap_or_default()),
    }
}

/// 팀 명단 판정 뒤의 갈래 — TS `team?.members ?? (kind !== 'agent' ? not_agent : openDelegationTargets)`.
#[derive(Debug, PartialEq, Eq)]
enum Route {
    /// 팀 명단으로 지나간다 — 팀장이 사람이어도(S5.4-15c, 글은 `author_is_agent` 거짓이라 위임 키를 잇는다).
    Team,
    /// 받는 쪽마다 호출 게이트(에이전트만).
    Gate,
    /// 팀이 없는 사람 — `not_agent`.
    NotAgent,
}

fn route_for(pick: &LeadPick, is_agent: bool) -> Route {
    match (pick, is_agent) {
        (LeadPick::One(..), _) => Route::Team,
        (LeadPick::NoTeam, true) => Route::Gate,
        (LeadPick::NoTeam, false) => Route::NotAgent,
    }
}

/// 팀 명단 갈래에서 소유자를 읽는다 — (계정, 소유자). `agent_config` 행이 없으면 소유자는 비어 있다.
const OWNERS_SQL: &str = "select a.id::text, c.owner_account_id::text from account a \
     left join agent_config c on c.account_id = a.id where a.id = any($1::uuid[])";

/// 팀 명단 갈래에서 **호출 게이트를 거칠** 받는 쪽(`wanted` 의 자리) — 팀장과 소유자가 다른 팀원이다.
/// 소유자를 모르는 쪽(어느 한쪽이라도 비어 있음·명단에 없음)은 다른 것으로 본다(닫힌 쪽).
fn other_owner_idx(
    lead_owner: Option<&str>,
    wanted: &[String],
    members: &Members,
    owners: &HashMap<String, Option<String>>,
) -> Vec<usize> {
    wanted
        .iter()
        .enumerate()
        .filter(|(_, w)| {
            let owner = members
                .get(w.as_str())
                .and_then(|(id, _)| owners.get(id))
                .and_then(|o| o.as_deref());
            match (lead_owner, owner) {
                (Some(l), Some(o)) => l != o,
                _ => true,
            }
        })
        .map(|(i, _)| i)
        .collect()
}

/// [`other_owner_idx`] 를 DB 로 — 팀장이 사람이면 그 사람이 소유자다. DB 오류는 `None`(아무것도 쓰지 않는다).
async fn team_gate_idx(
    pool: &PgPool,
    me: &Account,
    wanted: &[String],
    members: &Members,
) -> Option<Vec<usize>> {
    let mut ids: Vec<String> = wanted
        .iter()
        .filter_map(|w| members.get(w.as_str()).map(|m| m.0.clone()))
        .collect();
    ids.push(me.id.clone());
    let rows: Vec<(String, Option<String>)> = sqlx::query_as(OWNERS_SQL)
        .bind(&ids)
        .fetch_all(pool)
        .await
        .map_err(ts_err("team_owners"))
        .ok()?;
    let owners: HashMap<String, Option<String>> = rows.into_iter().collect();
    let lead_owner = if me.kind == "agent" {
        owners.get(&me.id).cloned().flatten()
    } else {
        Some(me.id.clone())
    };
    Some(other_owner_idx(
        lead_owner.as_deref(),
        wanted,
        members,
        &owners,
    ))
}

/// TS 도구는 서비스 `postMessage` 를 바로 부른다 — 라우트 몫(카드 고르기·`closeAsksByReply`)이 없다. 사람 작성자에게만 뜻이 있다
/// (에이전트 글은 그 갈래를 이미 타지 않는다) — 에이전트는 예전 그대로 끈다.
fn service_call_for(is_agent: bool) -> bool {
    !is_agent
}

/// TS 로 넘기는 갈래 이름을 한 줄 남기고 `None` — 앞단은 요청을 하나하나 기록하지 않아 이 줄이 없으면 운영에서 갈래를 가를 수 없다.
fn to_ts<T>(branch: &str) -> Option<T> {
    eprintln!("front: message.delegate to TS branch={branch}");
    None
}

/// `.ok()?` 로 삼키던 DB 오류를 갈래 이름과 함께 남긴다(그 뒤 `.ok()?` 로 TS 에 넘긴다).
fn ts_err<E: std::fmt::Display>(branch: &'static str) -> impl FnOnce(E) {
    move |e| eprintln!("front: message.delegate to TS branch={branch} error={e}")
}

/// `message.delegate` — 거절·위임 결과면 그 글자, 그 밖은 `None`(TS 가 같은 요청을 돈다). `st` 는 쓰기 칸이 있을 때만 있다.
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
    // 고르기는 하네스 목록·고르기 쓰기 권한이 다 있을 때만 — 아니면 아무것도 답하지 않고 TS.
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
    // TS: 가시성 뒤, 자기 위임 앞 — 계획판 칸의 짝·자기 연결.
    match &a.plan {
        PlanArg::OnlyOne => return Some(err("bad_request", PLAN_PAIR_MSG)),
        PlanArg::Link(r, _) if r.eq_ignore_ascii_case(&a.root) => {
            return Some(err("self_link", SELF_LINK_MSG));
        }
        _ => {}
    }
    // TS `h.toLowerCase() === account.handle.toLowerCase()` — ASCII 밖 handle 은 JS 소문자 규칙을 맞추지 않고 넘긴다.
    if !me.handle.is_ascii() || a.to.iter().any(|h| !h.is_ascii()) {
        return to_ts("non_ascii_handle");
    }
    let mine = me.handle.to_ascii_lowercase();
    let wanted: Vec<String> = a.to.iter().map(|h| h.to_ascii_lowercase()).collect();
    if wanted.contains(&mine) {
        return Some(err("self_delegation", "you cannot delegate to yourself"));
    }
    // TS `leadTeamFor` — (팀, handle, 계정, 꺼짐). handle 은 TS 처럼 읽은 뒤 소문자로.
    let rows: Vec<(String, String, String, bool)> = sqlx::query_as(&*sql().lead_team)
        .bind(&me.id)
        .fetch_all(pool)
        .await
        .map_err(ts_err("lead_team"))
        .ok()?;
    let rows: Vec<(String, String, String, bool)> = rows
        .into_iter()
        .map(|(t, h, id, off)| (t, h.to_lowercase(), id, off))
        .collect();
    let pick = lead_team_pick(&rows, &wanted);
    let (team_id, members) = match (route_for(&pick, me.kind == "agent"), pick) {
        (Route::Team, LeadPick::One(t, m)) => {
            // 팀 명단 갈래에도 호출 범위를 적용한다 — 팀장과 소유자가 다른 팀원은 호출 게이트를 거친다.
            // 같은 소유자의 팀원은 예전 그대로 명단으로 지나간다.
            let idx = team_gate_idx(pool, me, &wanted, &m).await?;
            if !idx.is_empty()
                && let Err(refused) = gate(pool, me, &a, &wanted, &idx).await?
            {
                return Some(refused);
            }
            (Some(t), m)
        }
        (Route::NotAgent, _) => return Some(err("not_agent", "only agents delegate")),
        _ => {
            let all: Vec<usize> = (0..wanted.len()).collect();
            match gate(pool, me, &a, &wanted, &all).await? {
                Ok(m) => (None, m),
                Err(refused) => return Some(refused),
            }
        }
    };
    write_or_ts(
        st,
        me,
        &a,
        &wanted,
        &members,
        team_id.as_deref(),
        cause,
        turn,
        operator,
    )
    .await
}

/// TS `openDelegationTargets` — 받는 쪽마다 멘션과 같은 호출 게이트. `Ok` 는 명단, `Err` 는 거절 글자.
/// `only` 는 게이트로 잴 `wanted` 의 자리다(호출 게이트 갈래는 전부, 팀 명단 갈래는 소유자가 다른 팀원만).
async fn gate(
    pool: &PgPool,
    me: &Account,
    a: &Args,
    wanted: &[String],
    only: &[usize],
) -> Option<Result<Members, String>> {
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
    // TS `members` — 소문자 handle → (계정, 꺼짐).
    let members: Members = rows
        .iter()
        .map(|(id, h, off)| (h.clone(), (id.clone(), *off)))
        .collect();
    let facts = invoke_gate::invoke_facts(&mut conn, &ids)
        .await
        .map_err(ts_err("invoke_facts"))
        .ok()?;
    let ctx = Ctx {
        caller_id: &me.id,
        channel_id: &a.channel,
        via: Via::Mention,
        reply_grant_thread_id: None,
    };
    let mut refused: Vec<String> = Vec::new();
    for (i, h) in wanted.iter().enumerate() {
        if !only.contains(&i) {
            continue;
        }
        let fact = by_handle.get(h.as_str()).and_then(|id| facts.get(*id));
        let ok = match fact {
            Some(f) => invoke_gate::may_invoke(&mut conn, f, &ctx)
                .await
                .map_err(ts_err("may_invoke"))
                .ok()?,
            None => false,
        };
        if !ok {
            refused.push(a.to[i].clone());
        }
    }
    drop(conn);
    if !refused.is_empty() {
        let msg = format!(
            "cannot delegate to: {} — not an agent you may invoke",
            refused.join(", ")
        );
        // TS `jsonResult({ error: { code, message, handles } })` — 키 순서 그대로.
        let body = format!(
            "{{\"error\":{{\"code\":\"not_invokable\",\"message\":{},\"handles\":{}}}}}",
            Value::from(msg),
            Value::from(refused)
        );
        return Some(Err(super::respond::text_result(&body)));
    }
    Some(Ok(members))
}

/// (쓰기 칸이 있으면) 위임 쓰기.
#[allow(clippy::too_many_arguments)]
async fn write_or_ts(
    st: Option<&PostState>,
    me: &Account,
    a: &Args,
    wanted: &[String],
    members: &Members,
    team_id: Option<&str>,
    cause: Option<&str>,
    turn: Option<&str>,
    operator: bool,
) -> Option<String> {
    // 게이트를 다 지났다 — 쓰기 칸이 있으면 위임을 쓴다(C3b-2c-4b). 스레드당 넘기기 횟수 상한은 없다.
    let Some(st) = st else {
        return to_ts("write_core_off");
    };
    write(st, me, a, wanted, members, team_id, cause, turn, operator).await
}

/// 같은 값이 두 번 있나 — 접속한 담당 명단(`delegate_ids`)에 쓴다.
fn has_dup(ids: &[String]) -> bool {
    let mut seen = std::collections::HashSet::new();
    !ids.iter().all(|x| seen.insert(x.as_str()))
}

/// TS `message.delegate` 의 뒷부분 — 접속 확인 → 위임 글 → 의무 → 결과.
#[allow(clippy::too_many_arguments)]
async fn write(
    st: &PostState,
    me: &Account,
    a: &Args,
    wanted: &[String],
    members: &Members,
    team_id: Option<&str>,
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
    let online: Vec<String> = sqlx::query_scalar(ONLINE_SQL)
        .bind(&ids)
        .fetch_all(&st.read)
        .await
        .map_err(ts_err("online"))
        .ok()?;
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
    // `to` 에 같은 담당이 두 번(대소문자만 달라도) — 접속한 담당이 겹치면 TS 는 글을 올린 뒤 의무 행의 기본 키에 걸려
    // `delegation_failed` 로 답한다(글만 남는다). Rust 는 글과 의무가 한 tx 라 그 꼴을 만들 수 없으므로 TS 로 넘긴다.
    // 겹친 담당이 접속하지 않았으면 TS 도 `unreachable` 에 두 번 싣고 끝난다 — 그 꼴은 Rust 가 그대로 답한다(P6-5b).
    if has_dup(&delegate_ids) {
        return to_ts("duplicate_delegate");
    }
    // 계획 잇기는 위임 글 **뒤**라 되돌릴 수 없다 — 계획 쓰기 권한이 없으면 글을 쓰기 전에 TS 로 넘긴다.
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
    // Rust 가 직접 「접속 안 함」으로 답한다 — TS 가 낸 `unreachable`(메모리 presence)과 운영에서 가를 수 있게 남긴다.
    if !unreachable.is_empty() {
        eprintln!(
            "front: message.delegate unreachable from Rust online={}/{} delegated={}",
            online.len(),
            ids.len(),
            delegated.len()
        );
    }
    if delegated.is_empty() {
        return Some(super::respond::text_result(&format!(
            "{{\"delegated\":[],\"unreachable\":{},\"message\":null}}",
            Value::from(unreachable)
        )));
    }
    // TS `preparePicks` — 접속 확인 뒤, 글 앞.
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
        closes_delegation: false,
        delegation: Some(delegate_write::Plan {
            delegate_ids: &delegate_ids,
            deadline_at: &deadline_at,
            team_id,
        }),
        system: false,
        progress: false,
        wake: false,
        no_mentions: false,
        before_commit: hook.as_ref().map(|h| h as &dyn msg_post::BeforeCommit),
        service_call: service_call_for(me.kind == "agent"),
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
        // 아무것도 쓰지 않았다. TS 위임 도구는 `postMessage` 의 실패를 그대로 싣는다 —
        // `{ code: 'post_failed', message: posted.failure }`(`message.post` 의 400 bad_thread 와 다르다).
        Outcome::BadThread => Some(err("post_failed", "bad_thread")),
        Outcome::BadAttachment => to_ts("bad_attachment"),
        Outcome::Posted {
            row,
            delegation_id,
            mandate,
            ..
        } => {
            // 사람 팀장 글이 새로 세운 위임 — 커밋 뒤 감사(TS `postMessage` 끝의 `auditMandateCreated`).
            if let Some(c) = &mandate {
                crate::write::record_audit(
                    &st.write,
                    crate::write::AuditEntry {
                        action: "mandate.created",
                        actor_id: Some(c.actor_id()),
                        actor_handle: None,
                        target: Some(&c.mandate_id),
                        ip: None,
                        detail: c.audit_detail(),
                    },
                )
                .await;
            }
            // TS: 지정 행은 게시 tx 에서 이미 커밋됐다 — 시스템 줄(`byKind: 'agent'`)·이벤트는 커밋 뒤.
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
                        eprintln!("message.delegate: agent pick announce failed: {e}");
                    }
                }
            }
            // TS: 위임은 이미 섰다 — 계획 연결이 막혀도 위임을 되돌리지 않고 그 결과만 `plan` 칸에 싣는다.
            let mut plan_extra = String::new();
            if let PlanArg::Link(parent, group) = &a.plan {
                match super::plan_write::link_plan_group(
                    &st.read, &st.write, &me.id, parent, group, &a.root,
                )
                .await
                {
                    Ok(plan) => plan_extra = format!(",\"plan\":{plan}"),
                    // 다름(기록): TS 는 이 DB 오류를 도구 오류로 던진다. Rust 는 위임이 이미 섰으므로 기록만 하고 `plan` 칸 없이 답한다
                    // (`message.ask` 의 `planStepId` 와 같다).
                    Err(e) => eprintln!("message.delegate: plan link {group} failed: {e}"),
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
    fn dup_only_among_reachable_hands_to_ts() {
        let v = |xs: &[&str]| xs.iter().map(|x| (*x).to_owned()).collect::<Vec<_>>();
        assert!(!has_dup(&v(&[])));
        assert!(!has_dup(&v(&["a", "b"])));
        assert!(has_dup(&v(&["a", "b", "a"])));
    }

    #[test]
    fn team_route_gates_other_owners_only() {
        let members: Members = [("a", "ia"), ("b", "ib"), ("c", "ic"), ("d", "id")]
            .into_iter()
            .map(|(h, id)| (h.to_owned(), (id.to_owned(), false)))
            .collect();
        let owners: HashMap<String, Option<String>> =
            [("ia", Some("o1")), ("ib", Some("o2")), ("ic", None)]
                .into_iter()
                .map(|(id, o)| (id.to_owned(), o.map(str::to_owned)))
                .collect();
        let wanted: Vec<String> = ["a", "b", "c", "d", "x"].map(String::from).to_vec();
        // 같은 소유자(a)만 명단으로 지나간다 — 다른 소유자·소유자 없음·설정 행 없음·명단 밖은 게이트.
        assert_eq!(
            other_owner_idx(Some("o1"), &wanted, &members, &owners),
            vec![1, 2, 3, 4]
        );
        // 팀장의 소유자를 모르면 전원 게이트.
        assert_eq!(
            other_owner_idx(None, &wanted[..2], &members, &owners),
            vec![0, 1]
        );
        assert!(other_owner_idx(Some("o1"), &wanted[..1], &members, &owners).is_empty());
    }

    #[test]
    fn golden_sql_loads() {
        let s = sql();
        assert!(s.lead_team.contains("agent_team_member"));
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
    fn lead_team_needs_one_team_with_all() {
        let r = |t: &str, h: &str, off: bool| (t.to_owned(), h.to_owned(), format!("id-{h}"), off);
        let rows = vec![r("t1", "a", false), r("t1", "b", true), r("t2", "c", false)];
        let LeadPick::One(t, m) = lead_team_pick(&rows, &["a".into(), "b".into()]) else {
            panic!("one team");
        };
        assert_eq!(t, "t1");
        assert_eq!(m.get("b"), Some(&("id-b".to_owned(), true)));
        assert_eq!(m.len(), 2);
        assert_eq!(
            lead_team_pick(&rows, &["a".into(), "c".into()]),
            LeadPick::NoTeam
        );
        assert_eq!(lead_team_pick(&[], &["a".into()]), LeadPick::NoTeam);
        let two = vec![r("t1", "a", false), r("t2", "a", false)];
        let LeadPick::One(t, _) = lead_team_pick(&two, &["a".into()]) else {
            panic!("first team");
        };
        assert_eq!(t, "t1");
        let two_rev = vec![r("t2", "a", false), r("t1", "a", false)];
        let LeadPick::One(t, _) = lead_team_pick(&two_rev, &["a".into()]) else {
            panic!("first team");
        };
        assert_eq!(t, "t2");
    }

    #[test]
    fn human_lead_takes_team_route() {
        let rows = vec![("t1".into(), "a".into(), "id-a".into(), false)];
        let team = lead_team_pick(&rows, &["a".into()]);
        assert_eq!(route_for(&team, false), Route::Team);
        assert_eq!(route_for(&team, true), Route::Team);
        let none = lead_team_pick(&rows, &["b".into()]);
        assert_eq!(route_for(&none, false), Route::NotAgent);
        assert_eq!(route_for(&none, true), Route::Gate);
        assert!(service_call_for(false));
        assert!(!service_call_for(true));
    }
}
