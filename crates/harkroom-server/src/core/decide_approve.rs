//! S5.3 B2 — 권한 카드 **승인** 중 소유자만 하는 길(TS `decidePermissionRequest` 의 그 갈래):
//! - `tool` + `approve` → 7일 `tool.allow` grant(`account_grant` upsert, `allow_agent_cause = false`) + 감사 `grant.given`.
//! - `command` + `approve_once`·`approve_hour` → 명령을 **다시 판정**한 뒤 1시간 `command_grant`(요청 줄의 `file_digests` 를 옮김).
//!
//! 둘 다 요청 줄 `granted`·카드 meta·감사 `permission.approved`·`grant.changed`(outbox) 를 **한 tx** 에 쓴다.
//!
//! S5.3 C1 — 요청 줄에 위임장(`mandate_id`)이 있으면 tool 7일 승인(`approve`·`approve_mandate`)은 grant 와 함께 그 위임장에 줄 하나를
//! 적고([`super::mandate_line_write`], savepoint — 줄이 실패해도 결정은 남는다), `approve_turn`(이번 턴만)은 grant 없이 줄 하나가
//! 승인의 전부라 줄이 실패하면 409 `mandate_line_failed` 로 아무것도 커밋하지 않는다. 줄 감사(`mandate.line.added`·`add_failed`)도 같은 tx.
//!
//! S5.3 C3 — 위임장 있는 command `approve_once`·`approve_hour` 도 1시간 `command_grant` 와 함께 그 위임장에 cap `command` 줄 하나
//! (기한 1시간, 「이번 한 번」은 `uses: 1`)를 적는다. grant 를 썼으므로 줄이 실패하면 savepoint 로 줄만 되돌리고 결정은 남긴다(TS 와 같음).
//!
//! 맡는 꼴은 [`super::decide_core::rust_takes`] 가 정한다(`once`·글 승인·거울·merge·위임장 있는 deny 는 처음부터 TS). 소유자가 아닌 사람의 승인은
//! 판정 뒤([`super::decide_core::after_verdict`]) 쓰기 전에 TS 로 넘긴다(소유자 알림 글을 TS 가 쓴다).
//!
//! TS 와 다른 점(덜 여는 쪽): TS 는 감사·`grant.given`·이벤트를 커밋 **뒤**에 쓰고 실패를 삼킨다. 여기서는 결정과 같은 tx 라
//! 감사가 실패하면 grant 도 남지 않는다(`internal`, TS 로 넘기지 않음).
use super::decide_core::{
    AfterVerdict, AuditDetail, Decision, FORBIDDEN_MESSAGE, LockRetryError, LockedRequest,
    MAX_RESTARTS, Recheck, Shape, after_verdict, audit_detail, has_lock_fn_privilege, lock_request,
    may_decide_for_locked, recheck_locked, retry_lock_once,
};
use super::mandate_card_thread::{
    MANDATE_CREATED_AUDIT, Made, card_stamp_sql, mandate_for_card_thread, request_stamp_sql,
};
use super::mandate_line_write::{LINE_AUDIT, LineArgs, LineKind, add_line_from_request};
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
/// S5.3 C1 — 있는 위임장에 줄을 쓰는 칸. [`APPROVE_PRIVILEGES`] 에 더해 이것도 다 있을 때만 위임장 있는 승인을 Rust 가 맡는다
/// ([`mandate_core_on`], fail-closed — 없으면 「permission mandate core off」를 남기고 그 꼴은 TS). `for share` 는 그 표의 UPDATE 칸이
/// 하나라도 있어야 하므로 `mandate.last_activity_at` UPDATE 를 함께 요구한다.
pub const MANDATE_LINE_PRIVILEGES: &[(&str, &str)] = &[
    ("mandate", "SELECT"),
    ("mandate.last_activity_at", "UPDATE"),
    ("mandate_line", "INSERT"),
    // 자동화 위임장의 유효성(골든 `grant_valid_mandate_owner`)이 읽는 4칸만 — 표 단위 SELECT 를 요구하면 운영 쓰기 롤이
    // 수신 비밀 칸(`ingress_token_hash`·`ingress_secret_enc`)까지 읽게 된다(security 11-18, `tests/automation_grant.rs` 가 본다).
    ("automation.id", "SELECT"),
    ("automation.deleted_at", "SELECT"),
    ("automation.enabled", "SELECT"),
    ("automation.approved_at", "SELECT"),
    ("agent_config", "SELECT"),
];

static MANDATE_CORE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// S5.3 C2 — 카드 스레드에 위임장을 **새로 세우는** 칸(`approve_new_mandate`). [`MANDATE_LINE_PRIVILEGES`] 에 더해 이것도 다 있을 때만
/// 위임장 없는 `approve_new_mandate` 를 Rust 가 맡는다(fail-closed — 없으면 「permission new mandate core off」, 그 꼴은 TS).
/// 머리 글 `for update` 는 `message` 의 UPDATE 칸(`message.meta`, [`APPROVE_PRIVILEGES`])으로 된다.
pub const NEW_MANDATE_PRIVILEGES: &[(&str, &str)] = &[
    ("mandate.owner_account_id", "INSERT"),
    ("mandate.delegator_account_id", "INSERT"),
    ("mandate.root_message_id", "INSERT"),
    ("mandate.channel_id", "INSERT"),
    ("mandate.thread_root_id", "INSERT"),
    ("mandate.created_at", "INSERT"),
    ("mandate.last_activity_at", "INSERT"),
    ("message.mandate_id", "UPDATE"),
    ("permission_request.mandate_id", "UPDATE"),
];

static NEW_MANDATE_CORE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 위임장 없는 `approve_new_mandate`(C2)를 Rust 가 맡는가 — [`check_mandate_core`] 가 C1 칸과 함께 정한다.
pub fn new_mandate_core_on() -> bool {
    mandate_core_on() && NEW_MANDATE_CORE.load(std::sync::atomic::Ordering::Relaxed)
}

/// S5.3 C3 — 위임장 있는 command 승인을 Rust 가 맡는가. 새 칸은 없다 — 줄은 C1 칸([`MANDATE_LINE_PRIVILEGES`]), 명령 grant 는
/// B2 칸([`APPROVE_PRIVILEGES`] 의 `command_grant` INSERT)으로 쓴다. 그래서 C1 스위치를 그대로 따른다(fail-closed —
/// C1 이 꺼지면 「permission mandate command core off」를 남기고 그 꼴은 TS).
pub fn mandate_command_core_on() -> bool {
    mandate_core_on()
}

/// 위임장 있는 승인(C1)을 Rust 가 맡는가 — 기동 때 [`check_mandate_core`] 가 정한다.
pub fn mandate_core_on() -> bool {
    MANDATE_CORE.load(std::sync::atomic::Ordering::Relaxed)
}

/// 승인 풀에 [`MANDATE_LINE_PRIVILEGES`] 가 다 있는가 — 기동 때 한 번. 없으면 「permission mandate core off」.
pub async fn check_mandate_core(pool: &sqlx::PgPool) -> bool {
    let on = match crate::write::missing_in(pool, MANDATE_LINE_PRIVILEGES, &[]).await {
        Ok(m) if m.is_empty() => true,
        Ok(m) => {
            eprintln!("front: permission mandate core off — missing privileges {m:?}");
            false
        }
        Err(e) => {
            eprintln!(
                "front: permission mandate core off — privilege check failed ({})",
                e.as_database_error().map_or("io", |_| "db")
            );
            false
        }
    };
    MANDATE_CORE.store(on, std::sync::atomic::Ordering::Relaxed);
    if !on {
        eprintln!("front: permission mandate command core off — follows permission mandate core");
    }
    let new_on = on
        && match crate::write::missing_in(pool, NEW_MANDATE_PRIVILEGES, &[]).await {
            Ok(m) if m.is_empty() => true,
            Ok(m) => {
                eprintln!("front: permission new mandate core off — missing privileges {m:?}");
                false
            }
            Err(e) => {
                eprintln!(
                    "front: permission new mandate core off — privilege check failed ({})",
                    e.as_database_error().map_or("io", |_| "db")
                );
                false
            }
        };
    NEW_MANDATE_CORE.store(new_on, std::sync::atomic::Ordering::Relaxed);
    on
}

/// S5.4 12e — 승인 길이 만료를 만났을 때 그 자리에서 카드를 닫는 칸(TS `expirePermissionRequests(requestId)`).
/// 만료 루프와 같은 칸([`crate::loops::permission_expire::PERMISSION_EXPIRE_PRIVILEGES`]) — 승인 칸에 더해 `inbox` INSERT 가 새로 든다.
/// 다 있을 때만 승인 길의 만료 409 를 Rust 가 답한다(fail-closed — 없으면 「permission decide expire core off」, 그 꼴은 TS).
static DECIDE_EXPIRE_CORE: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// 승인 길의 만료(409 `request_expired` + 카드 닫기)를 Rust 가 맡는가.
pub fn decide_expire_core_on() -> bool {
    DECIDE_EXPIRE_CORE.load(std::sync::atomic::Ordering::Relaxed)
}

/// 승인 풀에 만료 칸이 다 있는가 — 기동 때 한 번.
pub async fn check_decide_expire_core(pool: &sqlx::PgPool) -> bool {
    use crate::loops::permission_expire as pe;
    let on = match crate::write::missing_in(
        pool,
        pe::PERMISSION_EXPIRE_PRIVILEGES,
        pe::PERMISSION_EXPIRE_SEQUENCE_PRIVILEGES,
    )
    .await
    {
        Ok(m) if m.is_empty() => true,
        Ok(m) => {
            eprintln!("front: permission decide expire core off — missing privileges {m:?}");
            false
        }
        Err(e) => {
            eprintln!(
                "front: permission decide expire core off — privilege check failed ({})",
                e.as_database_error().map_or("io", |_| "db")
            );
            false
        }
    };
    DECIDE_EXPIRE_CORE.store(on, std::sync::atomic::Ordering::Relaxed);
    on
}

/// TS `request_expired` 문구(골든).
pub const REQUEST_EXPIRED_MESSAGE: &str = "this request expired — the agent has to ask again";

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
    /// `approve`·`approve_mandate`·`approve_turn`·`approve_once`·`approve_hour`.
    pub option: &'a str,
    /// 카드 길이면 카드 meta 에 1회 머지 값(`permissionRequest.once`)이 있는가 — TS `onceFromCard`. 있으면 TS(`not_once` 갈래).
    pub has_once: bool,
    /// 카드의 1회 머지 값(TS `onceFromCard`, gh 계정은 비움 — 오퍼레이터가 고른다). 머지 [이번 한 번]만 쓴다.
    pub once: Option<&'a super::decide_merge_once::Once>,
    pub bundle_message_id: Option<&'a str>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApproveOutcome {
    /// 쓰고 커밋했다. 카드 답은 호출자 몫 — `answer_candidates` 중 카드에 있는 첫 것(TS `answerOptionId`).
    Granted {
        /// TS 결과 `status` — `granted` 또는 머지 1회의 `approved_once`.
        status: &'static str,
        /// 머지 1회 승인의 기한(TS `approvalExpiresAt`).
        approval_expires_at: Option<String>,
        card_message_id: Option<String>,
        grant_expires_at: Option<String>,
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

/// TS `not_once` 문구(골든).
/// TS `decidePermissionRequest` 의 `bad_decision` 문구(골든).
pub const BAD_DECISION_COMMAND_MANDATE: &str =
    "an exact-command request is approved once (or for an hour) — not for a mandate";
pub const BAD_DECISION_TURN: &str =
    "only a tool request on a mandate thread can be approved for one turn";
pub const BAD_DECISION_HOUR: &str = "once/hour is only for an exact-command request";
pub const NOT_ONCE_MESSAGE: &str = "only a card raised from a merge refusal can approve one merge";

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
/// TS 후보는 `[decision, approve_mandate, …]` 라 approve_mandate 가 두 번 나온다 — 첫 일치를 고르므로 뒤의 것은 빼도 같다(security 낮음).
const ANSWER_TOOL_MANDATE: &[&str] = &[
    "approve_mandate",
    "approve_new_mandate",
    "approve",
    "approve_once",
];
/// TS `[approve_new_mandate, approve_mandate, approve_new_mandate, …]` — 같은 이유로 뒤의 approve_new_mandate 를 뺐다.
const ANSWER_TOOL_NEW_MANDATE: &[&str] = &[
    "approve_new_mandate",
    "approve_mandate",
    "approve",
    "approve_once",
];
const ANSWER_TOOL_TURN: &[&str] = &[
    "approve_turn",
    "approve_mandate",
    "approve_new_mandate",
    "approve",
    "approve_once",
];

pub const MANDATE_LINE_FAILED_STATUS: u16 = 409;

/// TS `mandate_unavailable` 문구(approve_new_mandate 가 이 스레드에 위임장을 세울 수 없을 때). 카드·묶음 답 입구는 이것을 받으면
/// `approve`(7일)로 한 번 더 한다(TS `decide` 와 같음, merge 는 처음부터 TS).
pub const MANDATE_UNAVAILABLE_MESSAGE: &str =
    "a mandate cannot be started on this thread — approve from a thread you started";

/// TS `mandate_line_failed` 문구.
pub fn mandate_line_failed_message(code: &str) -> String {
    format!(
        "the line could not be added to the mandate ({code}) — nothing was approved; the agent has to ask again"
    )
}

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
    as_owner: bool,
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
    // S5.4 — 머지 거절 카드의 [이번 한 번](rust_takes 가 거절 기록 있음·위임장 없음·카드 once 있음만 들인다).
    if decision == Decision::ApproveOnce && locked.kind == "merge" {
        if !as_owner {
            return Ok(ApproveOutcome::HandToTs);
        }
        return merge_once_write(conn, locked, args).await;
    }
    // TS `decidePermissionRequest`: command 가 아닌 카드의 `approve_once` 는 머지 거절 카드 + once 일 때만 — 그 밖은 쓰기 없이 409.
    if decision == Decision::ApproveOnce && locked.kind != "command" {
        return Ok(refused(409, "not_once", NOT_ONCE_MESSAGE));
    }
    // S5.4 11d — TS 와 같은 차례의 쓰기 없는 409 `bad_decision` 셋(소유자 승인만 여기 온다 — 위임장 줄 지우기 갈래 없음).
    if locked.kind == "command"
        && matches!(
            decision,
            Decision::ApproveMandate | Decision::ApproveNewMandate
        )
    {
        return Ok(refused(409, "bad_decision", BAD_DECISION_COMMAND_MANDATE));
    }
    // S5.4 12e — 소유자가 아닌 사람은 TS 가 그 사람이 맡긴 위임장이 아니면 위임장을 지운 뒤에 [이번 턴만]을 본다 — 위임장이 있으면 TS.
    if !as_owner && decision == Decision::ApproveTurn && locked.mandate_id.is_some() {
        return Ok(ApproveOutcome::HandToTs);
    }
    if decision == Decision::ApproveTurn
        && (locked.kind != "tool"
            || locked.mandate_id.is_none()
            || locked.card_message_id.is_none())
    {
        return Ok(refused(409, "bad_decision", BAD_DECISION_TURN));
    }
    if decision == Decision::ApproveHour && locked.kind != "command" {
        return Ok(refused(409, "bad_decision", BAD_DECISION_HOUR));
    }
    // S5.4 12e — 소유자가 아닌 사람의 승인은 쓰기 없는 거절(위)까지만 Rust. 쓰는 길(그 사람 이름 grant·소유자 알림 글)은 TS.
    if !as_owner {
        return Ok(ApproveOutcome::HandToTs);
    }
    let (target, channel_id, thread_root_id): (String, Option<String>, Option<String>) =
        sqlx::query_as(READ_LOCKED_TARGET)
            .bind(args.request_id)
            .fetch_one(&mut *conn)
            .await?;
    let turn = decision == Decision::ApproveTurn;
    let (ttl, grant_mode, candidates) = match (locked.kind.as_str(), decision) {
        ("command", Decision::ApproveHour) => (COMMAND_GRANT_TTL, Some("hour"), ANSWER_HOUR),
        ("command", Decision::ApproveOnce) => (COMMAND_GRANT_TTL, Some("once"), ANSWER_ONCE),
        ("tool", Decision::Approve) => (TOOL_GRANT_TTL, None, ANSWER_TOOL),
        ("tool", Decision::ApproveMandate) => (TOOL_GRANT_TTL, None, ANSWER_TOOL_MANDATE),
        ("tool", Decision::ApproveNewMandate) => (TOOL_GRANT_TTL, None, ANSWER_TOOL_NEW_MANDATE),
        // [이번 턴만] — grant 없이 줄 하나가 승인의 전부(기한 칸은 비운다, TS 와 같음).
        ("tool", Decision::ApproveTurn) => (COMMAND_GRANT_TTL, None, ANSWER_TOOL_TURN),
        // rust_takes 가 거른다 — 여기 오면 맡지 않는다(쓰기 전).
        _ => return Ok(ApproveOutcome::HandToTs),
    };
    // 위임장 있는 승인은 C1 칸이 다 있을 때만(fail-closed), [이번 턴만]은 위임장과 카드 글이 있어야 한다(아니면 TS 409 `bad_decision`).
    if locked.mandate_id.is_some() && !mandate_core_on() {
        return Ok(ApproveOutcome::HandToTs);
    }
    // C3 — 위임장 있는 command 는 그 스위치로(지금은 C1 과 같다, fail-closed).
    if locked.mandate_id.is_some() && grant_mode.is_some() && !mandate_command_core_on() {
        return Ok(ApproveOutcome::HandToTs);
    }
    if turn && (locked.mandate_id.is_none() || locked.card_message_id.is_none()) {
        return Ok(ApproveOutcome::HandToTs);
    }
    // C2 — 위임장 없는 [이 스레드로 위임장 만들고 더하기]는 C2 칸까지 다 있을 때만(fail-closed, 쓰기 전).
    let new_mandate = decision == Decision::ApproveNewMandate && locked.mandate_id.is_none();
    if new_mandate && !new_mandate_core_on() {
        return Ok(ApproveOutcome::HandToTs);
    }
    let (now, now_iso, expires, expires_iso): (String, String, String, String) =
        sqlx::query_as(TIMES)
            .bind(ttl)
            .fetch_one(&mut *conn)
            .await?;
    // grant 를 쓰는 갈래만 기한이 있다(TS `grantExpiresAt`).
    let (expires, expires_iso) = if turn {
        (None, None)
    } else {
        (Some(expires), Some(expires_iso))
    };

    // C2 — 머리 글을 잠그고(잠금 7단계) 위임장을 세우거나 잇는다. 못 세우면 409 `mandate_unavailable`(커밋 없음) — 입구가 approve 로
    // 한 번 더 한다. 세웠으면 요청 줄·카드 글(이 요청의 에이전트가 쓴 것만)에 키를 적는다(TS 와 같은 차례: grant 보다 먼저).
    let mut mandate_id = locked.mandate_id.clone();
    let mut created: Option<Made> = None;
    if new_mandate {
        let (Some(ch), Some(root)) = (channel_id.as_deref(), thread_root_id.as_deref()) else {
            return Ok(refused(
                409,
                "mandate_unavailable",
                MANDATE_UNAVAILABLE_MESSAGE,
            ));
        };
        let Some(made) = mandate_for_card_thread(conn, args.actor_id, ch, root, &now).await? else {
            return Ok(refused(
                409,
                "mandate_unavailable",
                MANDATE_UNAVAILABLE_MESSAGE,
            ));
        };
        sqlx::query(request_stamp_sql())
            .bind(args.request_id)
            .bind(&made.mandate_id)
            .execute(&mut *conn)
            .await?;
        if let Some(card) = locked.card_message_id.as_deref() {
            sqlx::query(card_stamp_sql())
                .bind(card)
                .bind(&made.mandate_id)
                .bind(args.agent_id)
                .execute(&mut *conn)
                .await?;
        }
        mandate_id = Some(made.mandate_id.clone());
        created = made.inserted.then_some(made);
    }

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
            .bind(expires.as_deref())
            .bind(args.actor_id)
            .bind(args.request_id)
            .bind(&now)
            .fetch_one(&mut *conn)
            .await?;
        command_grant_id = Some(id);
    } else if !turn {
        let Some(ch) = channel_id.as_deref() else {
            // 채널 없는 tool 요청은 없다(요청 길이 채널을 요구) — 꼴이 다르면 TS.
            return Ok(ApproveOutcome::HandToTs);
        };
        let scope = format!("tool:{ch}:{target}");
        sqlx::query(UPSERT_TOOL_GRANT)
            .bind(args.agent_id)
            .bind(&scope)
            .bind(args.actor_id)
            .bind(expires.as_deref())
            .execute(&mut *conn)
            .await?;
        tool_scope = Some(scope);
    }
    // C1 — 위임장이 있으면 그 위임장에 줄 하나(TS `addLineFromRequest`, savepoint). [이번 턴만]은 줄이 승인의 전부라 실패하면
    // 결정 전체를 되돌린다(409 `mandate_line_failed`, 커밋하지 않음). 7일 승인·command(C3)는 grant 를 썼으므로 줄만 되돌리고 결정은 남긴다.
    let line = match mandate_id.as_deref() {
        Some(mandate_id) => {
            let out = add_line_from_request(
                conn,
                LineArgs {
                    mandate_id,
                    request_id: args.request_id,
                    target: &target,
                    card_message_id: locked.card_message_id.as_deref(),
                    agent_id: args.agent_id,
                    actor_id: args.actor_id,
                    via: if args.bundle_message_id.is_some() {
                        "bundle"
                    } else {
                        "button"
                    },
                    kind: match grant_mode {
                        // C3 — command: 1시간, 「이번 한 번」이면 uses 1(TS `addLineFromRequest` command 갈래).
                        Some(mode) => LineKind::Command {
                            once: mode == "once",
                        },
                        None if turn => LineKind::Turn,
                        None => LineKind::Standing,
                    },
                    now: &now,
                    until: expires_iso.as_deref(),
                },
            )
            .await?;
            if turn && !out.ok() {
                return Ok(refused(
                    MANDATE_LINE_FAILED_STATUS,
                    "mandate_line_failed",
                    mandate_line_failed_message(out.code()),
                ));
            }
            Some(out)
        }
        None => None,
    };
    sqlx::query(APPROVE_UPDATE_REQUEST)
        .bind(args.request_id)
        .bind(args.actor_id)
        .bind(&now)
        .bind(expires.as_deref())
        .bind(grant_mode)
        .execute(&mut *conn)
        .await?;
    if let Some(card) = locked.card_message_id.as_deref() {
        let mut patch = json!({
            "status": "granted", "decidedAt": now_iso, "decidedBy": args.actor_id,
        });
        if let Some(e) = &expires_iso {
            patch["grantExpiresAt"] = json!(e);
        }
        if let Some(m) = grant_mode {
            patch["grantMode"] = json!(m);
        }
        if let Some(id) = line.as_ref().and_then(|l| l.line_id()) {
            patch["lineId"] = json!(id);
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
        grant_expires_at: expires_iso.as_deref(),
        grant_mode: grant_mode.zip(command_grant_id.as_deref()),
        bundle_message_id: args.bundle_message_id,
    });
    sqlx::query(APPROVE_AUDIT)
        .bind(args.actor_id)
        .bind(args.agent_id)
        .bind(detail.to_string())
        .execute(&mut *conn)
        .await?;
    if let Some(made) = &created {
        // TS `auditMandateCreated`(커밋 뒤) — 여기서는 같은 tx. channel·머리는 위에서 확인했다.
        let detail = made.audit_detail(
            channel_id.as_deref().unwrap_or_default(),
            thread_root_id.as_deref().unwrap_or_default(),
        );
        sqlx::query(MANDATE_CREATED_AUDIT)
            .bind(args.actor_id)
            .bind(&made.mandate_id)
            .bind(detail.to_string())
            .execute(&mut *conn)
            .await?;
    }
    if let Some(l) = &line {
        let (action, detail) = l.audit(args.request_id);
        sqlx::query(LINE_AUDIT)
            .bind(action)
            .bind(args.actor_id)
            .bind(args.agent_id)
            .bind(detail.to_string())
            .execute(&mut *conn)
            .await?;
    }
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
    // TS: command 이거나 grant 를 썼을 때만(이번 턴만은 grant 가 없어 이벤트도 없다).
    if !turn {
        crate::write::emit_event(
            conn,
            &json!({ "type": "grant.changed", "accountId": args.agent_id, "audience": "all" }),
        )
        .await?;
    }
    Ok(ApproveOutcome::Granted {
        status: "granted",
        approval_expires_at: None,
        card_message_id: locked.card_message_id.clone(),
        grant_expires_at: expires_iso,
        grant_mode,
        answer_candidates: candidates,
    })
}

/// 머지 거절 카드의 [이번 한 번] — TS `insertApprovalFromDenial` + `decidePermissionRequest` 의 그 갈래. 같은 tx, 감사도 tx 안.
/// 위임장·소유자 아님·once 값 없음·스위치 꺼짐은 쓰기 전에 TS.
async fn merge_once_write(
    conn: &mut PgConnection,
    locked: &LockedRequest,
    args: ApproveArgs<'_>,
) -> sqlx::Result<ApproveOutcome> {
    use super::decide_merge_once as m;
    let (Some(once), Some(denial_id), None, true) = (
        args.once,
        locked.denial_id.as_deref(),
        locked.mandate_id.as_deref(),
        m::merge_once_on(),
    ) else {
        return Ok(ApproveOutcome::HandToTs);
    };
    let (now, now_iso, expires, expires_iso): (String, String, String, String) =
        sqlx::query_as(TIMES)
            .bind(m::APPROVAL_TTL)
            .fetch_one(&mut *conn)
            .await?;
    type DenialRow = (
        String,
        String,
        String,
        i64,
        String,
        Option<String>,
        Option<String>,
        bool,
        String,
        Vec<String>,
        bool,
    );
    let row: Option<DenialRow> = sqlx::query_as(m::READ_DENIAL_LOCKED_SQL)
        .bind(denial_id)
        .bind(&now)
        .fetch_optional(&mut *conn)
        .await?;
    let view = row.as_ref().map(|r| m::DenialView {
        agent_id: &r.1,
        expired: r.7,
        obsolete: r.10,
        number: r.3,
        head_sha: &r.4,
        reason: &r.8,
        failed_checks: &r.9,
    });
    let ci_override = match m::check_once(args.agent_id, once, view.as_ref()) {
        m::OnceCheck::Go { ci_override } => ci_override,
        m::OnceCheck::Refused {
            status,
            code,
            message,
        } => return Ok(refused(status, code, message)),
        m::OnceCheck::HandToTs => return Ok(ApproveOutcome::HandToTs),
    };
    let Some((d_id, d_agent, scope, number, head_sha, d_channel, d_root, _, reason, failed, _)) =
        row
    else {
        return Ok(not_found());
    };
    let used: Option<String> = sqlx::query_scalar(m::USE_DENIAL_SQL)
        .bind(&d_id)
        .bind(&now)
        .bind(args.actor_id)
        .fetch_optional(&mut *conn)
        .await?;
    if used.is_none() {
        return Ok(refused(409, "denial_used", m::DENIAL_USED_MESSAGE));
    }
    let checks: Vec<String> = if ci_override { failed } else { Vec::new() };
    let approval_id: String = sqlx::query_scalar(m::INSERT_APPROVAL_SQL)
        .bind(&d_id)
        .bind(&d_agent)
        .bind(&scope)
        .bind(number)
        .bind(&head_sha)
        .bind(once.gh_user.as_deref())
        .bind(once.relax_checks)
        .bind(d_channel.as_deref())
        .bind(d_root.as_deref())
        .bind(args.actor_id)
        .bind(&now)
        .bind(&expires)
        .bind(ci_override)
        .bind(&checks)
        .fetch_one(&mut *conn)
        .await?;
    let (target, channel_id, thread_root_id): (String, Option<String>, Option<String>) =
        sqlx::query_as(READ_LOCKED_TARGET)
            .bind(args.request_id)
            .fetch_one(&mut *conn)
            .await?;
    sqlx::query(m::MERGE_ONCE_UPDATE_REQUEST)
        .bind(args.request_id)
        .bind(args.actor_id)
        .bind(&now)
        .execute(&mut *conn)
        .await?;
    if let Some(card) = locked.card_message_id.as_deref() {
        let mut patch = json!({
            "status": "approved_once", "decidedAt": now_iso, "decidedBy": args.actor_id,
            "approvedOnce": { "ghUser": once.gh_user, "relaxChecks": once.relax_checks, "expiresAt": expires_iso },
        });
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
    let mut once_detail = json!({
        "agentId": args.agent_id, "requestId": args.request_id, "approvalId": approval_id,
        "denialId": denial_id, "reason": reason, "number": number, "headSha": head_sha,
        "ghUser": once.gh_user,
    });
    if once.gh_user.is_none() {
        once_detail["ghUserChosenBy"] = json!("operator");
    }
    once_detail["relaxChecks"] = json!(once.relax_checks);
    once_detail["expiresAt"] = json!(expires_iso);
    sqlx::query(m::MERGE_ONCE_AUDIT)
        .bind(args.actor_id)
        .bind(&scope)
        .bind(once_detail.to_string())
        .execute(&mut *conn)
        .await?;
    let detail = audit_detail(&AuditDetail {
        request_id: args.request_id,
        kind: locked.kind.as_str(),
        target: target.as_str(),
        channel_id: channel_id.as_deref(),
        as_owner: true,
        thread_root_id: thread_root_id.as_deref(),
        grant_expires_at: None,
        grant_mode: None,
        bundle_message_id: args.bundle_message_id,
    });
    sqlx::query(APPROVE_AUDIT)
        .bind(args.actor_id)
        .bind(args.agent_id)
        .bind(detail.to_string())
        .execute(&mut *conn)
        .await?;
    Ok(ApproveOutcome::Granted {
        status: "approved_once",
        approval_expires_at: Some(expires_iso),
        card_message_id: locked.card_message_id.clone(),
        grant_expires_at: None,
        grant_mode: None,
        answer_candidates: m::ANSWER_MERGE_ONCE,
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
    // S5.4 12e — 소유자가 아닌 사람(`AfterVerdict::HandToTs`)도 여기서는 들인다: 쓰기 없는 거절까지만 Rust, 쓰는 길은
    // [`approve_write`] 가 쓰기 전에 TS 로 넘긴다.
    let as_owner = match after_verdict(&v, d) {
        AfterVerdict::Forbidden => {
            return Ok(Some(refused(403, "forbidden", FORBIDDEN_MESSAGE)));
        }
        AfterVerdict::HandToTs => false,
        AfterVerdict::Go { as_owner } => as_owner,
    };
    let Some(locked) = locked else {
        return Ok(Some(not_found()));
    };
    // S5.4 12e — 기다리던 요청이 만료됐으면 TS 처럼 결정 tx 를 버리고 그 요청만 만료로 닫은 뒤 409(쓰는 칸이 다 있을 때만).
    if locked.status == "pending" && locked.expired && decide_expire_core_on() {
        tx.rollback().await?;
        crate::loops::permission_expire::expire_permission_requests(pool, Some(args.request_id))
            .await?;
        return Ok(Some(refused(
            409,
            "request_expired",
            REQUEST_EXPIRED_MESSAGE,
        )));
    }
    let out = approve_write(&mut tx, &locked, args, d, as_owner).await?;
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
    let out = approve_once_shape(pool, args).await?;
    // TS `decide`: [이 스레드로 위임장 만들고 더하기]인데 위임장을 세울 수 없으면 7일 승인으로 한 번 더 한다(merge 는 TS 라 여기 없음).
    if args.option == "approve_new_mandate"
        && matches!(
            &out,
            ApproveOutcome::Refused {
                code: "mandate_unavailable",
                ..
            }
        )
    {
        return approve_once_shape(
            pool,
            ApproveArgs {
                option: "approve",
                ..args
            },
        )
        .await;
    }
    Ok(out)
}

async fn approve_once_shape(
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
    fn tool_approve_once_routing() {
        use super::super::decide_core::rust_takes;
        let base = Shape {
            option: "approve_once",
            kind: "tool",
            has_mandate: false,
            has_denial: false,
            has_once: false,
            via_chat: false,
            via_mirror: false,
        };
        assert_eq!(rust_takes(base), Some(Decision::ApproveOnce));
        let mandate = Shape {
            has_mandate: true,
            ..base
        };
        assert_eq!(rust_takes(mandate), Some(Decision::ApproveOnce));
        // once 본문·거절 기록·merge 는 TS(1회 머지 쓰기).
        for s in [
            Shape {
                has_once: true,
                ..base
            },
            Shape {
                has_denial: true,
                ..base
            },
            Shape {
                kind: "merge",
                ..base
            },
            // 머지 1회라도 위임장이 있거나 거절 기록이 없거나 거울·글 승인이면 TS.
            Shape {
                kind: "merge",
                has_once: true,
                has_denial: true,
                has_mandate: true,
                ..base
            },
            Shape {
                kind: "merge",
                has_once: true,
                ..base
            },
            Shape {
                kind: "merge",
                has_once: true,
                has_denial: true,
                via_mirror: true,
                ..base
            },
            Shape {
                kind: "merge",
                has_once: true,
                has_denial: true,
                via_chat: true,
                ..base
            },
            Shape {
                kind: "command",
                has_once: true,
                ..base
            },
            Shape {
                option: "approve",
                kind: "merge",
                has_once: true,
                has_denial: true,
                ..base
            },
        ] {
            assert_eq!(rust_takes(s), None, "{s:?}");
        }
        // S5.4 — 머지 거절 카드의 [이번 한 번](once·거절 기록·위임장 없음)은 Rust.
        let merge_once = Shape {
            kind: "merge",
            has_once: true,
            has_denial: true,
            ..base
        };
        assert_eq!(rust_takes(merge_once), Some(Decision::ApproveOnce));
    }

    #[test]
    fn not_once_message_matches_ts() {
        assert_eq!(
            NOT_ONCE_MESSAGE,
            "only a card raised from a merge refusal can approve one merge"
        );
    }

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
