//! S5.3 C3b-2c-4b — MCP `message.delegate` 의 **쓰기**(게이트를 다 지난 요청). TS `mcp/mcpPlugin.ts` 의 같은 도구 뒷부분 —
//! `postMessage` 뒤의 `createDelegation`(`services/delegations.ts`) — 을
//! [`super::msg_post::post_tx`] 안에서 **글과 같은 tx** 로 한다.
//!
//! - TS 는 글을 커밋한 뒤 다른 tx 로 의무를 만든다(그 사이 실패하면 `delegation_failed` — 글만 남는다). Rust 는 한 tx 라 그 창이 없다:
//!   의무를 못 만들면 글도 남지 않고 TS 로 넘긴다. 성공한 결과는 같다.
//! - 문장은 전부 TS 상수를 골든(`delegation_insert`·`delegation_item_insert`·`delegate_supersede`·`delegate_mark_settled_quietly`·
//!   `delegate_inbox_convert`·`delegate_inbox_insert`)으로 받는다.
//! - S5.4-11c: 팀장이 자기 팀 하나에 넘기는 갈래도 온다 — [`Plan::team_id`] 가 있으면 위임 행·부름에 `team_id` 를 적는다.
//!   `kind` 는 언제나 `'delegate'`. 사슬 상한(`delegationChainCapped`)은 어느 갈래에서도 보지 않는다(O1 — TS 와 여기서 갈린다).
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
    /// 팀장이 자기 팀에 넘기면 그 팀 id(TS `team?.teamId ?? null`).
    pub(crate) team_id: Option<&'a str>,
    /// 무엇으로 닫히나(마이그레이션 183) — `message.delegate` 는 언제나 [`CloseOn::Report`].
    pub(crate) close_on: CloseOn,
}

/// `agent.call` 의 의무 있는 부름(U1) — 담당은 글 tx 안의 멘션 판정이 정한다([`super::msg_post::Origin::call_obligation`]).
#[derive(Debug)]
pub(crate) struct CallObligation<'a> {
    /// `to` 가 가리킨, 접속한 에이전트 (계정 id, handle) — `to` 순서, 겹침 없음.
    pub(crate) targets: &'a [(String, String)],
    /// 접속하지 않아 부르지 않은 대상의 handle — 글 `meta.delegation.unreachable` 에만 싣는다.
    pub(crate) unreachable: &'a [String],
    pub(crate) deadline_at: &'a str,
    pub(crate) close_on: CloseOn,
}

/// 의무를 닫는 조건 — `team_delegation.close_on`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CloseOn {
    /// 담당의 `message.report`·`message.fail`·기한·중단.
    Report,
    /// 담당이 그 스레드에 쓴 첫 답글(`agent.call` 의 `expect: "reply"`).
    Reply,
}

impl CloseOn {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            CloseOn::Report => "report",
            CloseOn::Reply => "reply",
        }
    }
}

struct Sql {
    insert: String,
    insert_close_on: String,
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
            insert_close_on: frag("delegation_insert_close_on"),
            item: frag("delegation_item_insert"),
            supersede: frag("delegate_supersede"),
            settled: frag("delegate_mark_settled_quietly"),
            convert: frag("delegate_inbox_convert"),
            inbox: frag("delegate_inbox_insert"),
        }
    })
}

/// 의무 행(`team_delegation`) 하나를 적는다 — 의무를 세우는 모든 문(`message.delegate`·`agent.call`·맨 앞 멘션)이 이 한 곳을 지난다(U4).
/// `kind` 는 생김새(`delegate`·`mention`), `close_on` 은 닫는 조건. 돌려주는 것은 위임 id.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn insert_row(
    conn: &mut PgConnection,
    message_id: &str,
    team_id: Option<&str>,
    lead_id: &str,
    channel_id: &str,
    thread_root_id: &str,
    deadline_at: &str,
    kind: &str,
    plan_step_id: Option<&str>,
    close_on: CloseOn,
) -> Result<String, sqlx::Error> {
    let s = sql();
    // 닫는 조건이 기본(`report`)이면 옛 문장 그대로다 — 새 칸(183)이 아직 없는 DB 에서도 `message.delegate` 는 돈다.
    let q = match close_on {
        CloseOn::Report => sqlx::query_scalar(s.insert.as_str()),
        CloseOn::Reply => sqlx::query_scalar(s.insert_close_on.as_str()),
    };
    let q = q
        .bind(message_id)
        .bind(team_id)
        .bind(lead_id)
        .bind(channel_id)
        .bind(thread_root_id)
        .bind(deadline_at)
        .bind(kind)
        .bind(plan_step_id);
    match close_on {
        CloseOn::Report => q,
        CloseOn::Reply => q.bind(close_on.as_str()),
    }
    .fetch_one(&mut *conn)
    .await
}

/// TS `createDelegation`(`teamId = plan.team_id`, `kind = 'delegate'`). `v2` 는 위임 스위치(알 때만 이 갈래가 돈다). 돌려주는 것은 위임 id.
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
    let id = insert_row(
        conn,
        message_id,
        plan.team_id,
        lead_id,
        channel_id,
        thread_root_id,
        plan.deadline_at,
        "delegate",
        None,
        plan.close_on,
    )
    .await?;
    for d in plan.delegate_ids {
        // TS `supersedePrevious` — v1 에서 같은 스레드·같은 담당의 앞 의무(열린·보고된)는 대체된다. 깨우지 않는다.
        // U1: **같은 넘긴 쪽**이 세운 앞 의무만 대체한다 — 남이 그 담당에게 넘긴 의무는 내 새 부름으로 닫히지 않는다.
        // F1a 자기 조각(담당 = 위임자)은 대체하지 않는다 — 내가 위에서 받은 의무와 앞서 세운 자기 조각이 열린 채 남는다.
        if v2 && d != lead_id {
            let closed: Vec<String> = sqlx::query_scalar(s.supersede.as_str())
                .bind(thread_root_id)
                .bind(d)
                .bind(&id)
                .bind(lead_id)
                .fetch_all(&mut *conn)
                .await?;
            // A1 측정 — 위임 결말(새 위임이 앞 의무를 대체). 기록만.
            super::measure::delegation_outcomes(&closed, "closed", Some("superseded"));
            // D1 그림자 — 대체된 앞 의무의 하위 작업을 접는다. 이 tx 밖(다른 연결)에서 돈다. 기록만.
            super::work_shadow::delegation_closed(&closed, Some(d), "closed", Some("superseded"));
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
            .bind(plan.team_id)
            .execute(&mut *conn)
            .await?;
        if converted.rows_affected() == 0 {
            sqlx::query(s.inbox.as_str())
                .bind(d)
                .bind(message_id)
                .bind(plan.team_id)
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
        assert!(s.supersede.contains("d.lead_account_id = $4::uuid"));
        assert!(s.insert_close_on.contains("close_on)"));
        assert!(s.insert_close_on.contains("$9)"));
        assert!(!s.insert.contains("close_on"));
        assert!(s.settled.contains("notified_at = now()"));
        assert!(s.convert.contains("reason = 'team_delegated'"));
        assert!(s.inbox.contains("'team_delegated'"));
    }
}
