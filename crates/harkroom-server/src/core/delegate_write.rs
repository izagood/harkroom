//! S5.3 C3b-2c-4b — MCP `message.delegate` 의 **쓰기**(게이트를 다 지난 요청). TS `mcp/mcpPlugin.ts` 의 같은 도구 뒷부분 —
//! `postMessage` 의 `beforeCommit`(`delegationChainCapped`) 과 그 뒤의 `createDelegation`(`services/delegations.ts`) — 을
//! [`super::msg_post::post_tx`] 안에서 **글과 같은 tx** 로 한다.
//!
//! - TS 는 글을 커밋한 뒤 다른 tx 로 의무를 만든다(그 사이 실패하면 `delegation_failed` — 글만 남는다). Rust 는 한 tx 라 그 창이 없다:
//!   의무를 못 만들면 글도 남지 않고 TS 로 넘긴다. 성공한 결과는 같다.
//! - 문장은 전부 TS 상수를 골든(`delegation_insert`·`delegation_item_insert`·`delegate_supersede`·`delegate_mark_settled_quietly`·
//!   `delegate_inbox_convert`·`delegate_inbox_insert`)으로 받는다.
//! - 팀장이 자기 팀에 넘기는 갈래(`team_id`)는 아직 TS 몫이다 — 여기 오는 위임은 언제나 `team_id = null`·`kind = 'delegate'` 이다.
use super::mention_calls::{self, CHAIN_BACKSTOP_MS};
use serde_json::Value;
use sqlx::PgConnection;
use std::sync::OnceLock;

/// 이 갈래가 글 쓰기 권한([`super::msg_post::MESSAGE_POST_PRIVILEGES`]·`MCP_POST_EXTRA_PRIVILEGES`) 위에 더 쓰는 권한.
/// 하나라도 없으면 게이트를 지난 위임은 지금처럼 TS 로 넘긴다(fail-closed). inbox INSERT·`team_delegation(_item)` INSERT 는
/// 부름·암묵 위임 묶음에 이미 있다.
pub const DELEGATE_WRITE_PRIVILEGES: &[(&str, &str)] = &[
    ("team_delegation", "INSERT"),
    ("team_delegation_item", "INSERT"),
    ("team_delegation_item.closed_reason", "UPDATE"),
    ("inbox.reason", "UPDATE"),
    ("inbox.team_id", "UPDATE"),
];

/// 같은 tx 에서 만들 위임 — 게이트를 지난 대상(접속한 에이전트)만.
#[derive(Debug)]
pub(crate) struct Plan<'a> {
    /// `to` 순서의 대상 계정 id(중복 없음).
    pub(crate) delegate_ids: &'a [String],
    /// TS `deadlineAt.toISOString()`.
    pub(crate) deadline_at: &'a str,
}

struct Sql {
    insert: String,
    item: String,
    supersede: String,
    settled: String,
    convert: String,
    inbox: String,
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
            insert: frag("delegation_insert"),
            item: frag("delegation_item_insert"),
            supersede: frag("delegate_supersede"),
            settled: frag("delegate_mark_settled_quietly"),
            convert: frag("delegate_inbox_convert"),
            inbox: frag("delegate_inbox_insert"),
        }
    })
}

/// TS `delegationChainCapped` — 막 쓴 글의 사슬 깊이가 상한(`mention_policy.chain_limit`)에 닿았거나 사슬이 24시간을 넘었는가.
/// 글 행을 그대로 읽는다(TS 와 같이 `beforeCommit` 자리, 같은 tx).
pub(crate) async fn chain_capped(
    conn: &mut PgConnection,
    message_id: &str,
    now_ms: i64,
) -> Result<bool, sqlx::Error> {
    let row: Option<(i32, Option<i64>)> = sqlx::query_as(
        "select mention_depth, (extract(epoch from chain_started_at) * 1000)::bigint from message where id = $1::uuid",
    )
    .bind(message_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((depth, started)) = row else {
        return Ok(false);
    };
    let aged = started.is_some_and(|s| now_ms - s >= CHAIN_BACKSTOP_MS);
    Ok(aged || i64::from(depth) >= mention_calls::chain_limit(conn).await?)
}

/// TS `createDelegation`(`teamId = null`, `kind = 'delegate'`). `v2` 는 위임 스위치(알 때만 이 갈래가 돈다). 돌려주는 것은 위임 id.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn create(
    conn: &mut PgConnection,
    v2: bool,
    message_id: &str,
    channel_id: &str,
    thread_root_id: &str,
    lead_id: &str,
    plan: &Plan<'_>,
) -> Result<String, sqlx::Error> {
    let s = sql();
    let id: String = sqlx::query_scalar(s.insert.as_str())
        .bind(message_id)
        .bind(None::<String>)
        .bind(lead_id)
        .bind(channel_id)
        .bind(thread_root_id)
        .bind(plan.deadline_at)
        .bind("delegate")
        .bind(None::<String>)
        .fetch_one(&mut *conn)
        .await?;
    for d in plan.delegate_ids {
        // TS `supersedePrevious` — v1 에서 같은 스레드·같은 담당의 앞 의무(열린·보고된)는 대체된다. 깨우지 않는다.
        if v2 {
            let closed: Vec<String> = sqlx::query_scalar(s.supersede.as_str())
                .bind(thread_root_id)
                .bind(d)
                .bind(&id)
                .fetch_all(&mut *conn)
                .await?;
            if !closed.is_empty() {
                sqlx::query(s.settled.as_str())
                    .bind(&closed)
                    .execute(&mut *conn)
                    .await?;
            }
        }
        sqlx::query(s.item.as_str())
            .bind(&id)
            .bind(d)
            .execute(&mut *conn)
            .await?;
        // 본문 멘션이 이미 만든 `mention` 부름을 위임 부름으로 바꿔 단다. 없으면 새로.
        let converted = sqlx::query(s.convert.as_str())
            .bind(d)
            .bind(message_id)
            .bind(None::<String>)
            .execute(&mut *conn)
            .await?;
        if converted.rows_affected() == 0 {
            sqlx::query(s.inbox.as_str())
                .bind(d)
                .bind(message_id)
                .bind(None::<String>)
                .execute(&mut *conn)
                .await?;
        }
    }
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn golden_sql_loads() {
        let s = sql();
        assert!(s.insert.starts_with("insert into team_delegation"));
        assert!(s.supersede.contains("closed_reason = 'superseded'"));
        assert!(s.settled.contains("notified_at = now()"));
        assert!(s.convert.contains("reason = 'team_delegated'"));
        assert!(s.inbox.contains("'team_delegated'"));
    }
}
