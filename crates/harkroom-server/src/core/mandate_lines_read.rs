//! S5.4 MD1 — 위임장 줄 읽기. TS `routes/mandateRoutes.ts` 의 `GET /mandates/:id/lines`(`listMandateLines`)를 옮긴다.
//!
//! - 판정 순서는 TS 와 같다: `requireAccount`(401) → 경로 id 가 uuid 가 아니면 404 → 사람 **세션**이 아니면(에이전트 토큰·사람 PAT)
//!   404 → 내 위임장이 아니면 404. 남의 위임장이 있는지도 말하지 않는다. 200 에만 `cache-control: no-store`.
//! - 줄은 저장된 줄(회수 제외, TS `MANDATE_LINES_STORED_SQL` 골든) 다음에 상시 줄(소유자가 맡긴 위임장에서만, 소유자가 준
//!   `repo.merge`·`tool.allow` grant 를 펼친 것 — `readOnly: true`). 상시 줄의 scope 판정은 TS `CAPABILITIES.*.validateScope` 와 같다.
//! - **읽기만 한다.** 읽기 풀만 쓰므로 새 GRANT 가 없다. 줄 빼기(`DELETE .../lines/:lineId`)·위임 끝내기(`POST .../end`)는 TS.
use super::grant_reads::canonical_rule;
use super::mcp::grant_writes::repo_grant_scope;
use super::mcp::reads4::parse_tool_scope;
use crate::auth::{RequireAccount, Via};
use crate::directory::{internal, json_err};
use axum::extract::{Path, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::Value;
use sqlx::PgPool;
use std::sync::Arc;

/// 시각은 JS `Date#toISOString` 꼴(밀리초·Z).
macro_rules! iso {
    ($c:literal) => {
        concat!(
            "to_char(",
            $c,
            " at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')"
        )
    };
}

/// TS `ownMandate`.
const OWN_SQL: &str = "select 1 from mandate where id = $1::uuid and owner_account_id = $2::uuid";

/// TS `listMandateLines` 의 위임장 읽기 — 주인·맡긴 사람·채널.
const MANDATE_SQL: &str = "select owner_account_id::text, coalesce(delegator_account_id, owner_account_id)::text, channel_id::text \
       from mandate where id = $1::uuid";

/// TS `listMandateLines` 의 상시 줄 grant 읽기. `$1` 주인, `$2` 맡긴 사람(= 주인). 지금은 DB `now()`.
const STANDING_SQL: &str = concat!(
    "select g.id::text, g.account_id::text, g.capability, g.scope, g.granted_by::text, ",
    iso!("g.granted_at"),
    ", ",
    iso!("g.expires_at"),
    " from account_grant g join agent_config c on c.account_id = g.account_id \
      where c.owner_account_id = $1::uuid and g.granted_by = $2::uuid and g.capability in ('repo.merge', 'tool.allow') \
        and (g.expires_at is null or g.expires_at > now()) \
      order by g.granted_at, g.id"
);

/// 저장된 줄 — TS 골든 문장을 감싸 한 줄씩 TS 응답 꼴(키 순서까지) json 으로 낸다. 순서는 골든의 `order by created_at, id`.
fn stored_sql() -> &'static str {
    static S: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    S.get_or_init(|| {
        format!(
            concat!(
                "select json_build_object('id', t.id, 'cap', t.cap, 'scope', t.scope, 'limits', t.limits, ",
                "'agentIds', t.\"agentIds\", 'grantedBy', t.\"grantedBy\", 'via', t.via, 'requestId', t.\"requestId\", ",
                "'usedCount', t.\"usedCount\", 'createdAt', ",
                iso!("t.\"createdAt\""),
                ", 'readOnly', false)::text from ({}) t order by t.\"createdAt\", t.id"
            ),
            crate::core::channels::frag("grant_mandate_lines_stored")
        )
    })
}

type GrantRow = (
    String,
    String,
    String,
    String,
    String,
    String,
    Option<String>,
);

/// TS `CAPABILITIES.merge.validateScope`.
fn merge_scope(scope: &str) -> Option<String> {
    let raw = scope.trim().to_lowercase();
    repo_grant_scope(raw.strip_prefix("repo:")?)
}

/// grant 하나를 상시 줄로 — 판정에 걸리면 None(TS `continue`).
fn standing_line(g: &GrantRow, channel: &str) -> Option<String> {
    let (id, agent, capability, scope, granted_by, granted_at, expires_at) = g;
    let (cap, scope) = match capability.as_str() {
        "repo.merge" => ("merge", merge_scope(scope)?),
        _ => {
            let (ch, rule) = parse_tool_scope(scope)?;
            if ch != channel || !canonical_rule(rule) {
                return None;
            }
            ("tool", rule.to_string())
        }
    };
    let s = |v: &str| Value::String(v.to_string()).to_string();
    let limits = match expires_at {
        Some(u) => format!("{{\"until\":{}}}", s(u)),
        None => "{}".into(),
    };
    Some(format!(
        "{{\"id\":{},\"cap\":{},\"scope\":{},\"limits\":{limits},\"agentIds\":[{}],\"grantedBy\":{},\"via\":\"standing\",\
\"requestId\":null,\"usedCount\":0,\"createdAt\":{},\"readOnly\":true}}",
        s(id),
        s(cap),
        s(&scope),
        s(agent),
        s(granted_by),
        s(granted_at),
    ))
}

fn not_found() -> Response {
    json_err(StatusCode::NOT_FOUND, "not_found", "no such mandate")
}

/// `GET /mandates/:id/lines`.
pub async fn list_lines(
    State(read): State<Arc<PgPool>>,
    RequireAccount(me, auth): RequireAccount,
    Path(id): Path<String>,
) -> Response {
    if !crate::lists::is_zod_uuid(&id) {
        return not_found();
    }
    if me.kind != "human" || auth.via != Some(Via::Session) {
        return not_found();
    }
    let pool = read.as_ref();
    match sqlx::query_scalar::<_, i32>(OWN_SQL)
        .bind(&id)
        .bind(&me.id)
        .fetch_optional(pool)
        .await
    {
        Ok(Some(_)) => {}
        Ok(None) => return not_found(),
        Err(e) => return internal(e),
    }
    let m: Option<(String, String, String)> = match sqlx::query_as(MANDATE_SQL)
        .bind(&id)
        .fetch_optional(pool)
        .await
    {
        Ok(m) => m,
        Err(e) => return internal(e),
    };
    let mut lines: Vec<String> = Vec::new();
    if let Some((owner, delegator, channel)) = m {
        match sqlx::query_scalar::<_, String>(stored_sql())
            .bind(&id)
            .fetch_all(pool)
            .await
        {
            Ok(v) => lines.extend(v),
            Err(e) => return internal(e),
        }
        // 상시 줄은 소유자가 맡긴 위임장에서만(TS C-3).
        if delegator == owner {
            let grants: Vec<GrantRow> = match sqlx::query_as(STANDING_SQL)
                .bind(&owner)
                .bind(&delegator)
                .fetch_all(pool)
                .await
            {
                Ok(v) => v,
                Err(e) => return internal(e),
            };
            lines.extend(grants.iter().filter_map(|g| standing_line(g, &channel)));
        }
    }
    // 키 순서를 TS 와 같게 두려고 문자열 그대로 낸다(serde_json `Value` 는 키를 다시 정렬한다).
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/json; charset=utf-8"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        format!("{{\"lines\":[{}]}}", lines.join(",")),
    )
        .into_response()
}

pub fn routes(
    pool: PgPool,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<PgPool>>::new()
        .get("/mandates/{id}/lines", list_lines)
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
        router: t.router.with_state(Arc::new(pool)),
        http: t.http,
        sockets: t.sockets,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_scope_follows_ts() {
        assert_eq!(merge_scope(" Repo:Acme/Web "), Some("repo:acme/web".into()));
        assert_eq!(merge_scope("repo:acme/*"), Some("repo:acme/*".into()));
        assert_eq!(merge_scope("acme/web"), None);
    }

    #[test]
    fn standing_tool_line_needs_same_channel() {
        let ch = "11111111-1111-1111-1111-111111111111";
        let g: GrantRow = (
            "g".into(),
            "a".into(),
            "tool.allow".into(),
            format!("tool:{ch}:mcp__x__y"),
            "o".into(),
            "2026-01-01T00:00:00.000Z".into(),
            None,
        );
        let line = standing_line(&g, ch).expect("line");
        let v: Value = serde_json::from_str(&line).expect("json");
        assert_eq!(v["scope"], "mcp__x__y");
        assert_eq!(v["readOnly"], true);
        assert!(standing_line(&g, "22222222-2222-2222-2222-222222222222").is_none());
    }
}
