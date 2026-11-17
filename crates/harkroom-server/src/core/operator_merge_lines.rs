//! AC5 — 머지 계정 줄(`GET /agents/{id}/merge-accounts`·`PUT .../merge-accounts/lines`)을 Rust 오퍼레이터 코어로 옮긴다.
//! TS `routes/mergeAccountRoutes.ts` 와 `services/operatorGhReport.ts`(`mergeAccountsOf`)를 그대로 따른다.
//!
//! 오퍼레이터 코어가 `/operator` 소켓을 가져가면 TS 허브는 비어서 `gh.lines.set` 이 아무에게도 가지 않는다. 그래서 AC5
//! 안전판이 두 줄을 503 으로 막아 두었고, 이 판이 Rust 로 옮긴다. 이름뿐이다(토큰·이메일 없음).
//!
//! 권한(TS 와 같다): **사람 세션 + 그 에이전트의 소유자**만. 아니면 그런 에이전트가 있는지도 말하지 않는다(404).
//! PUT 은 그 에이전트가 지금 배정된 오퍼레이터(폐기 안 됨)의 주인이어야 하고, 이름은 그 오퍼레이터가 마지막으로 알린
//! 로그인 가운데 하나여야 한다. 답은 **보낸 그 오퍼레이터**에게서 온 `gh.lines.result` 만 받는다.
use super::operator::OperatorCore;
use crate::auth::{Auth, Via};
use crate::directory::{internal, json_err};
use crate::lists::is_zod_uuid;
use crate::write::{AuditEntry, record_audit};
use crate::writes_settings::ip_of;
use axum::extract::{Path, Request, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};
use std::sync::Arc;
use tokio::sync::broadcast;

macro_rules! db {
    ($e:expr) => {
        match $e {
            Ok(v) => v,
            Err(e) => return internal(e),
        }
    };
}

const REFUSALS: &[&str] = &[
    "bad_request",
    "unknown_login",
    "no_agent",
    "unsupported",
    "out_of_community",
    "failed",
];

/// TS `GH_LOGIN_RE`·`GH_REPORT_LOGIN` — `^[A-Za-z0-9-]{1,39}$`.
fn is_gh_login(s: &str) -> bool {
    (1..=39).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// TS `GH_LINES_REQUEST_ID` — `^[A-Za-z0-9-]{1,64}$`.
fn is_request_id(s: &str) -> bool {
    (1..=64).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

fn not_found() -> Response {
    json_err(StatusCode::NOT_FOUND, "not_found", "agent not found")
}

fn bad(code: &str, msg: &str) -> Response {
    json_err(StatusCode::BAD_REQUEST, code, msg)
}

/// 사람 세션 + 그 에이전트의 소유자인가. 아니면 None(라우트가 404).
async fn owner_ok(
    pool: &sqlx::PgPool,
    auth: &Auth,
    agent_id: &str,
) -> Result<Option<(String, String)>, sqlx::Error> {
    let Some(acc) = auth.account.as_ref() else {
        return Ok(None);
    };
    if acc.kind != "human" || auth.via != Some(Via::Session) {
        return Ok(None);
    }
    let hit: Option<i32> = sqlx::query_scalar(
        "select 1 from agent_config where account_id = $1::uuid and owner_account_id = $2::uuid",
    )
    .bind(agent_id)
    .bind(&acc.id)
    .fetch_optional(pool)
    .await?;
    Ok(hit.map(|_| (acc.id.clone(), acc.handle.clone())))
}

/// 그 오퍼레이터(머신)의 주인이 요청한 사람인가 — 에이전트 소유자와 머신 주인이 다를 수 있다.
async fn operator_owner_ok(
    pool: &sqlx::PgPool,
    operator_id: &str,
    account_id: &str,
) -> Result<bool, sqlx::Error> {
    let hit: Option<i32> = sqlx::query_scalar(
        "select 1 from operator where id = $1::uuid and owner_account_id = $2::uuid and revoked_at is null",
    )
    .bind(operator_id)
    .bind(account_id)
    .fetch_optional(pool)
    .await?;
    Ok(hit.is_some())
}

/// TS `mergeAccountsOf` — `{ operatorId, report }` json. 보고가 없으면 report null.
async fn merge_accounts_of(pool: &sqlx::PgPool, agent_id: &str) -> Result<Value, sqlx::Error> {
    let row: Option<(String, Option<String>)> = sqlx::query_as(concat!(
        "select a.operator_id::text, case when r.reported_at is null then null else json_build_object(\
           'logins', coalesce(r.logins, '[]'::jsonb), \
           'byScope', coalesce(r.by_scope, '{}'::jsonb), \
           'defaultGhUser', r.default_gh_user, \
           'reach', coalesce(r.reach, '[]'::jsonb), \
           'reportedAt', ",
        crate::iso!("r.reported_at"),
        ")::text end \
           from agent_assignment a \
           join operator o on o.id = a.operator_id and o.revoked_at is null \
           left join operator_gh_report r on r.operator_id = a.operator_id \
          where a.agent_id = $1::uuid"
    ))
    .bind(agent_id)
    .fetch_optional(pool)
    .await?;
    Ok(match row {
        None => json!({ "operatorId": null, "report": null }),
        Some((op, report)) => {
            let report = report
                .and_then(|r| serde_json::from_str::<Value>(&r).ok())
                .unwrap_or(Value::Null);
            json!({ "operatorId": op, "report": report })
        }
    })
}

fn json_ok(v: &Value, no_store: bool) -> Response {
    let mut r = (
        [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
        v.to_string(),
    )
        .into_response();
    if no_store {
        r.headers_mut()
            .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    }
    r
}

/// `GET /agents/{id}/merge-accounts`.
pub async fn get_accounts(
    State(core): State<Arc<OperatorCore>>,
    Path(agent_id): Path<String>,
    req: Request,
) -> Response {
    let (parts, _) = req.into_parts();
    let auth = parts.extensions.get::<Auth>().cloned().unwrap_or_default();
    if !is_zod_uuid(&agent_id) {
        return bad("bad_request", "agent id must be a uuid");
    }
    let Some((me, _)) = db!(owner_ok(&core.pool, &auth, &agent_id).await) else {
        return not_found();
    };
    let mut accounts = db!(merge_accounts_of(&core.pool, &agent_id).await);
    // 그 머신의 로그인 이름(과 기본값)은 머신 주인에게만 보인다 — 줄(byScope)·닿음(reach)은 그대로.
    let op = accounts["operatorId"].as_str().map(str::to_owned);
    if let (Some(op), true) = (op, accounts["report"].is_object())
        && !db!(operator_owner_ok(&core.pool, &op, &me).await)
        && let Some(report) = accounts["report"].as_object_mut()
    {
        report.remove("logins");
        report.remove("defaultGhUser");
    }
    json_ok(&accounts, true)
}

enum Outcome {
    Ok(Option<String>),
    Refused(String),
    Unreachable,
}

/// 보낸 그 오퍼레이터의 `gh.lines.result`(같은 requestId)를 시한까지 기다린다.
async fn wait_result(
    mut frames: broadcast::Receiver<(String, super::operator_hub::Frame)>,
    operator_id: &str,
    request_id: &str,
    timeout: std::time::Duration,
) -> Outcome {
    let wait = async {
        loop {
            let (from, frame) = match frames.recv().await {
                Ok(f) => f,
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => return Outcome::Unreachable,
            };
            if from != operator_id
                || frame.get("type").and_then(Value::as_str) != Some("gh.lines.result")
            {
                continue;
            }
            let Some(rid) = frame.get("requestId").and_then(Value::as_str) else {
                continue;
            };
            if !is_request_id(rid) || rid != request_id {
                continue;
            }
            if frame.get("ok") == Some(&Value::Bool(true)) {
                let previous = frame
                    .get("previous")
                    .and_then(Value::as_str)
                    .filter(|p| is_gh_login(p))
                    .map(str::to_owned);
                return Outcome::Ok(previous);
            }
            let code = frame
                .get("code")
                .and_then(Value::as_str)
                .filter(|c| REFUSALS.contains(c))
                .unwrap_or("failed");
            return Outcome::Refused(code.to_owned());
        }
    };
    tokio::time::timeout(timeout, wait)
        .await
        .unwrap_or(Outcome::Unreachable)
}

/// `PUT /agents/{id}/merge-accounts/lines` — body `{ scope, ghUser | null }`.
pub async fn put_line(
    State(core): State<Arc<OperatorCore>>,
    Path(agent_id): Path<String>,
    req: Request,
) -> Response {
    let (parts, body) = req.into_parts();
    let auth = parts.extensions.get::<Auth>().cloned().unwrap_or_default();
    if !is_zod_uuid(&agent_id) {
        return bad("bad_request", "agent id must be a uuid");
    }
    let Some((me, me_handle)) = db!(owner_ok(&core.pool, &auth, &agent_id).await) else {
        return not_found();
    };
    let bytes = axum::body::to_bytes(body, 64 * 1024)
        .await
        .unwrap_or_default();
    let parsed: Value = if bytes.is_empty() {
        json!({})
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    let body_err = || bad("bad_request", "scope 와 ghUser(지우려면 null)가 필요하다");
    let Some(raw_scope) = parsed.get("scope").and_then(Value::as_str) else {
        return body_err();
    };
    if raw_scope.encode_utf16().count() > 220 {
        return body_err();
    }
    let gh_user: Option<String> = match parsed.get("ghUser") {
        Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        _ => return body_err(),
    };
    // 로컬 앱과 같은 범위 규칙 — 정확한 `owner/name` 또는 조직 전체 `owner/*`.
    let Some(scope) = super::mcp::grant_writes::repo_grant_scope(&raw_scope.trim().to_lowercase())
        .map(|s| s["repo:".len()..].to_owned())
    else {
        return bad("bad_scope", "scope 는 owner/name 이나 owner/* 여야 한다");
    };
    if let Some(u) = &gh_user
        && !is_gh_login(u)
    {
        return bad("bad_request", "ghUser 는 GitHub 로그인 이름이어야 한다");
    }

    // 그 에이전트가 **지금 배정된** 오퍼레이터(폐기되지 않은 것)에만 보낸다.
    let accounts = db!(merge_accounts_of(&core.pool, &agent_id).await);
    let Some(operator_id) = accounts["operatorId"].as_str().map(str::to_owned) else {
        return json_err(
            StatusCode::CONFLICT,
            "no_operator",
            "이 에이전트를 도는 오퍼레이터가 없다",
        );
    };
    if !db!(operator_owner_ok(&core.pool, &operator_id, &me).await) {
        return json_err(
            StatusCode::FORBIDDEN,
            "not_operator_owner",
            "그 오퍼레이터의 주인만 줄을 고칠 수 있다",
        );
    }
    if let Some(u) = &gh_user {
        let known = accounts["report"]["logins"]
            .as_array()
            .is_some_and(|ls| ls.iter().any(|l| l.as_str() == Some(u)));
        if !known {
            return json_err(
                StatusCode::CONFLICT,
                "unknown_login",
                "그 오퍼레이터가 알린 gh 로그인이 아니다",
            );
        }
    }

    let request_id: String = db!(sqlx::query_scalar("select gen_random_uuid()::text")
        .fetch_one(&core.pool)
        .await);
    // 보내기 전에 구독한다 — 답이 먼저 와도 놓치지 않는다.
    let frames = core.hub.subscribe_frames();
    let sent = core.hub.send(
        &operator_id,
        &json!({ "type": "gh.lines.set", "requestId": request_id, "scope": scope, "ghUser": gh_user }),
    );
    let outcome = if sent {
        wait_result(frames, &operator_id, &request_id, core.timing.gh_lines).await
    } else {
        Outcome::Unreachable
    };

    let mut detail = json!({
        "operatorId": operator_id, "agentId": agent_id, "scope": scope, "ghUser": gh_user, "by": me,
        "outcome": match &outcome { Outcome::Ok(_) => "ok", Outcome::Refused(c) => c.as_str(), Outcome::Unreachable => "operator_unreachable" },
    });
    if let Outcome::Ok(Some(prev)) = &outcome {
        detail["previous"] = json!(prev);
    }
    record_audit(
        &core.write,
        AuditEntry {
            action: "operator.merge_line.set_remote",
            actor_id: Some(&me),
            actor_handle: Some(&me_handle),
            target: Some(&operator_id),
            ip: ip_of(&parts, &core.trust).as_deref(),
            detail,
        },
    )
    .await;
    match outcome {
        Outcome::Unreachable => json_err(
            StatusCode::GATEWAY_TIMEOUT,
            "operator_unreachable",
            "오퍼레이터가 답하지 않았다",
        ),
        Outcome::Refused(code) => json_err(
            StatusCode::CONFLICT,
            &code,
            "오퍼레이터가 줄을 고치지 않았다",
        ),
        Outcome::Ok(_) => {
            // 저장된 보고에 바로 반영한다 — 오퍼레이터가 곧 다시 내는 보고가 이 값을 덮는다(그쪽이 참이다).
            db!(sqlx::query(
                "update operator_gh_report \
                    set by_scope = case when $3::text is null then coalesce(by_scope, '{}'::jsonb) - $2::text \
                                        else coalesce(by_scope, '{}'::jsonb) || jsonb_build_object($2::text, $3::text) end \
                  where operator_id = $1::uuid"
            )
            .bind(&operator_id)
            .bind(&scope)
            .bind(&gh_user)
            .execute(&core.write)
            .await);
            json_ok(&json!({ "ok": true }), false)
        }
    }
}
