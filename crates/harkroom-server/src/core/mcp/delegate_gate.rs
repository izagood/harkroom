//! S5.3 C3b-2c-4a — MCP `message.delegate` 의 **게이트·상한**(거절 갈래)만 Rust 가 답한다. TS `mcp/mcpPlugin.ts` 의 같은 도구를
//! 위에서부터 옮긴다: 채널 가시성 → 자기 위임 → 팀장 명단 → 에이전트만 → 호출 게이트(`openDelegationTargets`) → 라운드 상한(`roundsUsed`).
//!
//! - Rust 가 답하는 것: `forbidden` · `self_delegation` · `not_agent` · `not_invokable` · `round_limit` — 모두 **아무것도 쓰지 않는** 거절이다.
//! - C3b-2c-4b: 게이트를 지난 요청도 맡는다 — 접속 확인 → 위임 글(`meta.kind = 'delegation'`) → 같은 tx 의 사슬 상한·의무
//!   ([`crate::core::delegate_write`]) → 이벤트. 쓰기 칸(`McpWrites::delegate`)이 없으면 지금처럼 TS 로 넘긴다.
//! - S5.4-11c: 팀장 **에이전트**가 `to` 전원을 담는 자기 팀 **하나**에 넘기는 요청(팀 명단 갈래)도 맡는다 — TS 처럼 호출 게이트·
//!   사슬 상한을 건너뛰고 팀 명단의 (계정, 꺼짐)으로 접속을 본 뒤 위임 행·부름에 `team_id` 를 적는다. `to` 를 담는 팀이 둘 이상이면
//!   TS 처럼 같은 문장의 행 순서 첫 팀(S5.4-14c). 팀장이 사람이면 TS 로 넘긴다.
//! - S5.4-14c: 비지 않은 `agentModels` 도 맡는다 — 접속 확인 뒤 TS `preparePicks`([`super::msg_post::check_picks`]), 글 tx 의
//!   `applyAgentPicks`(`notified` 에 넘겨받는 팀원을 더한다), 커밋 뒤 시스템 줄·이벤트. 하네스 목록(`relay_moved`)·고르기 쓰기 권한
//!   (`AGENT_MODEL_PICKS_PRIVILEGES`)이 없으면 TS.
//! - **TS 로 넘기는 것**(`None` — fail-closed): 위 밖의 팀 명단 갈래 · 권한 없는 `agentModels` · `planRootId`·`planGroupId`
//!   (계획판) · zod 가 받지 않을 인자 · 자른 자리가 서로게이트 쌍을 가르는 모델 신고 · `to` 에 같은 이름이 두 번 · 위임 스위치를 모름 · DB 오류.
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

/// TS `TEAM_ROUND_LIMIT`(shared).
const TEAM_ROUND_LIMIT: i64 = 3;
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
    rounds: String,
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
            rounds: frag("delegate_rounds_used"),
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
}

/// zod `message.delegate` 의 `inputSchema` 중 Rust 가 맡는 것. 틀린 꼴·비지 않은 `agentModels`·계획판 칸은 `None`.
fn parse(args: &Value) -> Option<Args> {
    let Value::Object(o) = args else { return None };
    for k in ["planRootId", "planGroupId"] {
        if o.contains_key(k) {
            return None;
        }
    }
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
        Some(Value::Number(d)) => d
            .as_i64()
            .filter(|d| (DEADLINE_MIN..=DEADLINE_MAX).contains(d))?,
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

/// TS 도구는 서비스 `postMessage` 를 바로 부른다 — 라우트 몫(카드 고르기·`closeAsksByReply`)이 없다. 사람 작성자에게만 뜻이 있다
/// (에이전트 글은 그 갈래를 이미 타지 않는다) — 에이전트는 예전 그대로 끈다.
fn service_call_for(is_agent: bool) -> bool {
    !is_agent
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
    let a = parse(args)?;
    // 고르기는 하네스 목록·고르기 쓰기 권한이 다 있을 때만 — 아니면 아무것도 답하지 않고 TS.
    if !a.picks.is_empty() && !picks_ok {
        return None;
    }
    match channel_visible(pool, &me.id, &a.channel).await {
        Ok(true) => {}
        Ok(false) => return Some(err("forbidden", "not a member of this dm channel")),
        Err(_) => return None,
    }
    // TS `h.toLowerCase() === account.handle.toLowerCase()` — ASCII 밖 handle 은 JS 소문자 규칙을 맞추지 않고 넘긴다.
    if !me.handle.is_ascii() || a.to.iter().any(|h| !h.is_ascii()) {
        return None;
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
        .ok()?;
    let rows: Vec<(String, String, String, bool)> = rows
        .into_iter()
        .map(|(t, h, id, off)| (t, h.to_lowercase(), id, off))
        .collect();
    let pick = lead_team_pick(&rows, &wanted);
    let (team_id, members) = match (route_for(&pick, me.kind == "agent"), pick) {
        (Route::Team, LeadPick::One(t, m)) => (Some(t), m),
        (Route::NotAgent, _) => return Some(err("not_agent", "only agents delegate")),
        _ => match gate(pool, me, &a, &wanted).await? {
            Ok(m) => (None, m),
            Err(refused) => return Some(refused),
        },
    };
    rounds_then_write(
        pool,
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
async fn gate(
    pool: &PgPool,
    me: &Account,
    a: &Args,
    wanted: &[String],
) -> Option<Result<Members, String>> {
    let mut conn = pool.acquire().await.ok()?;
    let rows: Vec<(String, String, bool)> = sqlx::query_as(&*sql().targets)
        .bind(wanted)
        .fetch_all(&mut *conn)
        .await
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
    let facts = invoke_gate::invoke_facts(&mut conn, &ids).await.ok()?;
    let ctx = Ctx {
        caller_id: &me.id,
        channel_id: &a.channel,
        via: Via::Mention,
        reply_grant_thread_id: None,
    };
    let mut refused: Vec<String> = Vec::new();
    for (i, h) in wanted.iter().enumerate() {
        let fact = by_handle.get(h.as_str()).and_then(|id| facts.get(*id));
        let ok = match fact {
            Some(f) => invoke_gate::may_invoke(&mut conn, f, &ctx).await.ok()?,
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

/// 라운드 상한 → (쓰기 칸이 있으면) 위임 쓰기.
#[allow(clippy::too_many_arguments)]
async fn rounds_then_write(
    pool: &PgPool,
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
    // TS `roundsUsed` = `roundsUsedMany` 에 한 쌍 — (순번, 수) 한 줄.
    let (_, used): (i32, i32) = sqlx::query_as(&*sql().rounds)
        .bind(vec![a.root.clone()])
        .bind(vec![me.id.clone()])
        .fetch_one(pool)
        .await
        .ok()?;
    let used = i64::from(used);
    if used >= TEAM_ROUND_LIMIT {
        return Some(err(
            "round_limit",
            &format!(
                "이 스레드에서 이미 {used}번 넘겼다(상한 {TEAM_ROUND_LIMIT}) — 직접 하거나 사람에게 넘겨라"
            ),
        ));
    }
    // 게이트·상한을 다 지났다 — 쓰기 칸이 있으면 위임을 쓴다(C3b-2c-4b).
    let st = st?;
    let mut seen = std::collections::HashSet::new();
    if !wanted.iter().all(|h| seen.insert(h.as_str())) {
        return None;
    }
    write(
        st, me, a, wanted, members, team_id, used, cause, turn, operator,
    )
    .await
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
    used: i64,
    cause: Option<&str>,
    turn: Option<&str>,
    operator: bool,
) -> Option<String> {
    let mut ids: Vec<String> = Vec::with_capacity(wanted.len());
    for w in wanted {
        ids.push(members.get(w)?.0.clone());
    }
    let online: Vec<String> = sqlx::query_scalar(ONLINE_SQL)
        .bind(&ids)
        .fetch_all(&st.read)
        .await
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
    if delegated.is_empty() {
        return Some(super::respond::text_result(&format!(
            "{{\"delegated\":[],\"unreachable\":{},\"message\":null}}",
            Value::from(unreachable)
        )));
    }
    // TS `preparePicks` — 접속 확인 뒤, 글 앞.
    if let Some(refused) = super::msg_post::check_picks(st, &a.picks).await? {
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
    .ok()?;
    let is_dm = msg_post::channel_is_dm(&st.read, &a.channel).await.ok()?;
    let audience = audience_for(&st.read, &a.channel).await.ok()?.to_json();
    let origin = Origin {
        plan_auto_stamp: None,
        defer_inbox_events: false,
        chat_ask_rust: false,
        close_asks_after_commit: false,
        cause,
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
        chain_depth: None,
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
    .ok()?;
    match out {
        Outcome::ToTs | Outcome::Replayed(_) | Outcome::Rejected(_) => None,
        Outcome::ChainLimit => Some(err(
            "chain_limit",
            "이 사슬은 에이전트끼리의 호출 상한에 닿았다 — 사람에게 넘겨라",
        )),
        // 아무것도 쓰지 않았다 — 그 오류 글자는 TS 가 낸다.
        Outcome::BadThread | Outcome::BadAttachment => None,
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
            let inner = format!(
                "{{\"message\":{row},\"delegationId\":{},\"delegated\":{},\"unreachable\":{},\"deadlineAt\":{},\"roundsLeft\":{}}}",
                Value::from(delegation_id?),
                Value::from(delegated),
                Value::from(unreachable),
                Value::from(deadline_at),
                (TEAM_ROUND_LIMIT - used - 1).max(0)
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
    fn golden_sql_loads() {
        let s = sql();
        assert!(s.lead_team.contains("agent_team_member"));
        assert!(s.targets.contains("lower(handle) = any($1::text[])"));
        assert!(s.rounds.contains("with ordinality"));
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
            json!({ "channelId": C, "threadRootId": R, "body": "x", "to": ["a"], "planRootId": R }),
            json!({ "channelId": C, "threadRootId": R, "body": "x", "to": ["a"], "planGroupId": "g1" }),
            json!({ "channelId": C, "threadRootId": R, "body": "x", "to": ["a","a","a","a","a","a","a","a","a"] }),
        ] {
            assert_eq!(parse(&bad), None, "{bad}");
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
