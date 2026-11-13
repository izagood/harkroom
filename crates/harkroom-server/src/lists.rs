//! 읽기② 목록 묶음(S5.2 P2) — TS `teamRoutes.ts`(`GET /teams`·`/teams/:id`)·`handleGroupRoutes.ts`(`GET /handle-groups`·
//! `/handle-groups/:id`)·`skillRoutes.ts`(`GET /skills`·`/skills/:slug`)·`settingsRoutes.ts`(`GET /settings/agent-defaults`·
//! `/settings/mention-policy`)를 옮긴다. 꼴은 P1 `directory.rs` 와 같다 — 질의는 TS 서비스와 같은 문장이고, 응답 JSON 은 Postgres 가
//! 만든다(`timestamptz` 는 [`crate::iso!`] 로 JS `toISOString()` 꼴).
//!
//! 닿는 메모리 상태: 없다. 서비스(`teams.ts`·`handleGroups.ts`·`skills.ts`·`agentDefaults.ts`·`mentionPolicy.ts`)에 모듈 수준
//! `Map`·캐시가 없다(`mentionPolicy.ts` 는 「캐시하지 않는다」고 적어 두었다). `GET /settings/projection` 은 프로세스 env
//! (`projection.envBaseUrl`)를 읽고, 그 표면이 없으면 TS 가 라우트를 등록하지도 않으므로 여기 두지 않는다.
use crate::auth::{RequireAccount, RequireAdmin};
use crate::directory::{internal, json_err, json_ok, one_json};
use crate::perm::require_cap;
use axum::Extension;
use axum::extract::{Path, RawQuery, State};
use axum::http::StatusCode;
use axum::response::Response;
use sqlx::PgPool;

/// zod 3 `z.string().uuid()` 의 꼴(`[0-9a-f]{8}-…-{12}`, 대소문자 무시, 판 자리 검사 없음).
pub fn is_zod_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_hexdigit(),
        })
}

fn invalid(msg: &str) -> Response {
    // 문구는 TS(zod 오류 JSON)와 다르다 — 대조 시험은 `/error/message` 를 보지 않는다.
    json_err(StatusCode::BAD_REQUEST, "invalid_request", msg)
}

fn not_found(msg: &str) -> Response {
    json_err(StatusCode::NOT_FOUND, "not_found", msg)
}

/// 한 줄을 받거나(없으면 `None`) 오류 응답.
#[allow(clippy::result_large_err)] // 거절이 곧 axum 응답이다(CI clippy 1.99).
async fn maybe_json(
    pool: &PgPool,
    sql: &'static str,
    bind: &str,
) -> Result<Option<String>, Response> {
    sqlx::query_scalar::<_, String>(sql)
        .bind(bind)
        .fetch_optional(pool)
        .await
        .map_err(internal)
}

fn reply(r: Result<String, Response>) -> Response {
    r.map_or_else(|e| e, json_ok)
}

fn reply_or_404(r: Result<Option<String>, Response>, msg: &str) -> Response {
    match r {
        Ok(Some(b)) => json_ok(b),
        Ok(None) => not_found(msg),
        Err(e) => e,
    }
}

// ── 팀 ────────────────────────────────────────────────────────────────

/// `listTeams`·`getTeam` 의 칸(`services/teams.ts::COLS`).
#[macro_export]
macro_rules! team_cols {
    () => {
        concat!(
            "t.id, t.name, t.created_by as \"createdBy\", ",
            $crate::iso!("t.created_at"),
            " as \"createdAt\", t.lead_account_id as \"leadAccountId\", t.invoke_scope as \"invokeScope\", ",
            "t.owner_account_id as \"ownerAccountId\", ",
            "(select count(*) from agent_team_member m where m.team_id = t.id)::int as \"memberCount\""
        )
    };
}

const TEAMS: &str = concat!(
    "select json_build_object('teams', coalesce((select json_agg(x order by x.name) from (select ",
    team_cols!(),
    " from agent_team t) x), '[]'::json))::text"
);

/// `GET /teams` — 로그인한 누구나.
pub async fn teams(State(pool): State<PgPool>, _: RequireAccount) -> Response {
    reply(one_json(&pool, TEAMS, None).await)
}

const TEAM: &str = concat!(
    "select json_build_object(",
    "'team', (select row_to_json(x) from (select ",
    team_cols!(),
    " from agent_team t where t.id = $1::uuid) x), ",
    // `listTeamMembers`
    "'members', coalesce((select json_agg(x order by x.handle) from (",
    "select tm.agent_account_id as \"accountId\", a.handle, a.disabled_at is not null as disabled ",
    "from agent_team_member tm join account a on a.id = tm.agent_account_id where tm.team_id = $1::uuid) x), '[]'::json), ",
    // `listTeamInvokers`
    "'invokers', coalesce((select json_agg(account_id order by account_id) from agent_team_invoker where team_id = $1::uuid), '[]'::json)",
    ")::text from agent_team where id = $1::uuid"
);

/// `GET /teams/:id` — 팀·팀원·호출 허용 목록. 없으면 404.
pub async fn team(
    State(pool): State<PgPool>,
    _: RequireAccount,
    Path(id): Path<String>,
) -> Response {
    if !is_zod_uuid(&id) {
        return invalid("id must be a uuid");
    }
    reply_or_404(maybe_json(&pool, TEAM, &id).await, "no such team")
}

// ── 핸들 집합 ─────────────────────────────────────────────────────────

#[macro_export]
macro_rules! group_cols {
    () => {
        concat!(
            "g.id, g.handle, g.display_name as \"displayName\", ",
            $crate::iso!("g.created_at"),
            " as \"createdAt\", ",
            "(select count(*) from handle_group_member m where m.group_id = g.id)::int as \"memberCount\""
        )
    };
}

const GROUPS: &str = concat!(
    "select json_build_object('groups', coalesce((select json_agg(x order by x.handle) from (select ",
    group_cols!(),
    " from handle_group g) x), '[]'::json))::text"
);

/// `GET /handle-groups` — `channel.manage`.
pub async fn handle_groups(
    State(pool): State<PgPool>,
    auth: Extension<crate::auth::Auth>,
) -> Response {
    if let Err(r) = require_cap(&pool, &auth, "channel.manage", None).await {
        return r;
    }
    reply(one_json(&pool, GROUPS, None).await)
}

const GROUP: &str = concat!(
    "select json_build_object(",
    "'group', (select row_to_json(x) from (select ",
    group_cols!(),
    " from handle_group g where g.id = $1::uuid) x), ",
    // `listHandleGroupMembers` 는 순서를 정하지 않는다 — 같은 문장을 그대로 감싼다.
    "'members', coalesce((select json_agg(x.account_id) from (",
    "select group_id, account_id from handle_group_member where group_id = $1::uuid) x), '[]'::json)",
    ")::text from handle_group where id = $1::uuid"
);

/// `GET /handle-groups/:id` — `channel.manage`. 권한이 uuid 검사보다 먼저다(TS preHandler 순서).
pub async fn handle_group(
    State(pool): State<PgPool>,
    auth: Extension<crate::auth::Auth>,
    Path(id): Path<String>,
) -> Response {
    if let Err(r) = require_cap(&pool, &auth, "channel.manage", None).await {
        return r;
    }
    if !is_zod_uuid(&id) {
        return invalid("id must be a uuid");
    }
    reply_or_404(maybe_json(&pool, GROUP, &id).await, "no such group")
}

// ── 스킬 ──────────────────────────────────────────────────────────────

macro_rules! skill_cols {
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

/// TS `z.object({ state: enum? }).strict()` — 모르는 키·같은 키 둘·모르는 값은 400.
pub fn parse_skills_query(raw: Option<&str>) -> Result<Option<String>, &'static str> {
    let mut state = None;
    for (k, v) in crate::directory::form_pairs(raw.unwrap_or("")) {
        if k != "state" {
            return Err("unknown query key");
        }
        if state.is_some() {
            return Err("duplicate query key");
        }
        if !matches!(v.as_str(), "pending" | "approved" | "disabled") {
            return Err("state must be pending, approved or disabled");
        }
        state = Some(v);
    }
    Ok(state)
}

/// `GET /skills` — 맨 배열을 낸다. 정렬용 칸(`ord_*`)은 응답에서 뺀다.
pub async fn skills(
    State(pool): State<PgPool>,
    _: RequireAccount,
    RawQuery(raw): RawQuery,
) -> Response {
    let state = match parse_skills_query(raw.as_deref()) {
        Ok(s) => s,
        Err(m) => return invalid(m),
    };
    let r = sqlx::query_scalar::<_, String>(SKILLS)
        .bind(state)
        .fetch_one(&pool)
        .await
        .map_err(internal);
    reply(r)
}

/// `listSkills` + `listSkillUsage` + `skillUsageOf` 를 한 문장으로. 14·30 은 `SKILL_STALE_MIN_AGE_DAYS`·`SKILL_STALE_UNUSED_DAYS`.
/// `$1` 은 상태 필터(없으면 null). 정렬은 TS 처럼 `approved_at desc, proposed_at desc`(desc 라 null 이 앞) — 정렬용 칸은 빼고 싣는다.
const SKILLS: &str = concat!(
    "select coalesce(json_agg((to_jsonb(x) - 'ord_approved' - 'ord_proposed')::json ",
    "order by x.ord_approved desc, x.ord_proposed desc), '[]'::json)::text from (select ",
    skill_cols!(),
    ", coalesce(u.use_count, 0)::int as \"useCount\", ",
    crate::iso!("u.last_used_at"),
    " as \"lastUsedAt\", ",
    "(s.approved_at is not null and s.disabled_at is null ",
    "and s.approved_at <= now() - make_interval(days => 14) ",
    "and (u.last_used_at is null or u.last_used_at <= now() - make_interval(days => 30))) as \"staleCandidate\", ",
    "s.approved_at as ord_approved, s.proposed_at as ord_proposed ",
    "from workspace_skill s left join (select slug, count(*) as use_count, max(used_at) as last_used_at ",
    "from workspace_skill_usage group by slug) u on u.slug = s.slug ",
    "where case $1::text ",
    "when 'pending' then s.approved_at is null and s.disabled_at is null ",
    "when 'approved' then s.approved_at is not null and s.disabled_at is null ",
    "when 'disabled' then s.disabled_at is not null ",
    "else true end) x"
);

const SKILL: &str = concat!(
    "select row_to_json(x)::text from (select ",
    skill_cols!(),
    " from workspace_skill s where s.slug = $1) x"
);

/// `GET /skills/:slug` — 사용 통계 없이 한 스킬. 없으면 404.
pub async fn skill(
    State(pool): State<PgPool>,
    _: RequireAccount,
    Path(slug): Path<String>,
) -> Response {
    reply_or_404(maybe_json(&pool, SKILL, &slug).await, "skill not found")
}

// ── 설정 ──────────────────────────────────────────────────────────────

const AGENT_DEFAULTS: &str = "select json_build_object('harness', harness, 'model', model, 'effort', effort)::text from agent_defaults where id = true";

/// `GET /settings/agent-defaults` — admin.
pub async fn agent_defaults(State(pool): State<PgPool>, _: RequireAdmin) -> Response {
    reply(one_json(&pool, AGENT_DEFAULTS, None).await)
}

/// 행이 없으면 `MENTION_CHAIN_LIMIT`(shared, 8)로 떨어진다(`getMentionPolicy`).
const MENTION_POLICY: &str = "select json_build_object('chainLimit', coalesce((select chain_limit from mention_policy where id = true), 8))::text";

/// `GET /settings/mention-policy` — 로그인한 누구나.
pub async fn mention_policy(State(pool): State<PgPool>, _: RequireAccount) -> Response {
    reply(one_json(&pool, MENTION_POLICY, None).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zod_uuid_shape() {
        assert!(is_zod_uuid("00000000-0000-0000-0000-000000000000"));
        assert!(is_zod_uuid("ABCDEF01-2345-6789-abcd-ef0123456789"));
        assert!(!is_zod_uuid("ABCDEF01-2345-6789-abcd-ef012345678"));
        assert!(!is_zod_uuid("ABCDEF01x2345-6789-abcd-ef0123456789"));
        assert!(!is_zod_uuid("me"));
        assert!(!is_zod_uuid("g0000000-0000-0000-0000-000000000000"));
    }

    #[test]
    fn skills_query_is_strict() {
        assert_eq!(parse_skills_query(None), Ok(None));
        assert_eq!(parse_skills_query(Some("")), Ok(None));
        assert_eq!(
            parse_skills_query(Some("state=approved")),
            Ok(Some("approved".into()))
        );
        assert!(
            parse_skills_query(Some("approved=true")).is_err(),
            "옛 별칭은 400(#325)"
        );
        assert!(parse_skills_query(Some("state=all")).is_err());
        assert!(parse_skills_query(Some("state=")).is_err());
        assert!(parse_skills_query(Some("state=pending&state=approved")).is_err());
    }
}
