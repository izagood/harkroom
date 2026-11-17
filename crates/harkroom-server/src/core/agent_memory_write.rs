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
//! - `POST …/background/runs/:runId/revert` 는 TS 에 남긴다 — 회차의 기억마다 보관·restore·되살리기를 고르고 스레드 메모까지
//!   다시 여는 여러 단계 쓰기라 따로 옮긴다.
use super::agent_memory_read::{access, agent_target, bad, max_param_length};
use super::mcp::mem_body::{
    MAX_CORE, MAX_DESCRIPTION, MAX_ITEMS, MAX_VALUE, SetOutcome, delete, js_len, upsert,
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

pub struct MemoryWriteState {
    pub read: PgPool,
    pub write: PgPool,
    pub trust: TrustProxy,
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

pub fn routes(
    st: MemoryWriteState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<MemoryWriteState>>::new()
        .delete("/accounts/agents/{id}/memory/{slug}", remove)
        .put("/accounts/agents/{id}/memory/{slug}", put)
        .post("/accounts/agents/{id}/memory/{slug}/confirm", confirm)
        .post("/accounts/agents/{id}/memory/archive", archive)
        .post("/accounts/agents/{id}/memory/unarchive", unarchive)
        .put("/accounts/agents/{id}/background", background)
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

    /// 문구·상한을 TS 원본과 맞춘다.
    #[test]
    fn texts_follow_ts_source() {
        let ts = include_str!("../../../../packages/server/src/routes/accountRoutes.ts");
        for want in [
            "return reply.code(422).send({ error: { code: 'core_too_long', message: `core 는 ${MAX_CORE_MEMORY_LENGTH}자까지다` } });",
            "return reply.code(422).send({ error: { code: 'too_many', message: `at most ${MAX_MEMORY_ITEMS_PER_ACCOUNT}` } });",
            "error: { code: 'conflict', updatedAt: result.conflict.updatedAt?.toISOString() ?? null },",
            "return reply.code(403).send({ error: { code: 'forbidden', message: 'only a human can confirm a flagged memory' } });",
            "return reply.code(404).send({ error: { code: 'not_flagged', message: 'memory is not flagged' } });",
            "slugs: z.array(z.string().min(1).max(255)).min(1).max(MAX_MEMORY_ITEMS_PER_ACCOUNT),",
            "action: 'agent.background.toggled', actorId: req.account!.id, actorHandle: req.account!.handle,",
            "return { ok: true, enabled };",
        ] {
            assert!(ts.contains(want), "{want}");
        }
    }
}
