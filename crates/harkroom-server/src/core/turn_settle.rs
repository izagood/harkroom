//! S5.3 C6c-3 — 도는 턴을 멈춘 **뒤의 정리**. TS `services/turnCancel.ts::settleCanceledTurn` 을 옮긴다.
//!
//! - 멈춘 에이전트의 그 스레드 위임 의무(팀원이면 그 의무만 닫고 마지막이면 팀장을 깨운다 · 팀장이면 낸 위임을 전부 닫고 깨우지 않는다 —
//!   TS `cancelDelegationsFor`)와 그 에이전트·그 스레드의 예약(TS `cancelWakesForTurn`)을 **한 트랜잭션으로** 닫는다.
//! - 팀장을 깨울 때는 그 위임에 걸린 팀장의 예약도 접는다(TS `foldWakesForDelegation`).
//! - 신호는 커밋 뒤에 나가야 하므로 outbox 에 넣는다(같은 트랜잭션) — 순서도 TS 그대로: 깨운 팀장의 `inbox.updated` →
//!   보고처마다 `thread.reportWakes.changed` → 닫힌 대기 줄마다 `message.updated`([`super::wake_preempt::announce`]).
//! - **던지지 않는다.** 중단 신호는 이미 갔다. 못 닫으면 롤백하고 기한·예약 시각이 그 자리를 메운다(TS 와 같음). 로그에는 오류 종류만.
//! - 문장은 전부 TS 상수를 골든으로 받는다(`cancel_*`·`settled_*`·`fold_wakes_for_delegation`·`stamp_wake_closed`).
use super::wake_preempt::{Preempted, announce};
use serde_json::Value;
use sqlx::PgPool;
use std::sync::OnceLock;

/// 이 정리가 쓰는 권한(표, 권한) — 오퍼레이터 권한 묶음(`write::OPERATOR_PRIVILEGES`)에 같이 든다(r3 와 같은 fail-closed).
pub const SETTLE_CANCEL_PRIVILEGES: &[(&str, &str)] = &[
    ("team_delegation", "SELECT"),
    ("team_delegation_item", "SELECT"),
    ("team_delegation.notified_at", "UPDATE"),
    ("team_delegation_item.outcome", "UPDATE"),
    ("team_delegation_item.closed_at", "UPDATE"),
    ("agent_wake", "SELECT"),
    ("agent_wake.canceled_at", "UPDATE"),
    ("agent_wake.canceled_by_message_id", "UPDATE"),
    ("message.meta", "UPDATE"),
    ("inbox", "INSERT"),
    ("event_outbox", "INSERT"),
];

struct Sql {
    as_delegate: String,
    delegate_item: String,
    as_lead: String,
    lead_items: String,
    lead_mark: String,
    still: String,
    mark: String,
    inbox: String,
    fold: String,
    wakes: String,
    stamp: String,
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
            as_delegate: frag("cancel_as_delegate"),
            delegate_item: frag("cancel_delegate_item"),
            as_lead: frag("cancel_as_lead"),
            lead_items: frag("cancel_lead_items"),
            lead_mark: frag("cancel_lead_mark"),
            still: frag("settled_still"),
            mark: frag("settled_mark"),
            inbox: frag("settled_inbox"),
            fold: frag("fold_wakes_for_delegation"),
            wakes: frag("cancel_wakes_for_turn"),
            stamp: frag("stamp_wake_closed"),
        }
    })
}

/// TS `asReportTo` — 두 칸이 다 문자열일 때만.
pub(crate) fn report_to(v: &Value) -> Option<(String, String)> {
    Some((
        v.get("channelId")?.as_str()?.to_owned(),
        v.get("threadRootId")?.as_str()?.to_owned(),
    ))
}

/// TS `new Date().toISOString()` — 밀리초까지, UTC `Z`.
pub(crate) async fn now_iso(conn: &mut sqlx::PgConnection) -> Result<String, sqlx::Error> {
    sqlx::query_scalar(
        "select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')",
    )
    .fetch_one(&mut *conn)
    .await
}

/// 접은 예약 줄들 — 보고처와 대기 줄을 모으고 meta 에 닫힌 시각을 적는다(TS `stampWakeClosed(…, 'canceledAt')`).
async fn closed_wakes(
    conn: &mut sqlx::PgConnection,
    rows: Vec<(Option<Value>, String)>,
    out: &mut Preempted,
) -> Result<(), sqlx::Error> {
    if rows.is_empty() {
        return Ok(());
    }
    let ids: Vec<String> = rows.iter().map(|(_, id)| id.clone()).collect();
    let at = now_iso(conn).await?;
    sqlx::query(sql().stamp.as_str())
        .bind(&ids)
        .bind(at)
        .bind("canceledAt")
        .execute(&mut *conn)
        .await?;
    for (report, id) in rows {
        if let Some(r) = report.as_ref().and_then(report_to) {
            out.report.push(r);
        }
        out.rows.push(id);
    }
    Ok(())
}

/// 위임 글의 `meta.delegation.open` 을 **지금 미결인 담당**(`outcome is null`)으로 다시 쓴다 — 의무를 닫는 길은 모두 여기를 지난다
/// (결과 글·기한·중단 = [`notify_if_settled`], 넘긴 쪽이 닫음·새 위임으로 대체·나이·idle = [`sync_open_announce`]).
/// 화면의 대기 사슬과 스레드 머리의 `openAskLinks` 가 이 값을 읽는다. 같은 글에 묶인 위임을 함께 세고, 담당 집합이 같으면
/// (순서만 다르면) 건드리지 않는다. `open` 칸이 없는 옛 글은 그대로 둔다. 값이 바뀐 글 id 를 돌려준다.
pub(crate) const SYNC_OPEN_SQL: &str = "update message m \
        set meta = jsonb_set(m.meta, '{delegation,open}', s.open) \
       from (select d.message_id, \
                    coalesce(jsonb_agg(i.delegate_account_id::text order by i.delegate_account_id) \
                             filter (where i.outcome is null), '[]'::jsonb) as open \
               from team_delegation d \
               left join team_delegation_item i on i.delegation_id = d.id \
              where d.message_id in (select message_id from team_delegation where id = any($1::uuid[])) \
              group by d.message_id) s \
      where m.id = s.message_id and m.meta->>'kind' = 'delegation' \
        and not (m.meta->'delegation'->'open' @> s.open and m.meta->'delegation'->'open' <@ s.open) \
  returning m.id::text";

/// [`SYNC_OPEN_SQL`] — 바뀐 위임 글 id.
pub(crate) async fn sync_open(
    conn: &mut sqlx::PgConnection,
    delegations: &[String],
) -> Result<Vec<String>, sqlx::Error> {
    if delegations.is_empty() {
        return Ok(Vec::new());
    }
    sqlx::query_scalar(SYNC_OPEN_SQL)
        .bind(delegations)
        .fetch_all(&mut *conn)
        .await
}

/// 조용히 닫는 길(깨우지 않는 닫힘)용 — 열린 목록을 맞추고 바뀐 글마다 `message.updated` 를 outbox 에 넣는다(같은 tx, 커밋 뒤 배달).
pub(crate) async fn sync_open_announce(
    conn: &mut sqlx::PgConnection,
    delegations: &[String],
) -> Result<(), sqlx::Error> {
    for id in sync_open(conn, delegations).await? {
        super::ask_sync::announce_updated(&mut *conn, &id).await?;
    }
    Ok(())
}

/// TS `notifyIfSettled` — 미결이 0 이면 팀장을 **한 번만** 깨운다. 깨웠으면 팀장 id.
pub(crate) async fn notify_if_settled(
    conn: &mut sqlx::PgConnection,
    delegation: &str,
    out: &mut Preempted,
) -> Result<Option<String>, sqlx::Error> {
    let s = sql();
    let still: Vec<String> = sqlx::query_scalar(s.still.as_str())
        .bind(delegation)
        .fetch_all(&mut *conn)
        .await?;
    // 글의 열린 목록을 맞추고, 바뀐 글은 `out.updated` 로 — 부르는 쪽의 `announce` 가 `message.updated` 로 알린다.
    let changed = sync_open(conn, std::slice::from_ref(&delegation.to_owned())).await?;
    out.updated.extend(changed);
    if !still.is_empty() {
        return Ok(None);
    }
    let marked: Option<(String, String, String)> = sqlx::query_as(s.mark.as_str())
        .bind(delegation)
        .fetch_optional(&mut *conn)
        .await?;
    let Some((lead, message, root)) = marked else {
        return Ok(None);
    };
    fold_wakes_for_delegation(conn, delegation, &lead, &root, &message, out).await?;
    // F1b — 자기 조각이고 열린 형제가 남았으면 깨우지 않는다(마지막 조각이 닫힐 때 표를 실어 한 번). 스위치가 꺼져 있으면 `None`.
    if let Some(g) = super::split_collect::gate(conn, delegation).await?
        && g.verdict == super::split_collect::Verdict::Hold
    {
        return Ok(None);
    }
    sqlx::query(s.inbox.as_str())
        .bind(&lead)
        .bind(&message)
        .execute(&mut *conn)
        .await?;
    Ok(Some(lead))
}

/// TS `foldWakesForDelegation` — 위임자의 그 위임에 걸린 대기 예약을 접는다(보고처·대기 줄은 `out` 에 모은다).
pub(crate) async fn fold_wakes_for_delegation(
    conn: &mut sqlx::PgConnection,
    delegation: &str,
    lead: &str,
    root: &str,
    message: &str,
    out: &mut Preempted,
) -> Result<(), sqlx::Error> {
    let folded: Vec<(Option<Value>, String)> = sqlx::query_as(sql().fold.as_str())
        .bind(delegation)
        .bind(lead)
        .bind(root)
        .bind(message)
        .fetch_all(&mut *conn)
        .await?;
    closed_wakes(conn, folded, out).await
}

/// 트랜잭션 안의 본체 — TS `cancelDelegationsFor` 다음 `cancelWakesForTurn`.
async fn settle_in(
    conn: &mut sqlx::PgConnection,
    thread_root: &str,
    agent: &str,
) -> Result<Preempted, sqlx::Error> {
    let s = sql();
    let mut out = Preempted::default();
    // ① 팀원인 미결 의무 — 닫고, 마지막이었으면 팀장을 깨운다.
    let as_delegate: Vec<String> = sqlx::query_scalar(s.as_delegate.as_str())
        .bind(agent)
        .bind(thread_root)
        .fetch_all(&mut *conn)
        .await?;
    for d in as_delegate {
        let closed = sqlx::query(s.delegate_item.as_str())
            .bind(&d)
            .bind(agent)
            .execute(&mut *conn)
            .await?;
        if closed.rows_affected() == 0 {
            continue;
        }
        if let Some(lead) = notify_if_settled(conn, &d, &mut out).await? {
            out.woke.push(lead);
        }
    }
    // ② 팀장인 미결 위임 — 전부 닫고 깨우지 않는다(깨우면 사람이 멈춘 턴이 되살아난다).
    let as_lead: Vec<String> = sqlx::query_scalar(s.as_lead.as_str())
        .bind(agent)
        .bind(thread_root)
        .fetch_all(&mut *conn)
        .await?;
    for d in as_lead {
        sqlx::query(s.lead_items.as_str())
            .bind(&d)
            .execute(&mut *conn)
            .await?;
        let changed = sync_open(conn, std::slice::from_ref(&d)).await?;
        out.updated.extend(changed);
        sqlx::query(s.lead_mark.as_str())
            .bind(&d)
            .execute(&mut *conn)
            .await?;
    }
    // 그 에이전트·그 스레드의 예약.
    let wakes: Vec<(Option<Value>, String)> = sqlx::query_as(s.wakes.as_str())
        .bind(thread_root)
        .bind(agent)
        .fetch_all(&mut *conn)
        .await?;
    closed_wakes(conn, wakes, &mut out).await?;
    Ok(out)
}

/// TS `settleCanceledTurn`. 무엇을 닫았는지 돌려준다(시험용). 실패하면 롤백하고 빈 결과 — 던지지 않는다.
pub async fn settle_canceled_turn(write: &PgPool, thread_root: &str, agent: &str) -> Preempted {
    let run = async {
        let mut tx = write.begin().await?;
        let out = settle_in(&mut tx, thread_root, agent).await?;
        announce(&mut tx, &out).await?;
        tx.commit().await?;
        Ok::<_, sqlx::Error>(out)
    };
    match run.await {
        Ok(out) => out,
        Err(e) => {
            // 값·id 를 남기지 않는다 — 종류만.
            eprintln!(
                "front: relay cancel could not close delegations/wakes ({}; the stop signal was already sent)",
                e.as_database_error().map_or("io", |_| "db")
            );
            Preempted::default()
        }
    }
}

/// 릴레이 라우트의 손잡이([`super::relay_routes::SettleCancel`])로 감싼다.
pub fn settle_hook(write: PgPool) -> super::relay_routes::SettleCancel {
    std::sync::Arc::new(move |thread: String, agent: String| {
        let write = write.clone();
        Box::pin(async move {
            settle_canceled_turn(&write, &thread, &agent).await;
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn golden_loads() {
        let s = sql();
        assert!(s.as_delegate.contains("for update of d"));
        assert!(SYNC_OPEN_SQL.contains("'{delegation,open}'"));
        assert!(SYNC_OPEN_SQL.contains("filter (where i.outcome is null)"));
        assert!(SYNC_OPEN_SQL.contains("returning m.id::text"));
        assert!(s.inbox.contains("'delegation_done'"));
        assert!(
            s.wakes
                .contains("coalesce(m.thread_root_id, m.id) = $1::uuid")
        );
        assert!(s.fold.contains("canceled_by_message_id = $4::uuid"));
    }

    #[test]
    fn privileges_cover_writes() {
        for want in [
            "team_delegation_item.outcome",
            "agent_wake.canceled_at",
            "message.meta",
            "inbox",
        ] {
            assert!(SETTLE_CANCEL_PRIVILEGES.iter().any(|(t, _)| *t == want));
        }
    }
}
