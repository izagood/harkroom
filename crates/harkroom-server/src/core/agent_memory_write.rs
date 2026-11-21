//! S5.4 AC3 — 사람이 에이전트 기억을 고치는 다섯 줄과 백그라운드 켜고 끄기 한 줄. TS `routes/accountRoutes.ts` 의
//! `DELETE·PUT /accounts/agents/:id/memory/:slug`·`POST …/memory/:slug/confirm`·`POST …/memory/archive`·
//! `POST …/memory/unarchive`·`PUT /accounts/agents/:id/background` 를 옮긴다.
//!
//! - 판정 순서는 TS 와 같다: `requireOwnerOrAdmin('id')`(401·403·404) → (confirm 만) 사람인가(403) → 경로 zod(400) →
//!   본문 zod(400) → 에이전트인가(404 — PUT 둘은 지운 에이전트도 404, 나머지는 지운 에이전트도 대상) → (PUT) slug·core 길이(422).
//! - 쓰기는 MCP 와 **같은 함수**를 탄다 — `memory.set` 의 [`upsert`]·[`delete`](상한·판 비교·이전 판·journal 자르기),
//!   `memory.archive`·`unarchive` 의 [`archive_one`]·[`unarchive_one`]. 사람 경로라 턴·회차가 없고(`run_id`·`turn_id` null),
//!   쓰기 검사(`scanWrite`)도 하지 않는다 — TS 가 `setMemory` 에 `flagReason` 을 주지 않는 것과 같다(사람이 고친 판은 표시가 풀린다).
//! - 감사는 slug 만 남긴다(본문 없음).
//! - `POST …/background/runs/:runId/revert`(S5.5) 는 TS `revertBgRun` 을 옮긴 [`revert`] 다 — 쓰기 풀에
//!   [`BG_REVERT_PRIVILEGES`] 가 다 있을 때만 줄을 단다(없으면 TS).
use super::agent_memory_read::{access, agent_target, bad, max_param_length};
use super::mcp::mem_body::{
    MAX_CORE, MAX_DESCRIPTION, MAX_ITEMS, MAX_VALUE, Restored, SetOutcome, delete, js_len,
    restore_one, upsert,
};
use super::mcp::mem_writes::{
    Archived, SLUG_HINT, Unarchived, archive_one, datetime_ok, unarchive_one,
};
use super::mcp::reads2::valid_slug;
use super::relay_routes::{Verdict, check_owner_or_admin};
use crate::auth::{Account, RequireAccount};
use crate::directory::{internal, json_err, json_ok};
use crate::trust_proxy::TrustProxy;
use crate::write::{AuditEntry, Body, record_audit};
use crate::writes_settings::{body_then, ip_of};
use axum::extract::{Path, Request, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::sync::Arc;

/// 쓰기 풀에 [`super::mcp::mem_writes::MEMORY_WRITE_PRIVILEGES`]·[`super::mcp::mem_body::MEMORY_BODY_PRIVILEGES`] 위에 더 있어야 하는 것.
pub const AGENT_MEMORY_WRITE_PRIVILEGES: &[(&str, &str)] = &[
    ("account", "SELECT"),
    ("agent_memory", "SELECT"),
    ("agent_memory_revision", "SELECT"),
    ("agent_config", "SELECT"),
    ("agent_config", "INSERT"),
    ("agent_config.bg_enabled", "UPDATE"),
    ("audit_log", "INSERT"),
];

/// 회차 되돌리기([`revert`])가 [`AGENT_MEMORY_WRITE_PRIVILEGES`] 위에 더 쓰는 것.
pub const BG_REVERT_PRIVILEGES: &[(&str, &str)] = &[
    ("bg_job", "SELECT"),
    ("bg_job.reverted_at", "UPDATE"),
    ("bg_job.reverted_by", "UPDATE"),
    ("bg_job_change", "SELECT"),
    ("thread_note.account_id", "SELECT"),
    ("thread_note.archived_by_run", "SELECT"),
    ("thread_note.archived_at", "UPDATE"),
    ("thread_note.archived_by_run", "UPDATE"),
];

pub struct MemoryWriteState {
    pub read: PgPool,
    pub write: PgPool,
    pub trust: TrustProxy,
    /// 쓰기 풀에 [`BG_REVERT_PRIVILEGES`] 가 다 있는가 — 아니면 되돌리기 줄을 달지 않는다(→ TS).
    pub revert: bool,
}

/// 쓰기 함수들은 `me.id` 만 읽는다 — 사람이 남의(에이전트의) 기억을 고치므로 그 에이전트를 주인 자리에 둔다.
fn owner(id: &str) -> Account {
    Account {
        id: id.to_owned(),
        handle: String::new(),
        display_name: String::new(),
        kind: "agent".to_owned(),
        is_admin: false,
        role: String::new(),
        status: String::new(),
        status_text: None,
        avatar_attachment_id: None,
    }
}

fn unprocessable(code: &str, message: &str) -> Response {
    json_err(StatusCode::UNPROCESSABLE_ENTITY, code, message)
}

async fn audit(
    st: &MemoryWriteState,
    parts: &axum::http::request::Parts,
    me: &Account,
    action: &str,
    target: &str,
    detail: Value,
) {
    let ip = ip_of(parts, &st.trust);
    record_audit(
        &st.write,
        AuditEntry {
            action,
            actor_id: Some(&me.id),
            actor_handle: Some(&me.handle),
            target: Some(target),
            ip: ip.as_deref(),
            detail,
        },
    )
    .await;
}

/// `DELETE /accounts/agents/{id}/memory/{slug}` — 없는 것을 지워도 204(TS `deleteMemory` 의 멱등). slug 꼴은 보지 않는다(TS 와 같다).
pub async fn remove(
    State(st): State<Arc<MemoryWriteState>>,
    Path((id, slug)): Path<(String, String)>,
    req: Request,
) -> Response {
    let (_body, RequireAccount(me, _), parts) = match body_then::<RequireAccount>(req).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    if let Err(r) = access(&st.read, &me, &id, Some(&slug)).await {
        return r;
    }
    if let Err(r) = agent_target(&st.write, &id, false).await {
        return r;
    }
    if let Err(e) = delete(&st.write, &owner(&id), None, &slug, None).await {
        return internal(e);
    }
    audit(
        &st,
        &parts,
        &me,
        "agent.memory.deleted",
        &id,
        json!({ "slug": slug }),
    )
    .await;
    StatusCode::NO_CONTENT.into_response()
}

/// PUT 본문 — `{ value, description?, kind?, ifUpdatedAt? }`.
struct PutBody {
    value: String,
    description: Option<String>,
    kind: Option<String>,
    /// `None` = 없음, `Some(None)` = null(「없어야 한다」), `Some(Some(at))` = 그 판.
    expect: Option<Option<String>>,
}

#[allow(clippy::option_option)]
fn parse_put(body: &Body) -> Option<PutBody> {
    let Body::Json(Value::Object(m)) = body else {
        return None;
    };
    let value = match m.get("value") {
        Some(Value::String(v)) if (1..=MAX_VALUE).contains(&js_len(v)) => v.clone(),
        _ => return None,
    };
    let description = match m.get("description") {
        None => None,
        Some(Value::String(d)) if js_len(d) <= MAX_DESCRIPTION => Some(d.clone()),
        Some(_) => return None,
    };
    let kind = match m.get("kind") {
        None => None,
        Some(Value::String(k)) if matches!(k.as_str(), "topic" | "procedure" | "journal") => {
            Some(k.clone())
        }
        Some(_) => return None,
    };
    let expect = match m.get("ifUpdatedAt") {
        None => None,
        Some(Value::Null) => Some(None),
        Some(Value::String(s)) if datetime_ok(s) => Some(Some(s.clone())),
        Some(_) => return None,
    };
    Some(PutBody {
        value,
        description,
        kind,
        expect,
    })
}

/// `PUT /accounts/agents/{id}/memory/{slug}` — 사람이 기억을 고친다(MCP `memory.set` 과 같은 쓰기).
pub async fn put(
    State(st): State<Arc<MemoryWriteState>>,
    Path((id, slug)): Path<(String, String)>,
    req: Request,
) -> Response {
    let (body, RequireAccount(me, _), parts) = match body_then::<RequireAccount>(req).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    if let Err(r) = access(&st.read, &me, &id, Some(&slug)).await {
        return r;
    }
    let Some(b) = parse_put(&body) else {
        return bad("body");
    };
    if let Err(r) = agent_target(&st.write, &id, true).await {
        return r;
    }
    if !valid_slug(&slug) {
        return unprocessable("invalid_slug", SLUG_HINT);
    }
    if slug == "core" && js_len(&b.value) > MAX_CORE {
        return unprocessable("core_too_long", &format!("core 는 {MAX_CORE}자까지다"));
    }
    let expect = b.expect.as_ref().map(|e| e.as_deref());
    let r = upsert(
        &st.write,
        &owner(&id),
        None,
        &slug,
        &b.value,
        b.description.as_deref(),
        b.kind.as_deref(),
        expect,
        None,
    )
    .await;
    match r {
        Ok(SetOutcome::Ok) => {}
        Ok(SetOutcome::Conflict(now)) => {
            return (
                StatusCode::CONFLICT,
                [(
                    axum::http::header::CONTENT_TYPE,
                    "application/json; charset=utf-8",
                )],
                json!({ "error": { "code": "conflict", "updatedAt": now } }).to_string(),
            )
                .into_response();
        }
        Ok(SetOutcome::TooMany) => {
            return unprocessable("too_many", &format!("at most {MAX_ITEMS}"));
        }
        Err(e) => return internal(e),
    }
    audit(
        &st,
        &parts,
        &me,
        "agent.memory.edited",
        &id,
        json!({ "slug": slug }),
    )
    .await;
    json_ok("{\"ok\":true}".to_owned())
}

/// `POST /accounts/agents/{id}/memory/{slug}/confirm` — 쓰기 검사에 걸린 판을 **사람이** 확인한다.
pub async fn confirm(
    State(st): State<Arc<MemoryWriteState>>,
    Path((id, slug)): Path<(String, String)>,
    req: Request,
) -> Response {
    let (_body, RequireAccount(me, _), parts) = match body_then::<RequireAccount>(req).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    // 소유자·admin 판정(preHandler)이 먼저, 그다음 사람인가, 그다음 경로 — TS 와 같은 차례.
    match check_owner_or_admin(&st.read, &me, &id).await {
        Ok(Verdict::Owner | Verdict::Admin) => {}
        Ok(Verdict::Refused(s, c, m)) => return json_err(s, c, m),
        Err(e) => return internal(e),
    }
    if me.kind != "human" {
        return json_err(
            StatusCode::FORBIDDEN,
            "forbidden",
            "only a human can confirm a flagged memory",
        );
    }
    if let Err(r) = access(&st.read, &me, &id, Some(&slug)).await {
        return r;
    }
    if let Err(r) = agent_target(&st.write, &id, false).await {
        return r;
    }
    let n = sqlx::query(
        "update agent_memory set flagged_at = null, flag_reason = null \
         where account_id = $1::uuid and slug = $2 and flagged_at is not null",
    )
    .bind(&id)
    .bind(&slug)
    .execute(&st.write)
    .await;
    match n {
        Ok(r) if r.rows_affected() > 0 => {}
        Ok(_) => {
            return json_err(
                StatusCode::NOT_FOUND,
                "not_flagged",
                "memory is not flagged",
            );
        }
        Err(e) => return internal(e),
    }
    audit(
        &st,
        &parts,
        &me,
        "agent.memory.flag_cleared",
        &id,
        json!({ "slug": slug }),
    )
    .await;
    json_ok("{\"ok\":true}".to_owned())
}

/// `{ slugs: z.array(z.string().min(1).max(255)).min(1).max(200) }` → 처음 나온 차례대로 겹침을 뺀 목록(`new Set`).
fn parse_slugs(body: &Body) -> Option<Vec<String>> {
    let Body::Json(Value::Object(m)) = body else {
        return None;
    };
    let Some(Value::Array(a)) = m.get("slugs") else {
        return None;
    };
    if a.is_empty() || a.len() > MAX_ITEMS as usize {
        return None;
    }
    let mut out: Vec<String> = Vec::with_capacity(a.len());
    for v in a {
        let Value::String(s) = v else { return None };
        if !(1..=255).contains(&js_len(s)) {
            return None;
        }
        if !out.contains(s) {
            out.push(s.clone());
        }
    }
    Some(out)
}

#[derive(Clone, Copy)]
enum Batch {
    Archive,
    Unarchive,
}

async fn batch(st: &MemoryWriteState, id: &str, req: Request, which: Batch) -> Response {
    let (body, RequireAccount(me, _), parts) = match body_then::<RequireAccount>(req).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    if let Err(r) = access(&st.read, &me, id, None).await {
        return r;
    }
    let Some(slugs) = parse_slugs(&body) else {
        return bad("body");
    };
    if let Err(r) = agent_target(&st.write, id, false).await {
        return r;
    }
    let mut results: Vec<Value> = Vec::with_capacity(slugs.len());
    let mut done: Vec<&str> = vec![];
    for slug in &slugs {
        let result = if !valid_slug(slug) {
            "invalid_slug"
        } else {
            match which {
                // core 는 매 턴 실리는 자리라 보관하지 않는다 — memory.archive 와 같은 규칙.
                Batch::Archive if slug == "core" => "core_not_archivable",
                Batch::Archive => match archive_one(&st.write, id, slug, None).await {
                    Ok(Archived::NotFound) => "not_found",
                    // expect 를 주지 않으므로 conflict 는 오지 않는다.
                    Ok(Archived::Ok | Archived::Conflict(_)) => "ok",
                    Err(e) => return internal(e),
                },
                Batch::Unarchive => match unarchive_one(&st.write, id, slug).await {
                    Ok(Unarchived::Ok) => "ok",
                    Ok(Unarchived::NotFound) => "not_found",
                    Ok(Unarchived::TooMany) => "too_many",
                    Err(e) => return internal(e),
                },
            }
        };
        if result == "ok" {
            done.push(slug);
        }
        results.push(json!({ "slug": slug, "result": result }));
    }
    if !done.is_empty() {
        let action = match which {
            Batch::Archive => "agent.memory.archived",
            Batch::Unarchive => "agent.memory.unarchived",
        };
        audit(st, &parts, &me, action, id, json!({ "slugs": done })).await;
    }
    json_ok(json!({ "results": results }).to_string())
}

/// `POST /accounts/agents/{id}/memory/archive`.
pub async fn archive(
    State(st): State<Arc<MemoryWriteState>>,
    Path(id): Path<String>,
    req: Request,
) -> Response {
    batch(&st, &id, req, Batch::Archive).await
}

/// `POST /accounts/agents/{id}/memory/unarchive`.
pub async fn unarchive(
    State(st): State<Arc<MemoryWriteState>>,
    Path(id): Path<String>,
    req: Request,
) -> Response {
    batch(&st, &id, req, Batch::Unarchive).await
}

/// `PUT /accounts/agents/{id}/background` — `{ enabled }`. 행이 없어도 실제로 저장한다(TS `setBgEnabled`, security n1).
pub async fn background(
    State(st): State<Arc<MemoryWriteState>>,
    Path(id): Path<String>,
    req: Request,
) -> Response {
    let (body, RequireAccount(me, _), parts) = match body_then::<RequireAccount>(req).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    if let Err(r) = access(&st.read, &me, &id, None).await {
        return r;
    }
    let enabled = match &body {
        Body::Json(Value::Object(m)) => match m.get("enabled") {
            Some(Value::Bool(b)) => *b,
            _ => return bad("body"),
        },
        _ => return bad("body"),
    };
    if let Err(r) = agent_target(&st.write, &id, true).await {
        return r;
    }
    if let Err(e) = sqlx::query(
        "insert into agent_config (account_id, bg_enabled) values ($1::uuid, $2) \
         on conflict (account_id) do update set bg_enabled = excluded.bg_enabled",
    )
    .bind(&id)
    .bind(enabled)
    .execute(&st.write)
    .await
    {
        return internal(e);
    }
    audit(
        &st,
        &parts,
        &me,
        "agent.background.toggled",
        &id,
        json!({ "enabled": enabled }),
    )
    .await;
    json_ok(json!({ "ok": true, "enabled": enabled }).to_string())
}

/// TS `revertBgRun` 의 결말.
enum Reverted {
    Done {
        reverted: Vec<String>,
        skipped: Vec<(String, &'static str)>,
        notes: u64,
    },
    NotFound,
    Already,
    NotFinished,
}

/// 한 기억 되돌리기 — `Ok(None)` 이면 되돌렸고, `Ok(Some(reason))` 이면 건너뛴다.
async fn revert_slug(
    write: &PgPool,
    id: &str,
    run_id: &str,
    slug: &str,
    first_op: &str,
    after: Option<&str>,
) -> Result<Option<&'static str>, sqlx::Error> {
    // TS `sameMs` — 지금 판이 회차 직후 판과 (ms 까지) 같을 때만 되돌린다. 직후 판이 없으면(null) 다르다.
    let cur: Option<(String, bool)> = sqlx::query_as(
        "select updated_at::text, coalesce(date_trunc('milliseconds', updated_at) = \
         date_trunc('milliseconds', $3::timestamptz), false) \
         from agent_memory where account_id = $1::uuid and slug = $2",
    )
    .bind(id)
    .bind(slug)
    .bind(after)
    .fetch_optional(write)
    .await?;
    let Some((updated, same)) = cur else {
        return Ok(Some("gone"));
    };
    if !same {
        return Ok(Some("changed_since"));
    }
    let first: Option<(i64, Option<String>, bool)> = sqlx::query_as(
        "select id, reason, coalesce((detail->>'created')::boolean, false) \
         from agent_memory_revision where account_id = $1::uuid and slug = $2 and run_id = $3::uuid \
         order by replaced_at, id limit 1",
    )
    .bind(id)
    .bind(slug)
    .bind(run_id)
    .fetch_optional(write)
    .await?;
    let created = first_op == "create"
        || first
            .as_ref()
            .is_some_and(|(_, reason, created)| reason.as_deref() == Some("merge") && *created);
    // 회차가 만든 것은 보관, 고친 것은 그 회차가 밀어낸 가장 이른 판으로 restore, 보관만 한 것은 되살린다.
    let (ok, too_many) = if created {
        let r = archive_one(write, id, slug, Some(Some(&updated))).await?;
        (matches!(r, Archived::Ok), false)
    } else if let Some((rev, _, _)) = first {
        match restore_one(write, &owner(id), slug, Some(rev), None).await? {
            Restored::Ok => (true, false),
            Restored::TooMany => (false, true),
            Restored::NotFound => (false, false),
        }
    } else {
        match unarchive_one(write, id, slug).await? {
            Unarchived::Ok => (true, false),
            Unarchived::TooMany => (false, true),
            Unarchived::NotFound => (false, false),
        }
    };
    Ok(if ok {
        None
    } else if too_many {
        Some("too_many")
    } else {
        Some("changed_since")
    })
}

/// TS `revertBgRun` — 회차는 한 번만 되돌린다(먼저 `reverted_at` 을 찍어 잡는다). 대상은 `run_id`·`bg_job_change` 로만 고른다.
async fn revert_run(
    write: &PgPool,
    id: &str,
    run_id: &str,
    actor: &str,
) -> Result<Reverted, sqlx::Error> {
    let claim = sqlx::query(
        "update bg_job set reverted_at = now(), reverted_by = $3::uuid \
         where id = $1::uuid and account_id = $2::uuid and reverted_at is null \
           and status in ('done', 'failed', 'skipped')",
    )
    .bind(run_id)
    .bind(id)
    .bind(actor)
    .execute(write)
    .await?;
    if claim.rows_affected() == 0 {
        let r: Option<bool> = sqlx::query_scalar(
            "select reverted_at is not null from bg_job where id = $1::uuid and account_id = $2::uuid",
        )
        .bind(run_id)
        .bind(id)
        .fetch_optional(write)
        .await?;
        return Ok(match r {
            None => Reverted::NotFound,
            Some(true) => Reverted::Already,
            Some(false) => Reverted::NotFinished,
        });
    }
    let changes: Vec<(String, String, Option<String>)> = sqlx::query_as(
        "select slug, op, after_updated_at::text from bg_job_change where run_id = $1::uuid order by id",
    )
    .bind(run_id)
    .fetch_all(write)
    .await?;
    // JS `Map` — 처음 나온 차례, 값은 마지막 것(직후 판)·첫 op.
    let mut order: Vec<(String, String, Option<String>)> = Vec::new();
    for (slug, op, after) in changes {
        match order.iter_mut().find(|e| e.0 == slug) {
            Some(e) => e.2 = after,
            None => order.push((slug, op, after)),
        }
    }
    let mut reverted = Vec::new();
    let mut skipped = Vec::new();
    for (slug, first_op, after) in order {
        // 한 기억의 실패가 나머지를 막지 않는다(TS security n2) — 회차는 이미 「되돌림」으로 찍혔다.
        match revert_slug(write, id, run_id, &slug, &first_op, after.as_deref()).await {
            Ok(None) => reverted.push(slug),
            Ok(Some(reason)) => skipped.push((slug, reason)),
            Err(_) => {
                eprintln!("bg revert error: one memory skipped");
                skipped.push((slug, "error"));
            }
        }
    }
    let notes = sqlx::query(
        "update thread_note set archived_at = null, archived_by_run = null \
         where account_id = $1::uuid and archived_by_run = $2::uuid",
    )
    .bind(id)
    .bind(run_id)
    .execute(write)
    .await?;
    Ok(Reverted::Done {
        reverted,
        skipped,
        notes: notes.rows_affected(),
    })
}

/// `POST /accounts/agents/{id}/background/runs/{runId}/revert` — [이 회차 되돌리기]. 판정 차례는 TS 와 같다:
/// 소유자·admin → 경로 uuid(400) → 살아 있는 에이전트(404) → 되돌리기(404·409) → 감사.
pub async fn revert(
    State(st): State<Arc<MemoryWriteState>>,
    Path((id, run_id)): Path<(String, String)>,
    req: Request,
) -> Response {
    let (_body, RequireAccount(me, _), parts) = match body_then::<RequireAccount>(req).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    if let Err(r) = access(&st.read, &me, &id, None).await {
        return r;
    }
    if !crate::lists::is_zod_uuid(&run_id) {
        return bad("params");
    }
    if let Err(r) = agent_target(&st.write, &id, true).await {
        return r;
    }
    let (reverted, skipped, notes) = match revert_run(&st.write, &id, &run_id, &me.id).await {
        Ok(Reverted::Done {
            reverted,
            skipped,
            notes,
        }) => (reverted, skipped, notes),
        Ok(Reverted::NotFound) => {
            return json_err(StatusCode::NOT_FOUND, "not_found", "no such run");
        }
        Ok(Reverted::Already) => {
            return json_err(
                StatusCode::CONFLICT,
                "already_reverted",
                "이미 되돌린 회차다",
            );
        }
        Ok(Reverted::NotFinished) => {
            return json_err(StatusCode::CONFLICT, "not_finished", "아직 도는 회차다");
        }
        Err(e) => return internal(e),
    };
    let skipped_slugs: Vec<&str> = skipped.iter().map(|(s, _)| s.as_str()).collect();
    audit(
        &st,
        &parts,
        &me,
        "agent.background.reverted",
        &id,
        json!({ "runId": run_id, "reverted": reverted, "skipped": skipped_slugs }),
    )
    .await;
    let skipped: Vec<Value> = skipped
        .iter()
        .map(|(s, r)| json!({ "slug": s, "reason": r }))
        .collect();
    json_ok(json!({ "reverted": reverted, "skipped": skipped, "notesReopened": notes }).to_string())
}

pub fn routes(
    st: MemoryWriteState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let revert_on = st.revert;
    let t = Table::<Arc<MemoryWriteState>>::new()
        .delete("/accounts/agents/{id}/memory/{slug}", remove)
        .put("/accounts/agents/{id}/memory/{slug}", put)
        .post("/accounts/agents/{id}/memory/{slug}/confirm", confirm)
        .post("/accounts/agents/{id}/memory/archive", archive)
        .post("/accounts/agents/{id}/memory/unarchive", unarchive)
        .put("/accounts/agents/{id}/background", background);
    let t = if revert_on {
        t.post(
            "/accounts/agents/{id}/background/runs/{runId}/revert",
            revert,
        )
    } else {
        t
    };
    let t = t
        .map(|r| {
            r.route_layer(axum::middleware::from_fn_with_state(
                auth,
                crate::auth::layer,
            ))
            .route_layer(axum::middleware::from_fn(max_param_length))
            .layer(axum::middleware::from_fn_with_state(
                cors,
                crate::cors::layer,
            ))
        })
        .finish();
    crate::route_table::Routes {
        router: t.router.with_state(Arc::new(st)),
        http: t.http,
        sockets: t.sockets,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn j(v: Value) -> Body {
        Body::Json(v)
    }

    #[test]
    fn put_body_follows_zod() {
        assert!(parse_put(&j(json!({ "value": "x" }))).is_some());
        assert!(parse_put(&j(json!({ "value": "" }))).is_none());
        assert!(parse_put(&j(json!({ "value": "x".repeat(8001) }))).is_none());
        assert!(parse_put(&j(json!({ "value": "x", "description": null }))).is_none());
        assert!(parse_put(&j(json!({ "value": "x", "kind": "note" }))).is_none());
        let b = parse_put(&j(json!({ "value": "x", "ifUpdatedAt": null }))).unwrap();
        assert_eq!(b.expect, Some(None));
        assert!(parse_put(&j(json!({ "value": "x", "ifUpdatedAt": "2026-11-18" }))).is_none());
        assert!(parse_put(&Body::None).is_none());
        assert!(parse_put(&Body::Text("x".into())).is_none());
    }

    #[test]
    fn slugs_dedupe_in_order() {
        let s = parse_slugs(&j(json!({ "slugs": ["mem/b", "mem/a", "mem/b"] }))).unwrap();
        assert_eq!(s, vec!["mem/b", "mem/a"]);
        assert!(parse_slugs(&j(json!({ "slugs": [] }))).is_none());
        assert!(parse_slugs(&j(json!({ "slugs": [""] }))).is_none());
        assert!(parse_slugs(&j(json!({ "slugs": [1] }))).is_none());
    }
}
