//! S5.3 C3a-3b-1 — 호출 게이트: **누가 누구를 부를 수 있나**. TS `services/invokeGate.ts`(`invokeFactsFor`·`mayInvoke`·
//! `isEligibleDelegate`·`mayInvokeTeam`·`passesScope`)와 `replyGrants.ts::hasReplyGrant` 를 함수 하나씩 그대로 옮긴다.
//!
//! - 문장은 TS 정본 그대로 — `golden/sql_fragments.json` 의 `invoke_*` 키(`rustSqlFragments.test.ts` 가 바이트로 대조).
//! - 판정 순서도 TS 와 같다: 꺼진 에이전트 거절 → `community` 통과 → 부름 길이 `mention`·`team` 이 아니면 거절 → 범위(owner·list·channel)
//!   → `owner` 범위의 대리 호출자(073, 명단 기준) → 회신권(084, `mention` 이고 스레드가 있을 때만).
//! - 모든 조회는 받은 연결 하나로 한다(트랜잭션 안에서도 쓸 수 있게 — 판정·inbox 쓰기를 한 트랜잭션에 묶는 C3a-3b-2·3c 가 부른다).
//!   아직 어느 라우트에도 붙지 않는다.
use serde_json::Value;
use sqlx::PgConnection;
use std::collections::HashMap;
use std::sync::OnceLock;

/// TS `InvokeVia`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Via {
    Mention,
    Team,
    Group,
    ChannelAll,
    AutoMention,
}

impl Via {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "mention" => Via::Mention,
            "team" => Via::Team,
            "group" => Via::Group,
            "channel_all" => Via::ChannelAll,
            "auto_mention" => Via::AutoMention,
            _ => return None,
        })
    }
}

/// TS `AgentInvokeFacts`. `invoke_scope` 는 DB 글자 그대로 둔다 — 모르는 값은 [`passes_scope`] 에서 거절(TS `switch` 가 undefined).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentFacts {
    pub agent_id: String,
    pub invoke_scope: String,
    pub owner_account_id: Option<String>,
    pub off: bool,
}

/// TS `TeamInvokeFacts`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TeamFacts {
    pub team_id: String,
    pub invoke_scope: String,
    pub owner_account_id: Option<String>,
}

pub struct Ctx<'a> {
    pub caller_id: &'a str,
    pub channel_id: &'a str,
    pub via: Via,
    pub reply_grant_thread_id: Option<&'a str>,
}

struct Sql {
    facts: String,
    agent_invoker: String,
    eligible_delegate: String,
    team_invoker: String,
    channel_scope: String,
    reply_grant: String,
}

fn sql() -> &'static Sql {
    static S: OnceLock<Sql> = OnceLock::new();
    S.get_or_init(|| {
        let v: Value = serde_json::from_str(include_str!("../../golden/sql_fragments.json"))
            .expect("golden/sql_fragments.json");
        let frag = |k: &str| {
            v[k].as_str()
                .unwrap_or_else(|| panic!("golden fragment {k}"))
                .to_string()
        };
        Sql {
            // id 는 text 로 받는다(sqlx 가 uuid 를 모르는 꼴로 읽지 않게) — 나머지 칸은 TS 문장 그대로.
            facts: format!(
                "select f.id::text, f.invoke_scope, f.owner_account_id::text, f.off from ({}) f",
                frag("invoke_facts")
            ),
            agent_invoker: frag("invoke_agent_invoker"),
            eligible_delegate: frag("invoke_eligible_delegate"),
            team_invoker: frag("invoke_team_invoker"),
            channel_scope: frag("invoke_channel_scope"),
            reply_grant: frag("invoke_has_reply_grant"),
        }
    })
}

async fn exists(
    conn: &mut PgConnection,
    q: &'static str,
    binds: &[&str],
) -> Result<bool, sqlx::Error> {
    let mut query = sqlx::query_scalar::<_, i32>(q);
    for b in binds {
        query = query.bind(*b);
    }
    Ok(query.fetch_optional(&mut *conn).await?.is_some())
}

/// TS `invokeFactsFor` — 에이전트가 아닌 id 는 빠진다(호출부는 「facts 없음 = 게이트 대상 아님(사람)」으로 읽는다).
pub async fn invoke_facts(
    conn: &mut PgConnection,
    agent_ids: &[String],
) -> Result<HashMap<String, AgentFacts>, sqlx::Error> {
    if agent_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows: Vec<(String, String, Option<String>, bool)> = sqlx::query_as(sql().facts.as_str())
        .bind(agent_ids)
        .fetch_all(&mut *conn)
        .await?;
    Ok(rows
        .into_iter()
        .map(|(id, scope, owner, off)| {
            (
                id.clone(),
                AgentFacts {
                    agent_id: id,
                    invoke_scope: scope,
                    owner_account_id: owner,
                    off,
                },
            )
        })
        .collect())
}

/// [`invoke_facts`] 와 같은 조회를 **행 순서 그대로** 돌려준다 — TS 는 `Map` 의 넣은 순서(= 조회 행 순서)로 훑으므로,
/// 순서가 결과에 실리는 자리(`resolveMentionCalls` 의 principal 로 연 부름 목록)는 이것을 쓴다.
pub async fn invoke_facts_ordered(
    conn: &mut PgConnection,
    agent_ids: &[String],
) -> Result<Vec<AgentFacts>, sqlx::Error> {
    if agent_ids.is_empty() {
        return Ok(vec![]);
    }
    let rows: Vec<(String, String, Option<String>, bool)> = sqlx::query_as(sql().facts.as_str())
        .bind(agent_ids)
        .fetch_all(&mut *conn)
        .await?;
    Ok(rows
        .into_iter()
        .map(|(id, scope, owner, off)| AgentFacts {
            agent_id: id,
            invoke_scope: scope,
            owner_account_id: owner,
            off,
        })
        .collect())
}

/// TS `passesScope` — 팀과 에이전트가 같은 몸통을 쓴다(`list_sql` 만 다르다).
async fn passes_scope(
    conn: &mut PgConnection,
    scope: &str,
    owner: Option<&str>,
    caller: &str,
    channel: &str,
    list_sql: &'static str,
    subject: &str,
) -> Result<bool, sqlx::Error> {
    match scope {
        "community" => Ok(true),
        "owner" => Ok(owner == Some(caller)),
        "list" => exists(conn, list_sql, &[subject, caller]).await,
        "channel" => {
            if channel.is_empty() {
                return Ok(false);
            }
            exists(conn, sql().channel_scope.as_str(), &[channel, caller]).await
        }
        _ => Ok(false),
    }
}

/// TS `isEligibleDelegate`.
pub async fn is_eligible_delegate(
    conn: &mut PgConnection,
    agent_id: &str,
    owner_account_id: Option<&str>,
    delegate_id: &str,
    listed: bool,
) -> Result<bool, sqlx::Error> {
    let Some(owner) = owner_account_id else {
        return Ok(false);
    };
    if delegate_id == agent_id {
        return Ok(false);
    }
    Ok(
        sqlx::query_scalar::<_, i32>(sql().eligible_delegate.as_str())
            .bind(delegate_id)
            .bind(owner)
            .bind(agent_id)
            .bind(listed)
            .fetch_optional(&mut *conn)
            .await?
            .is_some(),
    )
}

/// TS `hasReplyGrant`.
pub async fn has_reply_grant(
    conn: &mut PgConnection,
    grantee_id: &str,
    granter_id: &str,
    thread_root_id: &str,
) -> Result<bool, sqlx::Error> {
    exists(
        conn,
        sql().reply_grant.as_str(),
        &[grantee_id, granter_id, thread_root_id],
    )
    .await
}

/// TS `mayInvoke`.
pub async fn may_invoke(
    conn: &mut PgConnection,
    facts: &AgentFacts,
    ctx: &Ctx<'_>,
) -> Result<bool, sqlx::Error> {
    if facts.off {
        return Ok(false);
    }
    if facts.invoke_scope == "community" {
        return Ok(true);
    }
    if ctx.via != Via::Mention && ctx.via != Via::Team {
        return Ok(false);
    }
    if passes_scope(
        conn,
        &facts.invoke_scope,
        facts.owner_account_id.as_deref(),
        ctx.caller_id,
        ctx.channel_id,
        sql().agent_invoker.as_str(),
        &facts.agent_id,
    )
    .await?
    {
        return Ok(true);
    }
    if facts.invoke_scope == "owner"
        && is_eligible_delegate(
            conn,
            &facts.agent_id,
            facts.owner_account_id.as_deref(),
            ctx.caller_id,
            true,
        )
        .await?
    {
        return Ok(true);
    }
    match (ctx.via, ctx.reply_grant_thread_id) {
        (Via::Mention, Some(thread)) => {
            has_reply_grant(conn, ctx.caller_id, &facts.agent_id, thread).await
        }
        _ => Ok(false),
    }
}

/// TS `mayInvokeTeam`.
pub async fn may_invoke_team(
    conn: &mut PgConnection,
    facts: &TeamFacts,
    caller_id: &str,
    channel_id: &str,
) -> Result<bool, sqlx::Error> {
    if facts.invoke_scope == "community" {
        return Ok(true);
    }
    passes_scope(
        conn,
        &facts.invoke_scope,
        facts.owner_account_id.as_deref(),
        caller_id,
        channel_id,
        sql().team_invoker.as_str(),
        &facts.team_id,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn golden_sql_loads() {
        let s = sql();
        assert!(s.facts.contains("any($1::uuid[])"));
        assert!(s.eligible_delegate.contains("$4::bool"));
        assert!(s.channel_scope.contains("ch.kind <> 'dm'"));
        assert!(s.reply_grant.contains("expires_at > now()"));
    }

    #[test]
    fn via_names_like_ts() {
        for v in ["mention", "team", "group", "channel_all", "auto_mention"] {
            assert!(Via::parse(v).is_some(), "{v}");
        }
        assert!(Via::parse("x").is_none());
    }
}
