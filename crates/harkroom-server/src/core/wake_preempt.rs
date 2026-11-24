//! S5.3 C1c-3b — 사람이 스레드에 답하면 **그 스레드의 기다림이 끝난다**. TS `services/agentWakes.ts::preemptWakesForThread` 와
//! 커밋 뒤 신호(`announceReportWakes`·`announceWakeRows`)를 옮긴다.
//!
//! - 작성자 아닌 계정의 열린 깨움을 `for update` 로 잡아(sweep 과의 경합 — 그쪽이 먼저 잡았으면 기다린 뒤 이 행은 빠진다)
//!   그 글이 이미 부른 계정이면 **접고**(`canceled_at`·`canceled_by_message_id` = 이 답), 아니면 **지금 깨운다**
//!   (`inbox` reason `wake` → `fired_at`). 어느 쪽이든 대기 줄 meta 에 닫힌 시각을 적는다(처음 값만).
//! - 작성자가 사람인지는 부르는 쪽(`msg_post.rs`, 에이전트 글이면 부르지 않는다)이 이미 보장한다 — TS 의 `kind = 'human'` 판정과 같다.
//! - 신호는 TS 처럼 커밋 뒤에 나가야 하므로 outbox 에 넣는다(같은 트랜잭션, 커밋 뒤 배달) — 순서도 TS 그대로:
//!   깨운 계정의 `inbox.updated` → 보고처마다 `thread.reportWakes.changed`(값 없이 신호만, 같은 스레드는 한 번) →
//!   닫힌 대기 줄마다 `message.updated`.
//! - 문장은 전부 TS 상수를 골든으로 받는다(`preempt_*`·`stamp_wake_closed`).
use super::ask_sync::announce_updated;
use super::audience::audience_on;
use serde_json::{Value, json};
use std::collections::HashSet;
use std::sync::OnceLock;

struct Sql {
    due: String,
    cancel: String,
    fire_inbox: String,
    fire: String,
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
            // `for update` 는 서브쿼리로 감싸지 않고 `with` 로 받는다(잠금은 그 안에서 걸린다) — 칸은 text 로 읽는다.
            due: format!(
                "with d as ({}) select d.id::text, d.account_id::text, d.message_id::text, d.report_to from d",
                frag("preempt_due")
            ),
            cancel: frag("preempt_cancel"),
            fire_inbox: frag("preempt_fire_inbox"),
            fire: frag("preempt_fire"),
            stamp: frag("stamp_wake_closed"),
        }
    })
}

/// TS `asReportTo` — 두 칸이 다 문자열일 때만.
fn report_to(v: &Value) -> Option<(String, String)> {
    Some((
        v.get("channelId")?.as_str()?.to_owned(),
        v.get("threadRootId")?.as_str()?.to_owned(),
    ))
}

/// TS `new Date().toISOString()` — 밀리초까지, UTC `Z`.
async fn now_iso(conn: &mut sqlx::PgConnection) -> Result<String, sqlx::Error> {
    sqlx::query_scalar(
        "select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')",
    )
    .fetch_one(&mut *conn)
    .await
}

/// 접거나 깨운 결과 — 신호의 재료.
#[derive(Default)]
pub struct Preempted {
    /// 깨운 계정(깨움 순서).
    pub woke: Vec<String>,
    /// 보고처(채널, 스레드) — 겹칠 수 있다(신호 때 거른다).
    pub report: Vec<(String, String)>,
    /// 닫힌 대기 줄.
    pub rows: Vec<String>,
    /// 그 밖에 meta 가 바뀌어 다시 알릴 글(위임 글의 열린 목록) — 대기 줄 뒤에 알린다.
    pub updated: Vec<String>,
}

/// TS `preemptWakesForThread`(사람 작성자). `notified` 는 이 글이 이미 부른 계정 — 그 계정의 깨움은 접는다.
pub async fn preempt(
    conn: &mut sqlx::PgConnection,
    thread_root: &str,
    author: &str,
    message_id: &str,
    notified: &HashSet<String>,
) -> Result<Preempted, sqlx::Error> {
    let s = sql();
    let due: Vec<(String, String, String, Option<Value>)> = sqlx::query_as(s.due.as_str())
        .bind(thread_root)
        .bind(author)
        .fetch_all(&mut *conn)
        .await?;
    let mut out = Preempted::default();
    for (id, account, wake_msg, report) in due {
        if let Some(r) = report.as_ref().and_then(report_to) {
            out.report.push(r);
        }
        out.rows.push(wake_msg.clone());
        let field = if notified.contains(&account) {
            sqlx::query(s.cancel.as_str())
                .bind(&id)
                .bind(message_id)
                .execute(&mut *conn)
                .await?;
            "canceledAt"
        } else {
            sqlx::query(s.fire_inbox.as_str())
                .bind(&id)
                .execute(&mut *conn)
                .await?;
            sqlx::query(s.fire.as_str())
                .bind(&id)
                .execute(&mut *conn)
                .await?;
            out.woke.push(account);
            "firedAt"
        };
        let at = now_iso(conn).await?;
        sqlx::query(s.stamp.as_str())
            .bind(vec![wake_msg])
            .bind(at)
            .bind(field)
            .execute(&mut *conn)
            .await?;
    }
    Ok(out)
}

/// 커밋 뒤 신호를 outbox 로 — TS 순서 그대로(모듈 주석).
pub async fn announce(conn: &mut sqlx::PgConnection, p: &Preempted) -> Result<(), sqlx::Error> {
    for a in &p.woke {
        crate::write::emit_event(
            &mut *conn,
            &json!({ "type": "inbox.updated", "accountId": a }),
        )
        .await?;
    }
    let mut seen = HashSet::new();
    for (channel, root) in &p.report {
        if !seen.insert((channel.clone(), root.clone())) {
            continue;
        }
        let audience = audience_on(&mut *conn, channel).await?.to_json();
        crate::write::emit_event(
            &mut *conn,
            &json!({ "type": "thread.reportWakes.changed", "channelId": channel, "rootId": root, "audience": audience }),
        )
        .await?;
    }
    let mut rows = HashSet::new();
    for id in p.rows.iter().chain(&p.updated) {
        if rows.insert(id.clone()) {
            announce_updated(&mut *conn, id).await?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn golden_loads() {
        let s = sql();
        assert!(s.due.contains("for update of w"));
        assert!(s.cancel.contains("canceled_by_message_id"));
        assert!(s.fire_inbox.contains("'wake'"));
        assert!(s.stamp.contains("jsonb_set"));
    }

    #[test]
    fn report_to_needs_both() {
        assert!(report_to(&json!({ "channelId": "c", "threadRootId": "t" })).is_some());
        assert!(report_to(&json!({ "channelId": "c" })).is_none());
        assert!(report_to(&json!({ "channelId": 1, "threadRootId": "t" })).is_none());
    }
}
