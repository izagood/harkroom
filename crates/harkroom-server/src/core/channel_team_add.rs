//! S5.4 CT1 — 채널에 팀 넣기 한 줄. TS `routes/teamRoutes.ts` 의 `POST /channels/:id/teams/:teamId/add` 와
//! `services/teams.ts` 의 `addTeamToChannel` 을 옮긴다.
//!
//! - 순서가 규칙이다(TS 와 같다): 본문 읽기 → 인증(401) → 경로 두 id(400) → 채널 있나(404) → 게이트(400 `channel_archived`·
//!   400 `channel_is_dm`) → public 이면 400 `channel_is_public` → 볼 수 있나(403) → 팀 있나(404) → 한 트랜잭션으로 팀원을
//!   `handle` 순으로 넣는다(비활성은 `skipped`, 이미 멤버면 `alreadyMember`, 나머지는 `added`) → 감사 → 200 `{added, skipped, alreadyMember}`.
//! - 이벤트는 내지 않는다(TS 도 내지 않는다). 감사 detail 은 TS 와 같이 팀 이름과 개수만이다.
//! - 권한은 [`TEAM_ADD_PRIVILEGES`](칸 단위) — 쓰기 풀에 다 있어야 `main.rs` 가 붙인다(없으면 TS 에 남는다).
use super::channels::is_uuid;
use super::msg_read::channel_visible;
use crate::directory::{internal, json_err, json_ok};
use crate::trust_proxy::TrustProxy;
use crate::write::{AuditEntry, record_audit};
use crate::writes_settings::{body_then, ip_of};
use axum::extract::{Path, Request, State};
use axum::http::StatusCode;
use axum::response::Response;
use serde_json::json;
use sqlx::PgPool;
use std::sync::Arc;

/// 이 줄이 쓰는 권한(표·칸, 권한) — homelab GRANT 와 같아야 한다. 판정·쓰기를 모두 쓰기 풀에서 한다.
pub const TEAM_ADD_PRIVILEGES: &[(&str, &str)] = &[
    ("channel.id", "SELECT"),
    ("channel.kind", "SELECT"),
    ("channel.visibility", "SELECT"),
    ("channel.archived_at", "SELECT"),
    ("channel_member.channel_id", "SELECT"),
    ("channel_member.account_id", "SELECT"),
    ("channel_member.channel_id", "INSERT"),
    ("channel_member.account_id", "INSERT"),
    ("agent_team.id", "SELECT"),
    ("agent_team.name", "SELECT"),
    ("agent_team_member.team_id", "SELECT"),
    ("agent_team_member.agent_account_id", "SELECT"),
    ("account.id", "SELECT"),
    ("account.handle", "SELECT"),
    ("account.disabled_at", "SELECT"),
    ("audit_log", "INSERT"),
];

/// TS `select visibility from channel where id = $1`.
const CHANNEL_VISIBILITY: &str = "select visibility from channel where id = $1::uuid";
/// TS `CHANNEL_MEMBERSHIP_GATE_SQL` 의 두 칸 — 종류와 보관 여부.
const GATE: &str =
    "select kind, archived_at is not null as archived from channel where id = $1::uuid";
/// TS `getTeam` 에서 이 줄이 쓰는 것은 이름뿐이다.
const TEAM_NAME: &str = "select name from agent_team t where t.id = $1::uuid";
/// TS `TEAM_MEMBERS_SQL`.
const TEAM_MEMBERS: &str = "select tm.agent_account_id::text, a.handle, a.disabled_at is not null as disabled \
     from agent_team_member tm join account a on a.id = tm.agent_account_id \
     where tm.team_id = $1::uuid order by a.handle";
/// TS `isChannelMember`.
const IS_MEMBER: &str =
    "select 1 from channel_member where channel_id = $1::uuid and account_id = $2::uuid";
/// TS `ADD_CHANNEL_MEMBER_SQL`.
const ADD_MEMBER: &str = "insert into channel_member (channel_id, account_id) values ($1::uuid, $2::uuid) on conflict do nothing";

#[derive(Clone)]
pub struct TeamAddState {
    pub write: PgPool,
    pub trust: TrustProxy,
}

fn bad() -> Response {
    // 문구는 TS(zod 오류 JSON)와 다르다 — 대조는 상태만 본다.
    json_err(
        StatusCode::BAD_REQUEST,
        "invalid_request",
        "params: invalid",
    )
}

#[derive(Default, Debug, PartialEq, Eq)]
struct Outcome {
    added: Vec<String>,
    skipped: Vec<String>,
    already_member: Vec<String>,
}

/// TS `addTeamToChannel` — 한 트랜잭션.
async fn add_team(pool: &PgPool, channel: &str, team: &str) -> sqlx::Result<Outcome> {
    let mut tx = pool.begin().await?;
    let members: Vec<(String, String, bool)> = sqlx::query_as(TEAM_MEMBERS)
        .bind(team)
        .fetch_all(&mut *tx)
        .await?;
    let mut out = Outcome::default();
    for (account, handle, disabled) in members {
        if disabled {
            out.skipped.push(handle);
            continue;
        }
        let is_member = sqlx::query(IS_MEMBER)
            .bind(channel)
            .bind(&account)
            .fetch_optional(&mut *tx)
            .await?
            .is_some();
        if is_member {
            out.already_member.push(handle);
            continue;
        }
        sqlx::query(ADD_MEMBER)
            .bind(channel)
            .bind(&account)
            .execute(&mut *tx)
            .await?;
        out.added.push(handle);
    }
    tx.commit().await?;
    Ok(out)
}

/// `POST /channels/{id}/teams/{teamId}/add` — 로그인한 누구나(가시성으로 막는다).
pub async fn add(
    State(st): State<Arc<TeamAddState>>,
    Path((id, team_id)): Path<(String, String)>,
    req: Request,
) -> Response {
    let (_body, crate::auth::RequireAccount(me, _), parts) =
        match body_then::<crate::auth::RequireAccount>(req).await {
            Ok(v) => v,
            Err(r) => return r,
        };
    if !is_uuid(&id) || !is_uuid(&team_id) {
        return bad();
    }
    let w = &st.write;
    let visibility: String = match sqlx::query_scalar(CHANNEL_VISIBILITY)
        .bind(&id)
        .fetch_optional(w)
        .await
    {
        Ok(Some(v)) => v,
        Ok(None) => return json_err(StatusCode::NOT_FOUND, "not_found", "no such channel"),
        Err(e) => return internal(e),
    };
    // 보관·DM 게이트가 public 판정보다 **앞**이다(TS #328). 그 사이 사라진 채널은 TS 와 같이 다음 판정으로 넘어간다.
    let gate: Option<(String, bool)> = match sqlx::query_as(GATE).bind(&id).fetch_optional(w).await
    {
        Ok(g) => g,
        Err(e) => return internal(e),
    };
    match gate {
        Some((_, true)) => {
            return json_err(
                StatusCode::BAD_REQUEST,
                "channel_archived",
                "archived channels are read-only",
            );
        }
        Some((k, false)) if k == "dm" => {
            return json_err(
                StatusCode::BAD_REQUEST,
                "channel_is_dm",
                "a dm has no membership to edit",
            );
        }
        _ => {}
    }
    if visibility == "public" {
        return json_err(
            StatusCode::BAD_REQUEST,
            "channel_is_public",
            "a public channel has no membership",
        );
    }
    match channel_visible(w, &me.id, &id).await {
        Ok(true) => {}
        Ok(false) => {
            return json_err(
                StatusCode::FORBIDDEN,
                "forbidden",
                "not a member of this channel",
            );
        }
        Err(e) => return internal(e),
    }
    let team_name: String = match sqlx::query_scalar(TEAM_NAME)
        .bind(&team_id)
        .fetch_optional(w)
        .await
    {
        Ok(Some(n)) => n,
        Ok(None) => return json_err(StatusCode::NOT_FOUND, "not_found", "no such team"),
        Err(e) => return internal(e),
    };
    let out = match add_team(w, &id, &team_id).await {
        Ok(o) => o,
        Err(e) => return internal(e),
    };
    let ip = ip_of(&parts, &st.trust);
    record_audit(
        w,
        AuditEntry {
            action: "channel.team.added",
            actor_id: Some(&me.id),
            actor_handle: Some(&me.handle),
            target: Some(&id),
            ip: ip.as_deref(),
            detail: json!({
                "teamHandle": team_name,
                "added": out.added.len(),
                "skipped": out.skipped.len(),
            }),
        },
    )
    .await;
    json_ok(
        json!({
            "added": out.added,
            "skipped": out.skipped,
            "alreadyMember": out.already_member,
        })
        .to_string(),
    )
}

/// 코어 라우터에 합칠 줄 — `channel_members.rs` 와 같은 길(인증은 `route_layer`, CORS 는 `layer`).
pub fn routes(
    st: TeamAddState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<TeamAddState>>::new()
        .post("/channels/{id}/teams/{teamId}/add", add)
        .map(|r| {
            r.route_layer(axum::middleware::from_fn_with_state(
                auth,
                crate::auth::layer,
            ))
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

    #[test]
    fn privileges_are_column_level_for_reads_and_member_insert() {
        for (t, p) in TEAM_ADD_PRIVILEGES {
            if *t != "audit_log" {
                assert!(t.contains('.'), "{p} on {t} should be column-level");
            }
        }
    }

    #[test]
    fn member_sql_orders_by_handle_like_ts() {
        assert!(TEAM_MEMBERS.ends_with("order by a.handle"));
        assert!(ADD_MEMBER.contains("on conflict do nothing"));
    }
}
