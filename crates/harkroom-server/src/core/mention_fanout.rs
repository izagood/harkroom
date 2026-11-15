//! S5.3 C3a-3b-3 — 호출함 쓰기. TS `services/messages.ts` 의 `fanOutCalls`(1381행)·`insertInboxMany`(689)·`fanOutMention`(770)과
//! `push/pushJobs.ts::enqueueInboxPushMany` 를 옮긴다.
//!
//! - **판정은 하지 않는다** — 누구를 부를지는 [`super::mention_calls::resolve`](C3a-3b-2)가 이미 정했다. 여기서는 그 결과의
//!   `called_ids`(상한·게이트에 막힌 것·작성자 빼고)·`team_plans`·`target_call`(집합·팀)·`channel_called` 만 inbox 로 옮긴다.
//!   집합·`@channel` 은 TS 와 같이 받는 사람마다 게이트(`via` group·channel_all)를 다시 잰다.
//! - 문장은 전부 TS 상수를 골든으로 받는다(`mc_insert_inbox_many`·`mc_reveal_hidden`·`mc_fan_out_audience`·`mc_group_members`·
//!   `mc_enqueue_inbox_push_many`, 사유 목록 `mc_reveal_reasons`·`mc_inbox_push_reasons`, 늦춤 `mc_push_agent_reply_delay_sec`).
//! - 받은 연결 하나로만 쓴다(글 쓰기 트랜잭션 안). **오류는 그대로 돌려준다** — 호출부가 트랜잭션 전체를 버린다(TS 가 던지는 것과 같다).
use super::invoke_gate::{self, Ctx, Via};
use super::mention_calls::{CHANNEL_MENTION_HANDLE, Resolved};
use super::mention_parse::TargetKind;
use serde_json::Value;
use sqlx::PgConnection;
use std::collections::HashSet;
use std::sync::OnceLock;

struct Sql {
    insert_inbox: String,
    reveal_hidden: String,
    audience: String,
    group_members: String,
    push: String,
    reveal_reasons: Vec<String>,
    push_reasons: Vec<String>,
    push_delay_sec: f64,
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
        let list = |k: &str| -> Vec<String> { serde_json::from_str(&frag(k)).expect(k) };
        Sql {
            insert_inbox: format!(
                "with ins as ({}) select ins.id::int8, ins.account_id::text from ins",
                frag("mc_insert_inbox_many")
            ),
            reveal_hidden: frag("mc_reveal_hidden"),
            audience: format!("select a.id::text from ({}) a", frag("mc_fan_out_audience")),
            group_members: format!(
                "select m.\"accountId\"::text from ({}) m",
                frag("mc_group_members")
            ),
            push: frag("mc_enqueue_inbox_push_many"),
            reveal_reasons: list("mc_reveal_reasons"),
            push_reasons: list("mc_inbox_push_reasons"),
            push_delay_sec: frag("mc_push_agent_reply_delay_sec")
                .parse()
                .expect("push delay"),
        }
    })
}

/// 글 하나의 자리.
pub struct Post<'a> {
    pub channel_id: &'a str,
    pub author_id: &'a str,
    pub message_id: &'a str,
}

/// TS `insertInboxMany` — 중복 제거 → 차단한 사람 빼고 넣기 → 푸시 줄 → (mention·thread_reply 면) 숨긴 채널 되살리기 → `notified` 에 더함.
pub async fn insert_inbox_many(
    conn: &mut PgConnection,
    account_ids: &[String],
    message_id: &str,
    reason: &str,
    notified: &mut HashSet<String>,
    team_id: Option<&str>,
) -> Result<(), sqlx::Error> {
    let mut ids: Vec<String> = vec![];
    for id in account_ids {
        if !ids.contains(id) {
            ids.push(id.clone());
        }
    }
    if ids.is_empty() {
        return Ok(());
    }
    let s = sql();
    let inserted: Vec<(i64, String)> = sqlx::query_as(s.insert_inbox.as_str())
        .bind(&ids)
        .bind(message_id)
        .bind(reason)
        .bind(team_id)
        .fetch_all(&mut *conn)
        .await?;
    if inserted.is_empty() {
        return Ok(());
    }
    if s.push_reasons.iter().any(|r| r == reason) {
        let accounts: Vec<String> = inserted.iter().map(|(_, a)| a.clone()).collect();
        let inbox_ids: Vec<i64> = inserted.iter().map(|(i, _)| *i).collect();
        sqlx::query(s.push.as_str())
            .bind(&accounts)
            .bind(&inbox_ids)
            .bind(message_id)
            .bind(reason)
            .bind(s.push_delay_sec)
            .execute(&mut *conn)
            .await?;
    }
    let got: Vec<String> = inserted.into_iter().map(|(_, a)| a).collect();
    if s.reveal_reasons.iter().any(|r| r == reason) {
        sqlx::query(s.reveal_hidden.as_str())
            .bind(&got)
            .bind(message_id)
            .execute(&mut *conn)
            .await?;
    }
    notified.extend(got);
    Ok(())
}

/// TS `fanOutMention` — 채널을 볼 수 있는 사람(작성자 빼고, 후보가 있으면 그 안에서) 중 아직 안 넣은 사람을 게이트(`via`)로 다시 재고 넣는다.
pub async fn fan_out_mention(
    conn: &mut PgConnection,
    post: &Post<'_>,
    candidates: Option<&[String]>,
    notified: &mut HashSet<String>,
    reason: &str,
    team_id: Option<&str>,
    via: Via,
) -> Result<(), sqlx::Error> {
    if candidates.is_some_and(|c| c.is_empty()) {
        return Ok(());
    }
    let audience: Vec<String> = sqlx::query_scalar(sql().audience.as_str())
        .bind(post.channel_id)
        .bind(post.author_id)
        .bind(candidates)
        .fetch_all(&mut *conn)
        .await?;
    let facts = invoke_gate::invoke_facts(conn, &audience).await?;
    let mut recipients: Vec<String> = vec![];
    for id in &audience {
        if notified.contains(id) {
            continue;
        }
        if let Some(f) = facts.get(id) {
            let ctx = Ctx {
                caller_id: post.author_id,
                channel_id: post.channel_id,
                via,
                reply_grant_thread_id: None,
            };
            if !invoke_gate::may_invoke(conn, f, &ctx).await? {
                continue;
            }
        }
        recipients.push(id.clone());
    }
    insert_inbox_many(
        conn,
        &recipients,
        post.message_id,
        reason,
        notified,
        team_id,
    )
    .await
}

/// TS `fanOutCalls`.
pub async fn fan_out_calls(
    conn: &mut PgConnection,
    post: &Post<'_>,
    r: &Resolved,
    notified: &mut HashSet<String>,
) -> Result<(), sqlx::Error> {
    // 계정 부름 — 같은 사유·팀이 이어지면 한 번에 넣는다(TS `runs`). 팀과 그 팀장을 함께 부르면 팀장 항목에 팀을 싣는다.
    let mut runs: Vec<(&'static str, Option<String>, Vec<String>)> = vec![];
    let mut queued: HashSet<String> = HashSet::new();
    for id in &r.called_ids {
        if notified.contains(id) || queued.contains(id) {
            continue;
        }
        if id == post.author_id || r.capped_ids.contains(id) || r.denied_ids.contains(id) {
            continue;
        }
        let led = r
            .team_plans
            .iter()
            .find(|p| p.via_lead && p.recipients.first() == Some(id));
        let reason = if led.is_some() {
            "team_mention"
        } else {
            "mention"
        };
        let team = led.map(|p| p.team_id.clone());
        match runs.last_mut() {
            Some((lr, lt, ids)) if *lr == reason && *lt == team => ids.push(id.clone()),
            _ => runs.push((reason, team, vec![id.clone()])),
        }
        queued.insert(id.clone());
    }
    for (reason, team, ids) in &runs {
        insert_inbox_many(
            conn,
            ids,
            post.message_id,
            reason,
            notified,
            team.as_deref(),
        )
        .await?;
    }

    if r.channel_called && !r.account_handles.contains(CHANNEL_MENTION_HANDLE) {
        fan_out_mention(conn, post, None, notified, "mention", None, Via::ChannelAll).await?;
    }

    for target in &r.target_call {
        if target.kind == TargetKind::Group {
            let members: Vec<String> = sqlx::query_scalar(sql().group_members.as_str())
                .bind(&target.id)
                .fetch_all(&mut *conn)
                .await?;
            fan_out_mention(
                conn,
                post,
                Some(&members),
                notified,
                "mention",
                None,
                Via::Group,
            )
            .await?;
            continue;
        }
        let Some(plan) = r.team_plans.iter().find(|p| p.team_id == target.id) else {
            continue;
        };
        let (reason, team) = if plan.via_lead {
            ("team_mention", Some(plan.team_id.as_str()))
        } else {
            ("mention", None)
        };
        fan_out_mention(
            conn,
            post,
            Some(&plan.recipients),
            notified,
            reason,
            team,
            Via::Team,
        )
        .await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn golden_lists_load() {
        let s = sql();
        assert_eq!(s.reveal_reasons, ["mention", "thread_reply"]);
        assert_eq!(s.push_reasons, ["mention", "thread_reply", "dm"]);
        assert!(s.push_delay_sec > 0.0);
        assert!(s.insert_inbox.contains("account_block"));
    }
}
