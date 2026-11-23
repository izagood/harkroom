//! S5.3 C3a-3b-2 — 「누구를 부르나」 판정. TS `services/messages.ts` 의 `resolveMentionCalls`(1074행)를 옮긴다.
//!
//! - 본문 파싱은 [`super::mention_parse`](C3a-3a, TS 와 골든 대조), 호출 게이트는 [`super::invoke_gate`](C3a-3b-1)를 쓴다.
//! - **사슬 상한은 없다**(O1): 홉 수(`mention_policy.chain_limit`)·사슬 나이(24시간)로 에이전트 부름을 막던 검사를 걷었다.
//!   부름을 막는 것은 호출 게이트뿐이다. TS `resolveMentionCalls` 와 여기서 갈린다.
//! - **principal**(이번 턴을 깨운 사람): 에이전트 글의 막힌 계정 부름을 그 사람 권한으로 다시 잰다(`mayInvoke(대상, principal)`).
//!   스위치 `HARKROOM_PRINCIPAL_INVOKE`(off·0·false 면 그림자만)와 하루 상한 200(최근 24시간 `invokedAsPrincipal` 글 수).
//! - 읽기만 한다(inbox 넣기는 C3a-3b-3). 모든 조회는 받은 연결 하나로 — 글 쓰기 트랜잭션 안에서 부른다.
//! - **오류는 그대로 돌려준다**(`?`). DB 오류를 「부를 수 있음」·「상한 아래」로 읽지 않는다 — TS 처럼 글 쓰기 전체를 실패시키는 것은
//!   호출부 몫이다(security #2182 조건).
use super::invoke_gate::{self, Ctx, TeamFacts, Via};
use super::mention_parse::{
    Target, TargetKind, head_mention_run_end, mentioned_handles, mentioned_ids, normalize_mentions,
    split_mention_calls,
};
use serde_json::{Map, Value, json};
use sqlx::PgConnection;
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

fn golden(k: &str) -> String {
    static G: OnceLock<Value> = OnceLock::new();
    let v = G.get_or_init(|| {
        serde_json::from_str(include_str!("../../golden/sql_fragments.json"))
            .expect("golden/sql_fragments.json")
    });
    v[k].as_str()
        .unwrap_or_else(|| panic!("golden fragment {k}"))
        .to_string()
}

/// 이 모듈이 쓰는 문장 — 전부 TS 상수(`messages.ts`·`teams.ts`·`handleGroups.ts`·`mentionPolicy.ts`·`invokePrincipal.ts`)를 골든으로
/// 받아 감싼다. 값·조건·순서는 TS 그대로이고, 감싸는 쪽은 칸을 text 로 읽기만 한다.
struct Sql {
    accounts_by_handles: String,
    accounts_by_ids: String,
    group_by_handle: String,
    team_by_id: String,
    team_by_name: String,
    team_members: String,
    principal_invokes: String,
}

fn sql() -> &'static Sql {
    static S: OnceLock<Sql> = OnceLock::new();
    S.get_or_init(|| {
        let team = |k: &str| {
            format!(
                "select t.id::text, t.name, t.\"leadAccountId\"::text, t.\"invokeScope\", t.\"ownerAccountId\"::text from ({}) t",
                golden(k)
            )
        };
        let accounts =
            |k: &str| format!("select a.id::text, a.handle, a.kind from ({}) a", golden(k));
        Sql {
            accounts_by_handles: accounts("mc_accounts_by_handles"),
            accounts_by_ids: accounts("mc_accounts_by_ids"),
            group_by_handle: format!("select g.id::text from ({}) g", golden("mc_group_by_handle")),
            team_by_id: team("mc_team_by_id"),
            team_by_name: team("mc_team_by_name"),
            team_members: format!(
                "select m.\"accountId\"::text, m.handle, m.disabled from ({}) m order by m.handle",
                golden("mc_team_members")
            ),
            principal_invokes: format!(
                "select q.n::int8 from ({}) q",
                golden("mc_principal_invokes")
            ),
        }
    })
}

/// TS `PRINCIPAL_INVOKE_DAILY_CAP`(invokePrincipal.ts).
pub const PRINCIPAL_INVOKE_DAILY_CAP: i64 = 200;
/// shared `CHANNEL_MENTION_HANDLE`.
pub const CHANNEL_MENTION_HANDLE: &str = "channel";

/// TS `principalInvokeEnabled` — 비었거나 모르는 값이면 켬. `off`·`0`·`false` 만 끔.
pub fn principal_invoke_enabled(raw: Option<&str>) -> bool {
    let v = raw.unwrap_or("").trim().to_lowercase();
    !(v == "off" || v == "0" || v == "false")
}

pub struct Principal<'a> {
    pub id: &'a str,
}

pub struct Input<'a> {
    pub body: &'a str,
    pub channel_id: &'a str,
    pub author_id: &'a str,
    pub author_is_agent: bool,
    pub reply_grant_thread_id: Option<&'a str>,
    pub principal: Option<Principal<'a>>,
    /// 지금(밀리초) — TS `Date.now()`. 시험이 고정할 수 있게 받는다.
    pub now_ms: i64,
    /// `HARKROOM_PRINCIPAL_INVOKE` 판정 결과([`principal_invoke_enabled`]) — 값이 없으면 TS 기본값(켬)이다.
    pub principal_invoke_enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TeamPlan {
    pub team_id: String,
    pub recipients: Vec<String>,
    pub via_lead: bool,
}

/// TS `ResolvedMentionCalls`.
#[derive(Debug, Clone, PartialEq)]
pub struct Resolved {
    pub normalized_body: String,
    /// 계정으로 처리한 이름(본문 글자 기준, 소문자).
    pub account_handles: HashSet<String>,
    pub called_ids: Vec<String>,
    pub denied_ids: HashSet<String>,
    pub team_plans: Vec<TeamPlan>,
    pub target_call: Vec<Target>,
    pub channel_called: bool,
    /// 글 `meta` 에 얹는 칸 — TS 와 같은 키 순서.
    pub call_meta: Map<String, Value>,
    /// A1 측정 — 깨우지 못한 호출 (대상, 이유). 대상마다 한 줄. 판정에는 쓰지 않는다.
    pub missed: Vec<(String, &'static str)>,
    /// C1 — `missed` 가운데 에이전트 계정만 handle 로(팀·집합 토큰은 뺀다). principal 이 열어 준 부름은 깨웠으므로 뺀다.
    /// 도구 결과의 경고(`mention_not_called`)에만 쓴다 — 판정·기록에는 쓰지 않는다.
    pub missed_handles: Vec<(String, &'static str)>,
}

#[derive(Clone)]
struct Acct {
    id: String,
    handle: String,
    kind: String,
}

async fn accounts_by_handles(
    conn: &mut PgConnection,
    handles: &[String],
) -> Result<Vec<Acct>, sqlx::Error> {
    if handles.is_empty() {
        return Ok(vec![]);
    }
    let rows: Vec<(String, String, String)> = sqlx::query_as(sql().accounts_by_handles.as_str())
        .bind(handles)
        .fetch_all(&mut *conn)
        .await?;
    Ok(rows
        .into_iter()
        .map(|(id, handle, kind)| Acct { id, handle, kind })
        .collect())
}

async fn accounts_by_ids(
    conn: &mut PgConnection,
    ids: &[String],
) -> Result<Vec<Acct>, sqlx::Error> {
    if ids.is_empty() {
        return Ok(vec![]);
    }
    let rows: Vec<(String, String, String)> = sqlx::query_as(sql().accounts_by_ids.as_str())
        .bind(ids)
        .fetch_all(&mut *conn)
        .await?;
    Ok(rows
        .into_iter()
        .map(|(id, handle, kind)| Acct { id, handle, kind })
        .collect())
}

/// C1 `agent.call` — `to` 인자(handle·계정 id)를 계정으로. 본문 멘션과 같은 문장을 쓴다. `(id, handle, kind)`.
pub(crate) async fn accounts_for_call(
    conn: &mut PgConnection,
    handles: &[String],
    ids: &[String],
) -> Result<Vec<(String, String, String)>, sqlx::Error> {
    let mut out = accounts_by_handles(conn, handles).await?;
    out.extend(accounts_by_ids(conn, ids).await?);
    Ok(out.into_iter().map(|a| (a.id, a.handle, a.kind)).collect())
}

/// TS `principalInvokesToday`.
async fn principal_invokes_today(
    conn: &mut PgConnection,
    principal: &str,
    now_ms: i64,
) -> Result<i64, sqlx::Error> {
    // TS 는 `now - 24h` 를 Date 로 넘긴다 — 같은 순간을 ISO 글자로 넘긴다(문장이 `$2::timestamptz`).
    let since = now_ms - 24 * 60 * 60_000;
    let iso: String = sqlx::query_scalar(
        "select to_char(to_timestamp($1::float8 / 1000) at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')",
    )
    .bind(since as f64)
    .fetch_one(&mut *conn)
    .await?;
    sqlx::query_scalar(sql().principal_invokes.as_str())
        .bind(principal)
        .bind(iso)
        .fetch_one(&mut *conn)
        .await
}

/// (id, 이름, 팀장, 범위, 소유자).
type TeamRow = (String, String, Option<String>, String, Option<String>);

struct Team {
    id: String,
    name: String,
    lead: Option<String>,
    scope: String,
    owner: Option<String>,
}

async fn team_where(
    conn: &mut PgConnection,
    q: &'static str,
    arg: &str,
) -> Result<Option<Team>, sqlx::Error> {
    let r: Option<TeamRow> = sqlx::query_as(q)
        .bind(arg)
        .fetch_optional(&mut *conn)
        .await?;
    Ok(r.map(|(id, name, lead, scope, owner)| Team {
        id,
        name,
        lead,
        scope,
        owner,
    }))
}

/// TS `listTeamMembers` — (계정, handle, 비활성) handle 순.
async fn team_members(
    conn: &mut PgConnection,
    team: &str,
) -> Result<Vec<(String, String, bool)>, sqlx::Error> {
    sqlx::query_as(sql().team_members.as_str())
        .bind(team)
        .fetch_all(&mut *conn)
        .await
}

/// TS `getHandleGroupByHandle` 의 id 만.
async fn group_id_by_handle(
    conn: &mut PgConnection,
    handle: &str,
) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar(sql().group_by_handle.as_str())
        .bind(handle)
        .fetch_optional(&mut *conn)
        .await
}

fn target_key(t: &Target) -> String {
    format!("{}:{}", t.kind.as_str(), t.id)
}

/// TS `resolveMentionCalls`.
pub async fn resolve(conn: &mut PgConnection, input: &Input<'_>) -> Result<Resolved, sqlx::Error> {
    let body_handles = mentioned_handles(input.body);
    let mentioned = accounts_by_handles(conn, &body_handles).await?;
    let mut handle_to_id: HashMap<String, String> = HashMap::new();
    for a in &mentioned {
        handle_to_id.insert(a.handle.clone(), a.id.clone());
    }
    let mut name_to_token = handle_to_id.clone();
    for h in &body_handles {
        if h == CHANNEL_MENTION_HANDLE || name_to_token.contains_key(h) {
            continue;
        }
        if let Some(g) = group_id_by_handle(conn, h).await? {
            name_to_token.insert(h.clone(), format!("group:{g}"));
            continue;
        }
        if let Some(t) = team_where(conn, sql().team_by_name.as_str(), h).await? {
            name_to_token.insert(h.clone(), format!("team:{}", t.id));
        }
    }
    let normalized = normalize_mentions(input.body, &name_to_token);

    let known: HashSet<&str> = mentioned.iter().map(|a| a.id.as_str()).collect();
    let raw_ids: Vec<String> = mentioned_ids(&normalized)
        .into_iter()
        .filter(|id| !known.contains(id.as_str()))
        .collect();
    let token_accounts = accounts_by_ids(conn, &raw_ids).await?;
    let called_accounts: Vec<Acct> = mentioned.iter().cloned().chain(token_accounts).collect();
    let agent_ids: HashSet<String> = called_accounts
        .iter()
        .filter(|a| a.kind == "agent")
        .map(|a| a.id.clone())
        .collect();
    let split = split_mention_calls(&normalized, input.author_is_agent, |id| {
        agent_ids.contains(id)
    });

    // 호출 게이트 — 행 순서 그대로(TS `Map` 순서).
    let gate_ids: Vec<String> = split
        .call
        .iter()
        .filter(|id| *id != input.author_id)
        .cloned()
        .collect();
    let gate_facts = invoke_gate::invoke_facts_ordered(conn, &gate_ids).await?;
    let mut denied_order: Vec<String> = vec![];
    for f in &gate_facts {
        let ctx = Ctx {
            caller_id: input.author_id,
            channel_id: input.channel_id,
            via: Via::Mention,
            reply_grant_thread_id: input.reply_grant_thread_id,
        };
        if !invoke_gate::may_invoke(conn, f, &ctx).await? {
            denied_order.push(f.agent_id.clone());
        }
    }

    // A1 측정 — 호출 누락. 에이전트 글이 머리 런 밖에서 에이전트·팀을 적어 깨우지 못한 멘션(`reference`)과 호출 게이트가 막은 부름.
    // 여기서는 모으기만 한다 — 기록은 부른 쪽이 (글, 대상)마다 한 번(`measure::calls_missed`). 고치기는 새로 적힌 대상만 센다.
    let mut missed: Vec<(String, &'static str)> = vec![];
    if input.author_is_agent {
        missed.extend(
            split
                .reference
                .iter()
                .map(|id| (id.clone(), "not_head_mention")),
        );
        missed.extend(
            split
                .target_ref
                .iter()
                .map(|t| (target_key(t), "not_head_mention")),
        );
        missed.extend(denied_order.iter().map(|id| (id.clone(), "gate_denied")));
        let mut seen: HashSet<String> = HashSet::new();
        missed.retain(|(r, _)| seen.insert(r.clone()));
    }
    let mut principal_shadow: Option<Value> = None;
    let mut invoked_as_principal: Option<Value> = None;
    let mut denied_principal: Option<&'static str> = None;
    if input.author_is_agent && !denied_order.is_empty() {
        match &input.principal {
            None => denied_principal = Some("none"),
            Some(p) => {
                let mut opened: Vec<String> = vec![];
                for id in &denied_order {
                    if let Some(f) = gate_facts.iter().find(|f| &f.agent_id == id) {
                        let ctx = Ctx {
                            caller_id: p.id,
                            channel_id: input.channel_id,
                            via: Via::Mention,
                            reply_grant_thread_id: None,
                        };
                        if invoke_gate::may_invoke(conn, f, &ctx).await? {
                            opened.push(id.clone());
                        }
                    }
                }
                let record = (!opened.is_empty()).then(|| {
                    json!({
                        "principalId": p.id,
                        "handles": called_accounts.iter().filter(|a| opened.contains(&a.id)).map(|a| a.handle.clone()).collect::<Vec<_>>(),
                        "ids": opened,
                    })
                });
                if let Some(rec) = record {
                    if !input.principal_invoke_enabled {
                        principal_shadow = Some(rec);
                    } else if principal_invokes_today(conn, p.id, input.now_ms).await?
                        < PRINCIPAL_INVOKE_DAILY_CAP
                    {
                        let ids: Vec<String> = rec["ids"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(|v| v.as_str().map(str::to_string))
                            .collect();
                        denied_order.retain(|d| !ids.contains(d));
                        invoked_as_principal = Some(rec);
                    } else {
                        denied_principal = Some("capped");
                    }
                }
                if !denied_order.is_empty() && denied_principal.is_none() {
                    denied_principal = Some("denied");
                }
            }
        }
    }
    let denied: HashSet<String> = denied_order.iter().cloned().collect();
    let mut denied_handles: Vec<String> = called_accounts
        .iter()
        .filter(|a| denied.contains(&a.id))
        .map(|a| a.handle.clone())
        .collect();

    // 팀 부름도 insert 앞에서 판정한다(068) — 누구를 깨울지(`team_plans`)까지.
    let mut team_plans: Vec<TeamPlan> = vec![];
    for target in &split.target_call {
        if target.kind != TargetKind::Team {
            continue;
        }
        let Some(team) = team_where(conn, sql().team_by_id.as_str(), &target.id).await? else {
            continue;
        };
        let tf = TeamFacts {
            team_id: team.id.clone(),
            invoke_scope: team.scope.clone(),
            owner_account_id: team.owner.clone(),
        };
        if !invoke_gate::may_invoke_team(conn, &tf, input.author_id, input.channel_id).await? {
            if !denied_handles.contains(&team.name) {
                denied_handles.push(team.name.clone());
            }
            continue;
        }
        let awake: Vec<(String, String, bool)> = team_members(conn, &team.id)
            .await?
            .into_iter()
            .filter(|(id, _, disabled)| !disabled && id != input.author_id)
            .collect();
        let member_ids: Vec<String> = awake.iter().map(|(id, _, _)| id.clone()).collect();
        let member_facts = invoke_gate::invoke_facts(conn, &member_ids).await?;
        let mut allowed: Vec<String> = vec![];
        for (id, _, _) in &awake {
            let ok = match member_facts.get(id) {
                None => true,
                Some(f) => {
                    let ctx = Ctx {
                        caller_id: input.author_id,
                        channel_id: input.channel_id,
                        via: Via::Team,
                        reply_grant_thread_id: None,
                    };
                    invoke_gate::may_invoke(conn, f, &ctx).await?
                }
            };
            if ok {
                allowed.push(id.clone());
            }
        }
        let lead = team
            .lead
            .as_deref()
            .and_then(|l| awake.iter().find(|(id, _, _)| id == l));
        if let Some((lead_id, _, _)) = lead
            && allowed.contains(lead_id)
        {
            team_plans.push(TeamPlan {
                team_id: team.id.clone(),
                recipients: vec![lead_id.clone()],
                via_lead: true,
            });
            continue;
        }
        for (id, handle, _) in &awake {
            if !allowed.contains(id) && !denied_handles.contains(handle) {
                denied_handles.push(handle.clone());
            }
        }
        team_plans.push(TeamPlan {
            team_id: team.id.clone(),
            recipients: allowed,
            via_lead: false,
        });
    }

    let mut ref_ids_for_meta: Vec<String> = split
        .reference
        .iter()
        .filter(|id| *id != input.author_id)
        .cloned()
        .collect();
    ref_ids_for_meta.extend(split.target_ref.iter().map(target_key));

    let account_handles: HashSet<String> = handle_to_id.keys().cloned().collect();
    let channel_called = if input.author_is_agent {
        mentioned_handles(&normalized[..head_mention_run_end(&normalized)])
            .iter()
            .any(|h| h == CHANNEL_MENTION_HANDLE)
    } else {
        body_handles.iter().any(|h| h == CHANNEL_MENTION_HANDLE)
    };

    let mut meta = Map::new();
    if !denied_handles.is_empty() {
        meta.insert("mentionDenied".into(), json!(denied_handles));
    }
    if let Some(v) = principal_shadow {
        meta.insert("mentionPrincipalShadow".into(), v);
    }
    if let Some(v) = invoked_as_principal {
        meta.insert("invokedAsPrincipal".into(), v);
    }
    if let Some(r) = denied_principal
        && !denied.is_empty()
    {
        meta.insert("mentionDeniedPrincipal".into(), json!(r));
    }
    if !ref_ids_for_meta.is_empty() {
        meta.insert("mentionRefs".into(), json!(ref_ids_for_meta));
    }
    let target_call: Vec<Target> = split.target_call.clone();
    let missed_handles: Vec<(String, &'static str)> = missed
        .iter()
        .filter(|(r, why)| *why != "gate_denied" || denied.contains(r))
        .filter_map(|(r, why)| {
            called_accounts
                .iter()
                .find(|a| a.kind == "agent" && &a.id == r)
                .map(|a| (a.handle.clone(), *why))
        })
        .collect();
    Ok(Resolved {
        normalized_body: normalized,
        account_handles,
        called_ids: split.call,
        denied_ids: denied,
        team_plans,
        target_call,
        channel_called,
        call_meta: meta,
        missed,
        missed_handles,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn principal_switch_like_ts() {
        // 없거나 비거나 모르는 낱말이면 켬(TS 기본값) — 「모름」은 없다.
        assert!(principal_invoke_enabled(None));
        assert!(principal_invoke_enabled(Some("")));
        assert!(principal_invoke_enabled(Some("  ")));
        assert!(principal_invoke_enabled(Some("weird")));
        assert!(principal_invoke_enabled(Some("on")));
        for off in ["off", "0", "false", " OFF ", "False"] {
            assert!(!principal_invoke_enabled(Some(off)), "{off}");
        }
    }

    #[test]
    fn constants_like_ts() {
        assert_eq!(PRINCIPAL_INVOKE_DAILY_CAP, 200);
    }
}
