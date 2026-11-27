//! MCP `turn.cancel` — 일을 넘긴 에이전트가 그 팀원의 도는 턴을 멈춘다(TS `mcpPlugin.ts` `turn.cancel` 과 같다).
//!
//! 릴레이 허브가 Rust 오퍼레이터 코어와 함께 옮겨지면 TS 허브는 비어 있다. 그래서 이 도구는 Rust 가 Rust 허브로 답한다
//! (AC5 안전판의 `operator_core_moved` 거절을 대신한다). 순서·모양은 TS 그대로다:
//! 채널 멤버 확인 → 이 스레드에 내가 넘긴 열린 의무의 팀원(`openDelegatesOf`) → 그 채널·스레드(·sessionId)의 세션만
//! → 허브에 멈춤 신호 → `not_found`(누르는 사이 스스로 끝남)는 건너뜀 → 의무·예약 정리 → 감사 `via: 'delegator'`
//! → `{ canceled, failed, note? }`.

use serde_json::{Value, json};
use sqlx::PgPool;

use super::tools::{err, uuid_arg};
use crate::auth::Account;
use crate::core::relay::CancelOutcome;
use crate::core::relay_routes::RelayCore;
use crate::write::{AuditEntry, record_audit};

/// TS `openDelegatesOf` — 이 스레드에서 `lead` 가 넘긴 **아직 열린** 의무의 팀원들.
const OPEN_DELEGATES: &str = "select distinct i.delegate_account_id::text \
       from team_delegation d \
       join team_delegation_item i on i.delegation_id = d.id \
      where d.lead_account_id = $1::uuid \
        and d.thread_root_id = $2::uuid \
        and i.outcome is null";

/// 인자. `sessionId` 는 있으면 uuid 여야 한다. 틀린 인자는 `None` — TS(zod)가 검증 오류로 답한다(허브에 닿지 않는다).
struct Args<'a> {
    channel: &'a str,
    thread: &'a str,
    session: Option<&'a str>,
}

fn parse(args: &Value) -> Option<Args<'_>> {
    let channel = uuid_arg(args, "channelId")?;
    let thread = uuid_arg(args, "threadRootId")?;
    let session = match args.as_object()?.get("sessionId") {
        None => None,
        Some(_) => Some(uuid_arg(args, "sessionId")?),
    };
    Some(Args {
        channel,
        thread,
        session,
    })
}

fn outcome_code(o: &CancelOutcome) -> &'static str {
    match o {
        CancelOutcome::Ok => "ok",
        CancelOutcome::NotFound => "not_found",
        CancelOutcome::NoRunner => "no_runner",
        CancelOutcome::RunnerOutdated => "runner_outdated",
    }
}

/// 읽기 실패. TS 로 넘기면 빈 TS 허브가 「도는 턴 없음」으로 성공처럼 답하므로 넘기지 않는다. 사유는 되비추지 않는다.
fn read_failed() -> String {
    err(
        "internal",
        "could not look up the delegation; nothing was canceled",
    )
}

/// 답 글자. `None` 이면 TS 로 넘긴다(틀린 인자만 — zod 가 검증 오류로 답하고 허브에 닿지 않는다).
pub async fn answer(pool: &PgPool, rc: &RelayCore, me: &Account, args: &Value) -> Option<String> {
    let a = parse(args)?;
    match crate::core::msg_read::channel_visible(pool, &me.id, a.channel).await {
        Ok(true) => {}
        Ok(false) => return Some(err("forbidden", "not a member of this channel")),
        Err(_) => return Some(read_failed()),
    }
    let Ok(delegates) = sqlx::query_scalar::<_, String>(OPEN_DELEGATES)
        .bind(&me.id)
        .bind(a.thread)
        .fetch_all(pool)
        .await
    else {
        return Some(read_failed());
    };
    if delegates.is_empty() {
        return Some(err(
            "not_delegator",
            "그 스레드에 네가 넘긴 열린 의무가 없다 — 넘기지 않은 일은 멈출 수 없다(사람에게 [그만두기]를 부탁하라)",
        ));
    }
    let s = |m: &crate::core::relay::Session, k: &str| {
        m.get(k).and_then(Value::as_str).unwrap_or("").to_owned()
    };
    let targets: Vec<(String, String)> = rc
        .link
        .relay()
        .list_sessions(Some(&delegates))
        .iter()
        .filter(|x| {
            s(x, "channelId") == a.channel
                && s(x, "threadRootId") == a.thread
                && a.session.is_none_or(|sid| s(x, "sessionId") == sid)
        })
        .map(|x| (s(x, "sessionId"), s(x, "agentAccountId")))
        .collect();
    let mut canceled = Vec::new();
    let mut failed = Vec::new();
    for (sid, agent) in &targets {
        let outcome = rc.link.relay().cancel_session(sid, &me.handle);
        match outcome {
            // 누르는 사이에 스스로 끝났다 — 원한 결과와 같다(사람의 문과 같은 판단).
            CancelOutcome::NotFound => continue,
            CancelOutcome::Ok => {}
            other => {
                failed.push(json!({ "sessionId": sid, "agentAccountId": agent, "code": outcome_code(&other) }));
                continue;
            }
        }
        canceled.push(json!({ "sessionId": sid, "agentAccountId": agent }));
        (rc.settle)(a.thread.to_owned(), agent.clone()).await;
        // 감사는 사람의 문과 **같은 액션**이다. `via` 로 문을 가른다(TS 는 MCP 문에서 ip 를 싣지 않는다).
        record_audit(
            &rc.write,
            AuditEntry {
                action: "agent.turn.canceled",
                actor_id: Some(&me.id),
                actor_handle: Some(&me.handle),
                target: Some(agent),
                ip: None,
                detail: json!({ "sessionId": sid, "channelId": a.channel, "threadRootId": a.thread, "via": "delegator" }),
            },
        )
        .await;
    }
    let mut out = json!({ "canceled": canceled, "failed": failed });
    if targets.is_empty() {
        out["note"] =
            Value::from("그 스레드에서 도는 팀원 턴이 없다 — 이미 끝났거나 아직 시작하지 않았다");
    }
    Some(super::respond::text_result(&out.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const U: &str = "00000000-0000-4000-8000-000000000001";

    #[test]
    fn parse_requires_uuids_and_checks_optional_session() {
        assert!(
            parse(&json!({ "channelId": U, "threadRootId": U }))
                .is_some_and(|a| a.session.is_none())
        );
        assert!(
            parse(&json!({ "channelId": U, "threadRootId": U, "sessionId": U }))
                .is_some_and(|a| a.session == Some(U))
        );
        assert!(parse(&json!({ "channelId": U, "threadRootId": U, "sessionId": "x" })).is_none());
        assert!(parse(&json!({ "channelId": U, "threadRootId": U, "sessionId": null })).is_none());
        assert!(parse(&json!({ "channelId": "x", "threadRootId": U })).is_none());
        assert!(parse(&json!({ "channelId": U })).is_none());
    }

    #[test]
    fn outcome_codes_match_ts() {
        assert_eq!(outcome_code(&CancelOutcome::NoRunner), "no_runner");
        assert_eq!(
            outcome_code(&CancelOutcome::RunnerOutdated),
            "runner_outdated"
        );
    }
}
