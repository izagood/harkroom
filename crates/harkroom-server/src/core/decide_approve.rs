//! S5.3 B2 — 권한 카드 **승인** 중 소유자만 하는 길(TS `decidePermissionRequest` 의 그 갈래):
//! - `tool` + `approve` → 7일 `tool.allow` grant(`account_grant` upsert, `allow_agent_cause = false`) + 감사 `grant.given`.
//! - `command` + `approve_once`·`approve_hour` → 명령을 **다시 판정**한 뒤 1시간 `command_grant`(요청 줄의 `file_digests` 를 옮김).
//!
//! 둘 다 요청 줄 `granted`·카드 meta·감사 `permission.approved`·`grant.changed`(outbox) 를 **한 tx** 에 쓴다.
//!
//! 맡는 꼴은 [`super::decide_core::rust_takes`] 가 정한다(위임장·`once`·글 승인·거울은 처음부터 TS). 소유자가 아닌 사람의 승인은
//! 판정 뒤([`super::decide_core::after_verdict`]) 쓰기 전에 TS 로 넘긴다(소유자 알림 글을 TS 가 쓴다).
//!
//! TS 와 다른 점(덜 여는 쪽): TS 는 감사·`grant.given`·이벤트를 커밋 **뒤**에 쓰고 실패를 삼킨다. 여기서는 결정과 같은 tx 라
//! 감사가 실패하면 grant 도 남지 않는다(`internal`, TS 로 넘기지 않음).
use super::decide_core::{
    AfterVerdict, AuditDetail, Decision, FORBIDDEN_MESSAGE, LockRetryError, LockedRequest,
    MAX_RESTARTS, Recheck, Shape, after_verdict, audit_detail, has_lock_fn_privilege, lock_request,
    may_decide_for_locked, recheck_locked, retry_lock_once,
};
use super::msg_read::is_uuid;
use harkroom_proto::tool_rules::{ExactCommandVerdict, validate_exact_command};
use serde_json::{Value, json};
use sqlx::PgConnection;

/// 승인 쓰기 역할의 표·칸 권한. 거절의 칸([`super::decide_core::DENY_PRIVILEGES`])에 grant·이벤트 쓰기를 더한다.
/// 이것과 잠금 함수 EXECUTE 가 **둘 다** 있을 때만 [`approve_pool`] 이 풀을 준다(fail-closed — 없으면 TS 가 받는다).
pub const APPROVE_PRIVILEGES: &[(&str, &str)] = &[
    ("permission_request.status", "UPDATE"),
    ("permission_request.decided_at", "UPDATE"),
    ("permission_request.decided_by", "UPDATE"),
    ("permission_request.grant_expires_at", "UPDATE"),
    ("permission_request.grant_mode", "UPDATE"),
    ("message.meta", "UPDATE"),
    ("audit_log", "INSERT"),
    ("command_grant", "INSERT"),
    ("account_grant", "INSERT"),
    ("account_grant.granted_by", "UPDATE"),
    ("account_grant.granted_at", "UPDATE"),
    ("account_grant.expires_at", "UPDATE"),
    ("account_grant.allow_agent_cause", "UPDATE"),
    ("event_outbox", "INSERT"),
];
pub const APPROVE_SEQUENCE_PRIVILEGES: &[(&str, &str)] = &[("event_outbox_id_seq", "USAGE")];

/// TS `PERMISSION_GRANT_TTL_MS`(7일)·`COMMAND_GRANT_TTL_MS`(1시간) — 시험이 TS 원문과 대조한다.
pub const TOOL_GRANT_TTL: &str = "7 days";
pub const COMMAND_GRANT_TTL: &str = "1 hour";

pub async fn approve_pool(pool: &sqlx::PgPool) -> Option<sqlx::PgPool> {
    match crate::write::missing_in(pool, APPROVE_PRIVILEGES, APPROVE_SEQUENCE_PRIVILEGES).await {
        Ok(m) if m.is_empty() => {}
        Ok(m) => {
            eprintln!("front: permission approve core off — missing privileges {m:?}");
            return None;
        }
        Err(e) => {
            eprintln!(
                "front: permission approve core off — privilege check failed ({})",
                e.as_database_error().map_or("io", |_| "db")
            );
            return None;
        }
    }
    match has_lock_fn_privilege(pool).await {
        Ok(true) => Some(pool.clone()),
        Ok(false) => {
            eprintln!("front: permission approve core off — no EXECUTE on the lock fn");
            None
        }
        Err(e) => {
            eprintln!(
                "front: permission approve core off — lock fn check failed ({})",
                e.as_database_error().map_or("io", |_| "db")
            );
            None
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct ApproveArgs<'a> {
    pub agent_id: &'a str,
    pub request_id: &'a str,
    pub actor_id: &'a str,
    /// `approve`·`approve_once`·`approve_hour`.
    pub option: &'a str,
    /// 카드 길이면 카드 meta 에 1회 머지 값(`permissionRequest.once`)이 있는가 — TS `onceFromCard`. 있으면 TS(`not_once` 갈래).
    pub has_once: bool,
    pub bundle_message_id: Option<&'a str>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApproveOutcome {
    /// 쓰고 커밋했다. 카드 답은 호출자 몫 — `answer_candidates` 중 카드에 있는 첫 것(TS `answerOptionId`).
    Granted {
        card_message_id: Option<String>,
        grant_expires_at: String,
        grant_mode: Option<&'static str>,
        answer_candidates: &'static [&'static str],
    },
    Refused {
        status: u16,
        code: &'static str,
        message: String,
    },
    HandToTs,
}

#[derive(Debug)]
pub enum ApproveError {
    Lock(LockRetryError),
    RestartsExhausted,
}

fn refused(status: u16, code: &'static str, message: impl Into<String>) -> ApproveOutcome {
    ApproveOutcome::Refused {
        status,
        code,
        message: message.into(),
    }
}

fn not_found() -> ApproveOutcome {
    refused(
        404,
        "not_found",
        "no such permission request for this agent",
    )
}

pub const NOT_GRANTABLE_MESSAGE: &str =
    "this command is no longer grantable — the agent has to ask again";

/// TS `answerOptionId` 후보 — command: `[hour→approve_hour | approve_once, approve_once]`, tool: `[approve, approve_mandate, approve_new_mandate, approve, approve_once]`.
const ANSWER_HOUR: &[&str] = &["approve_hour", "approve_once"];
const ANSWER_ONCE: &[&str] = &["approve_once", "approve_once"];
const ANSWER_TOOL: &[&str] = &[
    "approve",
    "approve_mandate",
    "approve_new_mandate",
    "approve",
    "approve_once",
];

/// 결정 시각 하나(ms 로 자름 — TS `Date` 와 같은 정밀도)와 기한($1 interval). 모든 칸·카드·감사가 이 값을 쓴다.
/// (결정 시각, 결정 시각 ISO, 기한, 기한 ISO).
const TIMES: &str = "with t as (select date_trunc('milliseconds', now()) as n) \
     select n::text, to_char(n at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'), \
     (n + $1::interval)::text, to_char((n + $1::interval) at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') from t";

/// 잠근 요청 줄의 나머지 칸(같은 tx, 이미 잠김).
const READ_LOCKED_TARGET: &str = "select target, channel_id::text, thread_root_id::text \
     from permission_request where id = $1::uuid";

/// TS 와 같은 INSERT(`file_digests` 는 요청 줄에서 옮긴다). $5 single_use, $6 기한, $9 결정 시각.
pub const INSERT_COMMAND_GRANT: &str = "insert into command_grant (agent_id, channel_id, thread_root_id, command, single_use, \
     expires_at, granted_by, request_id, created_at, file_digests) \
     select $1::uuid, $2::uuid, $3::uuid, $4, $5, $6::timestamptz, $7::uuid, $8::uuid, $9::timestamptz, r.file_digests \
     from permission_request r where r.id = $8::uuid returning id::text";

/// TS 의 account_grant upsert — 소유자 승인(`byUser = false`)이라 늘 덮는다(`allow_agent_cause` 는 끈다).
pub const UPSERT_TOOL_GRANT: &str = "insert into account_grant (account_id, capability, scope, granted_by, expires_at, allow_agent_cause) \
     values ($1::uuid, 'tool.allow', $2, $3::uuid, $4::timestamptz, false) \
     on conflict (account_id, capability, scope) do update \
       set granted_by = excluded.granted_by, granted_at = now(), expires_at = excluded.expires_at, allow_agent_cause = false";

pub const APPROVE_UPDATE_REQUEST: &str = "update permission_request set status = 'granted', decided_at = $3::timestamptz, \
     decided_by = $2::uuid, grant_expires_at = $4::timestamptz, grant_mode = $5 where id = $1::uuid";
pub const APPROVE_UPDATE_CARD: &str = super::decide_core::DENY_UPDATE_CARD;
pub const APPROVE_AUDIT: &str = "insert into audit_log (action, actor_id, target, detail) \
     values ('permission.approved', $1::uuid, $2, $3::jsonb)";
pub const GRANT_GIVEN_AUDIT: &str = "insert into audit_log (action, actor_id, target, detail) \
     values ('grant.given', $1::uuid, $2, $3::jsonb)";

/// 요청 줄을 잠근 뒤 같은 tx 에서 승인을 쓴다. 상태 대조 순서·문구는 TS 와 같다(거절과 같은 앞부분).
pub async fn approve_write(
    conn: &mut PgConnection,
    locked: &LockedRequest,
    args: ApproveArgs<'_>,
    decision: Decision,
) -> sqlx::Result<ApproveOutcome> {
    match locked.status.as_str() {
        "obsolete" => {
            return Ok(refused(
                409,
                "pr_closed",
                "that pull request was already merged or closed — this card is closed",
            ));
        }
        "superseded" => {
            return Ok(refused(
                409,
                "superseded",
                "the agent asked again — decide on the newer card",
            ));
        }
        "pending" => {}
        s => {
            return Ok(refused(
                409,
                "already_decided",
                format!("this request is already {s}"),
            ));
        }
    }
    if locked.expired {
        // TS 는 이 자리에서 카드를 만료로 닫는다 — 그 일은 TS 가 한다(쓰기 전).
        return Ok(ApproveOutcome::HandToTs);
    }
    let (target, channel_id, thread_root_id): (String, Option<String>, Option<String>) =
        sqlx::query_as(READ_LOCKED_TARGET)
            .bind(args.request_id)
            .fetch_one(&mut *conn)
            .await?;
    let (ttl, grant_mode, candidates) = match (locked.kind.as_str(), decision) {
        ("command", Decision::ApproveHour) => (COMMAND_GRANT_TTL, Some("hour"), ANSWER_HOUR),
        ("command", Decision::ApproveOnce) => (COMMAND_GRANT_TTL, Some("once"), ANSWER_ONCE),
        ("tool", Decision::Approve) => (TOOL_GRANT_TTL, None, ANSWER_TOOL),
        // rust_takes 가 거른다 — 여기 오면 맡지 않는다(쓰기 전).
        _ => return Ok(ApproveOutcome::HandToTs),
    };
    let (now, now_iso, expires, expires_iso): (String, String, String, String) =
        sqlx::query_as(TIMES)
            .bind(ttl)
            .fetch_one(&mut *conn)
            .await?;

    let mut command_grant_id: Option<String> = None;
    let mut tool_scope: Option<String> = None;
    if let Some(mode) = grant_mode {
        // 승인 시점에 다시 판정한다 — 저장 뒤 판정이 좁아졌으면 열지 않는다(TS 와 같은 조건: ok 이고 정규형이 원문과 같음).
        match validate_exact_command(&target) {
            ExactCommandVerdict::Ok { command, .. } if command == target => {}
            _ => return Ok(refused(409, "not_grantable", NOT_GRANTABLE_MESSAGE)),
        }
        let id: String = sqlx::query_scalar(INSERT_COMMAND_GRANT)
            .bind(args.agent_id)
            .bind(channel_id.as_deref())
            .bind(thread_root_id.as_deref())
            .bind(&target)
            .bind(mode == "once")
            .bind(&expires)
            .bind(args.actor_id)
            .bind(args.request_id)
            .bind(&now)
            .fetch_one(&mut *conn)
            .await?;
        command_grant_id = Some(id);
    } else {
        let Some(ch) = channel_id.as_deref() else {
            // 채널 없는 tool 요청은 없다(요청 길이 채널을 요구) — 꼴이 다르면 TS.
            return Ok(ApproveOutcome::HandToTs);
        };
        let scope = format!("tool:{ch}:{target}");
        sqlx::query(UPSERT_TOOL_GRANT)
            .bind(args.agent_id)
            .bind(&scope)
            .bind(args.actor_id)
            .bind(&expires)
            .execute(&mut *conn)
            .await?;
        tool_scope = Some(scope);
    }
    sqlx::query(APPROVE_UPDATE_REQUEST)
        .bind(args.request_id)
        .bind(args.actor_id)
        .bind(&now)
        .bind(&expires)
        .bind(grant_mode)
        .execute(&mut *conn)
        .await?;
    if let Some(card) = locked.card_message_id.as_deref() {
        let mut patch = json!({
            "status": "granted", "decidedAt": now_iso, "decidedBy": args.actor_id,
            "grantExpiresAt": expires_iso,
        });
        if let Some(m) = grant_mode {
            patch["grantMode"] = json!(m);
        }
        if let Some(b) = args.bundle_message_id {
            patch["decidedVia"] = json!({ "kind": "bundle", "bundleMessageId": b });
        }
        patch["decidedByOwner"] = Value::Bool(true);
        sqlx::query(APPROVE_UPDATE_CARD)
            .bind(card)
            .bind(patch.to_string())
            .execute(&mut *conn)
            .await?;
    }
    let detail = audit_detail(&AuditDetail {
        request_id: args.request_id,
        kind: locked.kind.as_str(),
        target: target.as_str(),
        channel_id: channel_id.as_deref(),
        as_owner: true,
        thread_root_id: thread_root_id.as_deref(),
        grant_expires_at: Some(expires_iso.as_str()),
        grant_mode: grant_mode.zip(command_grant_id.as_deref()),
        bundle_message_id: args.bundle_message_id,
    });
    sqlx::query(APPROVE_AUDIT)
        .bind(args.actor_id)
        .bind(args.agent_id)
        .bind(detail.to_string())
        .execute(&mut *conn)
        .await?;
    if let Some(scope) = &tool_scope {
        let given = json!({
            "capability": "tool.allow", "scope": scope, "expiresAt": expires_iso,
            "allowAgentCause": false, "via": "permission_request", "requestId": args.request_id,
        });
        sqlx::query(GRANT_GIVEN_AUDIT)
            .bind(args.actor_id)
            .bind(args.agent_id)
            .bind(given.to_string())
            .execute(&mut *conn)
            .await?;
    }
    crate::write::emit_event(
        conn,
        &json!({ "type": "grant.changed", "accountId": args.agent_id, "audience": "all" }),
    )
    .await?;
    Ok(ApproveOutcome::Granted {
        card_message_id: locked.card_message_id.clone(),
        grant_expires_at: expires_iso,
        grant_mode,
        answer_candidates: candidates,
    })
}

const PEEK_REQUEST: &str =
    "select agent_id::text, channel_id::text from permission_request where id = $1::uuid";

async fn approve_attempt(
    pool: &sqlx::PgPool,
    args: ApproveArgs<'_>,
) -> sqlx::Result<Option<ApproveOutcome>> {
    if !is_uuid(args.request_id) || !is_uuid(args.agent_id) || !is_uuid(args.actor_id) {
        return Ok(Some(not_found()));
    }
    let mut tx = pool.begin().await?;
    let first: Option<(String, Option<String>)> = sqlx::query_as(PEEK_REQUEST)
        .bind(args.request_id)
        .fetch_optional(&mut *tx)
        .await?;
    let Some((agent, channel)) = first else {
        return Ok(Some(not_found()));
    };
    if agent != args.agent_id {
        return Ok(Some(not_found()));
    }
    let v = may_decide_for_locked(&mut tx, &agent, args.actor_id, channel.as_deref()).await?;
    let locked = lock_request(&mut tx, args.request_id).await?;
    let shape = Shape {
        option: args.option,
        kind: "",
        has_mandate: false,
        has_denial: false,
        has_once: args.has_once,
        via_chat: false,
        via_mirror: false,
    };
    let d = match recheck_locked(&agent, channel.as_deref(), locked.as_ref(), shape) {
        Recheck::Go(d) => d,
        Recheck::Restart => return Ok(None),
        Recheck::HandToTs => return Ok(Some(ApproveOutcome::HandToTs)),
        Recheck::Gone => return Ok(Some(not_found())),
    };
    if d == Decision::Deny {
        return Ok(Some(ApproveOutcome::HandToTs));
    }
    match after_verdict(&v, d) {
        AfterVerdict::Forbidden => {
            return Ok(Some(refused(403, "forbidden", FORBIDDEN_MESSAGE)));
        }
        AfterVerdict::HandToTs | AfterVerdict::Go { as_owner: false } => {
            return Ok(Some(ApproveOutcome::HandToTs));
        }
        AfterVerdict::Go { as_owner: true } => {}
    }
    let Some(locked) = locked else {
        return Ok(Some(not_found()));
    };
    let out = approve_write(&mut tx, &locked, args, d).await?;
    if matches!(out, ApproveOutcome::Granted { .. }) {
        tx.commit().await?;
    }
    Ok(Some(out))
}

/// 승인 입구 — [`super::decide_core::decide_deny`] 와 같은 재시도·다시 하기 규칙.
pub async fn decide_approve(
    pool: &sqlx::PgPool,
    args: ApproveArgs<'_>,
) -> Result<ApproveOutcome, ApproveError> {
    for _ in 0..=MAX_RESTARTS {
        match retry_lock_once(|| approve_attempt(pool, args)).await {
            Ok(Some(out)) => return Ok(out),
            Ok(None) => continue,
            Err(e) => return Err(ApproveError::Lock(e)),
        }
    }
    Err(ApproveError::RestartsExhausted)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn answer_candidates_follow_ts_order() {
        assert_eq!(ANSWER_HOUR[0], "approve_hour");
        assert_eq!(ANSWER_ONCE[0], "approve_once");
        assert_eq!(ANSWER_TOOL[0], "approve");
    }

    #[test]
    fn privileges_extend_deny() {
        for p in super::super::decide_core::DENY_PRIVILEGES {
            assert!(APPROVE_PRIVILEGES.contains(p), "{p:?}");
        }
    }
}
