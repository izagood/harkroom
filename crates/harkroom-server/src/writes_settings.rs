//! 가벼운 쓰기①(S5.2 P4a) — 설정 PUT 둘과 스킬 승인·비활성·사용 기록.
//!
//! TS 짝: `routes/settingsRoutes.ts`(PUT agent-defaults·mention-policy) · `routes/skillRoutes.ts`(POST usage·approve, DELETE).
//! 순서는 TS 와 같다: fastify 본문 읽기 → preHandler(인증·권한) → zod. 거절은 상태·코드가 같아야 하고(문구는 zod 와 다르다),
//! 성공은 본문까지 같아야 한다(`test/rustFrontDb.test.ts`).
use crate::auth::{RequireAccount, RequireAdmin};
use crate::directory::{internal, json_err, json_ok};
use crate::routes::AppState;
use crate::trust_proxy::TrustProxy;
use crate::write::{AuditEntry, Body, read_body, record_audit};
use axum::extract::{FromRequestParts, Path, Request, State};
use axum::http::StatusCode;
use axum::response::Response;
use serde_json::{Value, json};
use sqlx::PgPool;

/// shared `RUNNABLE_HARNESSES`.
const RUNNABLE_HARNESSES: &[&str] = &["claude-code", "codex", "opencode", "kilo", "pi", "omp"];
const EFFORTS: &[&str] = &["low", "medium", "high", "xhigh", "max"];
/// shared `MENTION_CHAIN_LIMIT_MIN`·`MAX`.
const CHAIN_LIMIT_MIN: f64 = 1.0;
const CHAIN_LIMIT_MAX: f64 = 200.0;
/// services/skills.ts `SKILL_USE_MAX_SLUGS`.
const SKILL_USE_MAX_SLUGS: usize = 20;
/// services/skills.ts `BUILTIN_SKILL_PREFIX`.
const BUILTIN_SKILL_PREFIX: &str = "harkroom-";

fn bad(msg: &str) -> Response {
    json_err(StatusCode::BAD_REQUEST, "invalid_request", msg)
}

/// zod `.max(n)` 은 UTF-16 단위로 센다.
fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// 쓰기 풀 — 마운트 조건이라 늘 있다.
#[allow(clippy::result_large_err)] // 거절이 곧 axum 응답이다(CI clippy 1.99).
fn write_pool(st: &AppState) -> Result<&PgPool, Response> {
    st.write.as_ref().ok_or_else(|| {
        json_err(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            "internal error",
        )
    })
}

/// 본문을 읽고(fastify) 추출기 하나를 돌린다(preHandler).
#[allow(clippy::result_large_err)] // 거절이 곧 axum 응답이다(CI clippy 1.99).
async fn body_then<T: FromRequestParts<()>>(
    req: Request,
) -> Result<(Body, T, axum::http::request::Parts), Response>
where
    T::Rejection: Into<Response>,
{
    let (mut parts, body) = req.into_parts();
    let body = read_body(&parts.headers, body).await?;
    let t = T::from_request_parts(&mut parts, &())
        .await
        .map_err(Into::into)?;
    Ok((body, t, parts))
}

/// 감사의 ip 칸 — TS 의 fastify `req.ip` 와 같은 규칙(env `TRUST_PROXY`, `trust_proxy.rs`).
fn ip_of(parts: &axum::http::request::Parts, trust: &TrustProxy) -> Option<String> {
    crate::trust_proxy::request_ip(parts, trust)
}

// ── 설정 ──────────────────────────────────────────────────────────────

/// 바꾸는 칸 — `None` 은 손대지 않음, `Some(None)` 은 null 로 지우기.
#[derive(Debug, Default, PartialEq)]
pub struct DefaultsPatch {
    pub harness: Option<String>,
    pub model: Option<Option<String>>,
    pub effort: Option<Option<String>>,
}

/// zod `{ harness: enum.optional(), model: string.max(64).nullable().optional(), effort: enum.nullable().optional() }`.
/// 모르는 키는 버린다(strict 아님). `undefined` 와 키 없음은 같다 — JSON 에는 `undefined` 가 없다.
pub fn parse_defaults(body: &Body) -> Result<DefaultsPatch, &'static str> {
    let Body::Json(Value::Object(o)) = body else {
        return Err("expected object");
    };
    let mut p = DefaultsPatch::default();
    match o.get("harness") {
        None => {}
        Some(Value::String(h)) if RUNNABLE_HARNESSES.contains(&h.as_str()) => {
            p.harness = Some(h.clone())
        }
        Some(_) => return Err("harness"),
    }
    match o.get("model") {
        None => {}
        Some(Value::Null) => p.model = Some(None),
        Some(Value::String(m)) if js_len(m) <= 64 => p.model = Some(Some(m.clone())),
        Some(_) => return Err("model"),
    }
    match o.get("effort") {
        None => {}
        Some(Value::Null) => p.effort = Some(None),
        Some(Value::String(e)) if EFFORTS.contains(&e.as_str()) => p.effort = Some(Some(e.clone())),
        Some(_) => return Err("effort"),
    }
    Ok(p)
}

macro_rules! defaults_json {
    () => {
        "json_build_object('harness', harness, 'model', model, 'effort', effort)::text"
    };
}
const DEFAULTS_BEFORE: &str = concat!(
    "select ",
    defaults_json!(),
    " from agent_defaults where id = true"
);
const DEFAULTS_UPDATE: &str = concat!(
    "update agent_defaults set \
       harness = case when $1::bool then $2::text else harness end, \
       model   = case when $3::bool then $4::text else model   end, \
       effort  = case when $5::bool then $6::text else effort  end \
     where id = true returning ",
    defaults_json!()
);

/// `PUT /settings/agent-defaults` — admin. 감사 `agent.defaults.updated` {before, after}.
pub async fn put_agent_defaults(State(st): State<AppState>, req: Request) -> Response {
    let (body, RequireAdmin(me), parts) = match body_then::<RequireAdmin>(req).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    let patch = match parse_defaults(&body) {
        Ok(p) => p,
        Err(f) => return bad(f),
    };
    let pool = match write_pool(&st) {
        Ok(p) => p,
        Err(r) => return r,
    };
    let before: Result<String, _> = sqlx::query_scalar(DEFAULTS_BEFORE).fetch_one(pool).await;
    let before = match before {
        Ok(b) => b,
        Err(e) => return internal(e),
    };
    let after: Result<String, _> = sqlx::query_scalar(DEFAULTS_UPDATE)
        .bind(patch.harness.is_some())
        .bind(patch.harness.clone())
        .bind(patch.model.is_some())
        .bind(patch.model.clone().flatten())
        .bind(patch.effort.is_some())
        .bind(patch.effort.clone().flatten())
        .fetch_one(pool)
        .await;
    let after = match after {
        Ok(a) => a,
        Err(e) => return internal(e),
    };
    audit_change(
        pool,
        &st.trust,
        "agent.defaults.updated",
        &me,
        &parts,
        &before,
        &after,
    )
    .await;
    json_ok(after)
}

/// zod `{ chainLimit: number.int().min(1).max(200) }`.
pub fn parse_chain_limit(body: &Body) -> Result<i32, &'static str> {
    let Body::Json(Value::Object(o)) = body else {
        return Err("expected object");
    };
    let n = o
        .get("chainLimit")
        .and_then(Value::as_f64)
        .ok_or("chainLimit")?;
    if !n.is_finite() || n.fract() != 0.0 || !(CHAIN_LIMIT_MIN..=CHAIN_LIMIT_MAX).contains(&n) {
        return Err("chainLimit");
    }
    Ok(n as i32)
}

/// `PUT /settings/mention-policy` — admin. 감사 `mention.policy.updated` {before, after}.
pub async fn put_mention_policy(State(st): State<AppState>, req: Request) -> Response {
    let (body, RequireAdmin(me), parts) = match body_then::<RequireAdmin>(req).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    let limit = match parse_chain_limit(&body) {
        Ok(n) => n,
        Err(f) => return bad(f),
    };
    let pool = match write_pool(&st) {
        Ok(p) => p,
        Err(r) => return r,
    };
    // 행이 없으면 shared `MENTION_CHAIN_LIMIT`(8) — `getMentionPolicy`.
    let before: Result<String, _> = sqlx::query_scalar(
        "select json_build_object('chainLimit', coalesce((select chain_limit from mention_policy where id = true), 8))::text",
    )
    .fetch_one(pool)
    .await;
    let before = match before {
        Ok(b) => b,
        Err(e) => return internal(e),
    };
    let after: Result<String, _> = sqlx::query_scalar(
        "insert into mention_policy (id, chain_limit) values (true, $1) \
           on conflict (id) do update set chain_limit = excluded.chain_limit \
         returning json_build_object('chainLimit', chain_limit)::text",
    )
    .bind(limit)
    .fetch_one(pool)
    .await;
    let after = match after {
        Ok(a) => a,
        Err(e) => return internal(e),
    };
    audit_change(
        pool,
        &st.trust,
        "mention.policy.updated",
        &me,
        &parts,
        &before,
        &after,
    )
    .await;
    json_ok(after)
}

async fn audit_change(
    pool: &PgPool,
    trust: &TrustProxy,
    action: &str,
    me: &crate::auth::Account,
    parts: &axum::http::request::Parts,
    before: &str,
    after: &str,
) {
    let parse = |s: &str| serde_json::from_str::<Value>(s).unwrap_or(Value::Null);
    let ip = ip_of(parts, trust);
    record_audit(
        pool,
        AuditEntry {
            action,
            actor_id: Some(&me.id),
            actor_handle: Some(&me.handle),
            target: None,
            ip: ip.as_deref(),
            detail: json!({ "before": parse(before), "after": parse(after) }),
        },
    )
    .await;
}

// ── 스킬 ──────────────────────────────────────────────────────────────

/// `RETURNING` 과 같은 칸(lists.rs `skill_cols!` 와 같은 꼴 — ISO 밀리초 UTC).
macro_rules! skill_row {
    () => {
        concat!(
            "s.slug, s.body, s.proposed_by as \"proposedBy\", ",
            crate::iso!("s.proposed_at"),
            " as \"proposedAt\", s.approved_by as \"approvedBy\", ",
            crate::iso!("s.approved_at"),
            " as \"approvedAt\", ",
            crate::iso!("s.disabled_at"),
            " as \"disabledAt\", ",
            crate::iso!("s.flagged_at"),
            " as \"flaggedAt\", s.flag_reason as \"flagReason\""
        )
    };
}

/// TS `approveSkill` — 아직 승인 안 된 것만.
const APPROVE_SQL: &str = concat!(
    "with u as (update workspace_skill set approved_by = $2::uuid, approved_at = now() \
       where slug = $1 and approved_at is null returning *) \
     select row_to_json(x)::text from (select ",
    skill_row!(),
    " from u s) x"
);
/// TS `disableSkill` — 아직 비활성 아닌 것만.
const DISABLE_SQL: &str = concat!(
    "with u as (update workspace_skill set disabled_at = now() \
       where slug = $1 and disabled_at is null returning *) \
     select row_to_json(x)::text from (select ",
    skill_row!(),
    " from u s) x"
);

#[derive(Clone, Copy)]
enum SkillOp {
    Approve,
    Disable,
}

/// `POST /skills/{slug}/approve` — `agent.privileged`. 이미 승인됐으면 409.
pub async fn approve_skill(
    State(st): State<AppState>,
    Path(slug): Path<String>,
    req: Request,
) -> Response {
    skill_op(st, slug, req, SkillOp::Approve).await
}

/// `DELETE /skills/{slug}` — `agent.privileged`. 이미 비활성이면 409.
pub async fn disable_skill(
    State(st): State<AppState>,
    Path(slug): Path<String>,
    req: Request,
) -> Response {
    skill_op(st, slug, req, SkillOp::Disable).await
}

async fn skill_op(st: AppState, slug: String, req: Request, op: SkillOp) -> Response {
    let (_, RequireAccount(_, auth), _) = match body_then::<RequireAccount>(req).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    let me = match crate::perm::require_cap(&st.pool, &auth, "agent.privileged", None).await {
        Ok(a) => a,
        Err(r) => return r,
    };
    let pool = match write_pool(&st) {
        Ok(p) => p,
        Err(r) => return r,
    };
    match run_skill_op(pool, &slug, &me.id, op).await {
        Ok(Ok(row)) => json_ok(row),
        Ok(Err((status, code, msg))) => json_err(status, code, msg),
        Err(e) => internal(e),
    }
}

type SkillReject = (StatusCode, &'static str, &'static str);

/// TS `approveSkill`·`disableSkill` + `emitEvent({ type: 'skill.approved' | 'skill.disabled', skill })` — 같은 트랜잭션.
async fn run_skill_op(
    pool: &PgPool,
    slug: &str,
    actor: &str,
    op: SkillOp,
) -> Result<Result<String, SkillReject>, sqlx::Error> {
    let (sql, ty, already) = match op {
        SkillOp::Approve => (
            APPROVE_SQL,
            "skill.approved",
            ("already_approved", "skill already approved"),
        ),
        SkillOp::Disable => (
            DISABLE_SQL,
            "skill.disabled",
            ("already_disabled", "skill already disabled"),
        ),
    };
    let mut tx = pool.begin().await?;
    let q = sqlx::query_scalar::<_, String>(sql).bind(slug);
    let q = match op {
        SkillOp::Approve => q.bind(actor),
        SkillOp::Disable => q,
    };
    let row: Option<String> = q.fetch_optional(&mut *tx).await?;
    let Some(row) = row else {
        tx.rollback().await?;
        let exists: Option<i32> =
            sqlx::query_scalar("select 1 from workspace_skill where slug = $1")
                .bind(slug)
                .fetch_optional(pool)
                .await?;
        return Ok(Err(match exists {
            None => (StatusCode::NOT_FOUND, "not_found", "skill not found"),
            Some(_) => (StatusCode::CONFLICT, already.0, already.1),
        }));
    };
    let skill: Value = serde_json::from_str(&row).unwrap_or(Value::Null);
    crate::write::emit_event(&mut tx, &json!({ "type": ty, "skill": skill })).await?;
    tx.commit().await?;
    Ok(Ok(row))
}

/// zod strict `{ slugs: string.max(200)[] .max(100) }` → 거른 slug(유효·중복 없음·앞 20개).
pub fn parse_usage(body: &Body) -> Result<Vec<String>, &'static str> {
    let Body::Json(Value::Object(o)) = body else {
        return Err("expected object");
    };
    if o.keys().any(|k| k != "slugs") {
        return Err("unrecognized key");
    }
    let Some(Value::Array(a)) = o.get("slugs") else {
        return Err("slugs");
    };
    if a.len() > SKILL_USE_MAX_SLUGS * 5 {
        return Err("slugs");
    }
    let mut out: Vec<String> = vec![];
    for v in a {
        let Value::String(s) = v else {
            return Err("slugs");
        };
        if js_len(s) > 200 {
            return Err("slugs");
        }
        if is_valid_skill_slug(s) && !out.contains(s) {
            out.push(s.clone());
        }
    }
    out.truncate(SKILL_USE_MAX_SLUGS);
    Ok(out)
}

/// services/skills.ts `SKILL_SLUG_REGEX` = `^[a-z0-9-]{2,40}$`.
fn is_valid_skill_slug(s: &str) -> bool {
    (2..=40).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// `POST /skills/usage` — 에이전트만(사람은 zod 보다 먼저 400 `invalid_account`). 감사 없음(매 턴 일어난다).
pub async fn post_usage(State(st): State<AppState>, req: Request) -> Response {
    let (body, RequireAccount(me, _), _) = match body_then::<RequireAccount>(req).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    if me.kind != "agent" {
        return json_err(
            StatusCode::BAD_REQUEST,
            "invalid_account",
            "skill usage is only for agent accounts",
        );
    }
    let slugs = match parse_usage(&body) {
        Ok(s) => s,
        Err(f) => return bad(f),
    };
    let pool = match write_pool(&st) {
        Ok(p) => p,
        Err(r) => return r,
    };
    match record_use(pool, &me.id, &slugs).await {
        Ok(recorded) => json_ok(json!({ "recorded": recorded }).to_string()),
        Err(e) => internal(e),
    }
}

/// TS `recordSkillUse` — 워크스페이스 것(승인·비활성 아님만) 다음 내장 것.
async fn record_use(
    pool: &PgPool,
    account_id: &str,
    slugs: &[String],
) -> Result<Vec<String>, sqlx::Error> {
    let (builtin, workspace): (Vec<String>, Vec<String>) = slugs
        .iter()
        .cloned()
        .partition(|s| s.starts_with(BUILTIN_SKILL_PREFIX));
    let mut recorded = vec![];
    if !workspace.is_empty() {
        let rows: Vec<String> = sqlx::query_scalar(
            "insert into workspace_skill_usage (slug, account_id) \
             select s.slug, $2::uuid from workspace_skill s \
             where s.slug = any($1::text[]) and s.approved_at is not null and s.disabled_at is null \
             returning slug",
        )
        .bind(&workspace)
        .bind(account_id)
        .fetch_all(pool)
        .await?;
        recorded.extend(rows);
    }
    if !builtin.is_empty() {
        let rows: Vec<String> = sqlx::query_scalar(
            "insert into builtin_skill_usage (slug, account_id) \
             select unnest($1::text[]), $2::uuid returning slug",
        )
        .bind(&builtin)
        .bind(account_id)
        .fetch_all(pool)
        .await?;
        recorded.extend(rows);
    }
    Ok(recorded)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn j(v: Value) -> Body {
        Body::Json(v)
    }

    #[test]
    fn defaults_shape() {
        assert_eq!(parse_defaults(&j(json!({}))), Ok(DefaultsPatch::default()));
        assert_eq!(
            parse_defaults(&j(json!({ "model": null, "effort": "max", "x": 1 }))),
            Ok(DefaultsPatch {
                harness: None,
                model: Some(None),
                effort: Some(Some("max".into()))
            })
        );
        assert!(parse_defaults(&j(json!({ "harness": null }))).is_err());
        assert!(parse_defaults(&j(json!({ "harness": "nope" }))).is_err());
        assert!(parse_defaults(&j(json!({ "model": "a".repeat(65) }))).is_err());
        assert!(parse_defaults(&j(json!([]))).is_err());
        assert!(parse_defaults(&Body::None).is_err());
    }

    #[test]
    fn chain_limit_shape() {
        assert_eq!(parse_chain_limit(&j(json!({ "chainLimit": 5 }))), Ok(5));
        assert_eq!(parse_chain_limit(&j(json!({ "chainLimit": 5.0 }))), Ok(5));
        assert!(parse_chain_limit(&j(json!({ "chainLimit": 5.5 }))).is_err());
        assert!(parse_chain_limit(&j(json!({ "chainLimit": 0 }))).is_err());
        assert!(parse_chain_limit(&j(json!({ "chainLimit": 201 }))).is_err());
        assert!(parse_chain_limit(&j(json!({ "chainLimit": "5" }))).is_err());
    }

    #[test]
    fn usage_shape() {
        assert_eq!(
            parse_usage(&j(json!({ "slugs": ["ab", "ab", "X", "harkroom-x", "a"] }))),
            Ok(vec!["ab".into(), "harkroom-x".into()])
        );
        assert!(parse_usage(&j(json!({ "slugs": [], "extra": 1 }))).is_err());
        assert!(parse_usage(&j(json!({ "slugs": [1] }))).is_err());
        assert!(parse_usage(&j(json!({ "slugs": vec!["ab"; 101] }))).is_err());
        let many: Vec<String> = (0..30).map(|i| format!("s{i:02}")).collect();
        assert_eq!(parse_usage(&j(json!({ "slugs": many }))).unwrap().len(), 20);
    }
}
