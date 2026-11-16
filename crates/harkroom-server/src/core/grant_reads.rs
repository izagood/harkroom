//! S5.3 C3b — grant 읽기 줄. 러너·오퍼레이터가 턴마다 읽는 두 라우트를 TS `permissionRequestRoutes.ts` 와 같은 응답으로 낸다.
//!
//! - `GET /agent/tool-allows?channelId=&cause=` → `{ rules, reach }`
//! - `GET /agent/command-grants?channelId=&threadRootId=` → `{ grants }`
//!
//! 약속:
//! - **읽기만 한다.** 읽기 풀만 쓰므로 새 GRANT 가 없다. `POST /agent/command-grants/match` 는 grant 를 **쓴다**(`use_count`·`used_at`·
//!   `bound_cwd` UPDATE + 감사 INSERT) — 이 줄에 넣지 않고 TS 에 둔다(경로가 표에 없으니 fallback 으로 TS 가 받는다).
//! - 문장은 TS 정본(`TOOL_ALLOWS_SQL`·`TOOL_REACH_SQL`·`MANDATE_TURN_LEASE_SQL`·`MANDATE_AGENT_CHANNEL_SQL`·`VALID_MANDATE_OWNER_SQL`·
//!   `MANDATE_LINES_STORED_SQL`·`COMMAND_GRANTS_SQL`)을 `golden/sql_fragments.json` 에서 읽는다.
//! - 규칙·명령 판정은 TS `validateToolRule`·`validateExactCommand` 를 TS 골든으로 고정한 `harkroom_proto::tool_rules` 를 쓴다.
//! - 위임장 줄을 준 사람이 소유자가 아니면 그 사람이 **지금도** 정할 수 있는지 3a 판정(잠그지 않음)으로 다시 본다(TS `mayDecideFor`).
//! - 오퍼레이터를 거친 에이전트만(사람·에이전트 PAT 는 403). 200 에만 `cache-control: no-store`(TS 와 같이 400·403 에는 없다).
use super::decide_core::may_decide_for_unlocked;
use super::mcp::reads4::parse_tool_scope;
use super::msg_read::is_uuid;
use crate::auth::{Account, Auth, RequireAccount};
use crate::directory::{form_pairs, internal, json_err};
use axum::extract::{RawQuery, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use harkroom_proto::tool_rules::{
    ExactCommandVerdict, ToolRuleVerdict, validate_exact_command, validate_tool_rule,
};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;

const FORBIDDEN: &str = "only an agent through its operator can do this";
const TOOL_BAD: &str = "channelId (uuid) is required";
const GRANTS_BAD: &str = "channelId and threadRootId (uuids) are required";
/// TS `MANDATE_IDLE_MS`(7일).
const MANDATE_IDLE_MS: i64 = 7 * 86_400_000;

fn frag(k: &str) -> &'static str {
    crate::core::channels::frag(k)
}

/// 골든을 감싼 문장들 — `'static` 이어야 sqlx 가 받는다(`reads4.rs` 와 같은 꼴).
struct Sql {
    lease: String,
    owner: String,
    lines: String,
    grants: String,
}

fn sql() -> &'static Sql {
    static S: std::sync::OnceLock<Sql> = std::sync::OnceLock::new();
    S.get_or_init(|| Sql {
        lease: format!(
            "select t.\"mandateId\"::text from ({}) t",
            frag("grant_mandate_turn_lease")
        ),
        owner: format!(
            "select t.owner::text from ({}) t",
            frag("grant_valid_mandate_owner")
        ),
        lines: format!(
            "select t.cap, t.scope, t.limits::text, t.\"agentIds\"::text[], t.\"grantedBy\"::text from ({}) t",
            frag("grant_mandate_lines_stored")
        ),
        // 행 순서는 TS 문장의 `order by created_at` 그대로(`rows_sql`), `expiresAt` 은 toISOString 꼴.
        grants: crate::core::channels::rows_sql(frag("grant_command_grants"), &["expiresAt"]),
    })
}

/// TS `req.account.kind !== 'agent' || !req.operator` 의 반대.
pub fn through_operator(me: &Account, auth: &Auth) -> bool {
    me.kind == "agent" && auth.operator.is_some()
}

/// zod `z.object({...}).safeParse(req.query)` — 적은 키만 본다. 같은 키가 둘이면(fastify 가 배열로 읽음) 실패, 모르는 키는 버린다.
/// `required` 는 꼭 있어야 하는 키, `optional` 은 있으면 uuid 여야 하는 키. 값은 같은 순서로 돌려준다.
pub fn parse_query(
    raw: Option<&str>,
    required: &[&str],
    optional: &[&str],
) -> Option<Vec<Option<String>>> {
    let keys: Vec<&str> = required.iter().chain(optional).copied().collect();
    let mut vals: Vec<Option<String>> = vec![None; keys.len()];
    let mut seen = vec![0u8; keys.len()];
    for (k, v) in form_pairs(raw.unwrap_or("")) {
        if let Some(i) = keys.iter().position(|x| *x == k) {
            seen[i] = seen[i].saturating_add(1);
            vals[i] = Some(v);
        }
    }
    if seen.iter().any(|n| *n > 1) {
        return None;
    }
    for (i, v) in vals.iter().enumerate() {
        match v {
            None if i < required.len() => return None,
            Some(s) if !is_uuid(s) => return None,
            _ => {}
        }
    }
    Some(vals)
}

/// TS `v.ok && v.rule === rule`.
pub fn canonical_rule(rule: &str) -> bool {
    matches!(validate_tool_rule(rule), ToolRuleVerdict::Ok { rule: r, .. } if r == rule)
}

/// TS `v.ok && v.command === command`.
pub fn canonical_command(command: &str) -> bool {
    matches!(validate_exact_command(command), ExactCommandVerdict::Ok { command: c, .. } if c == command)
}

/// JS 기본 `Array.prototype.sort()` — UTF-16 코드 단위 순서. `Set` 처럼 겹침도 지운다.
pub fn js_sorted(set: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut v: Vec<String> = set
        .into_iter()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    v.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    v
}

/// `YYYY-MM-DDTHH:MM:SS(.mmm)Z` → 유닉스 밀리초. 서버가 적는 꼴(`toISOString`)만 받는다 — 다른 꼴은 `Date.parse` 의 NaN 처럼 None.
pub fn iso_ms(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    let ok_head = b.len() >= 20
        && b[4] == b'-'
        && b[7] == b'-'
        && b[10] == b'T'
        && b[13] == b':'
        && b[16] == b':'
        && *b.last()? == b'Z';
    if !ok_head {
        return None;
    }
    let n = |r: std::ops::Range<usize>| -> Option<i64> {
        let t = s.get(r)?;
        t.bytes()
            .all(|c| c.is_ascii_digit())
            .then(|| t.parse().ok())?
    };
    let ms = match b.len() {
        20 => 0,
        24 if b[19] == b'.' => n(20..23)?,
        _ => return None,
    };
    let (y, mo, d, h, mi, se) = (
        n(0..4)?,
        n(5..7)?,
        n(8..10)?,
        n(11..13)?,
        n(14..16)?,
        n(17..19)?,
    );
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || se > 59 {
        return None;
    }
    let days = crate::write::days_from_civil(y, mo, d);
    Some(days * 86_400_000 + ((h * 60 + mi) * 60 + se) * 1000 + ms)
}

/// 위임장 줄 하나의 `limits` 가 지금 이 턴에서 argv 에 실릴 수 있나(TS `mandateToolRulesFor` 의 세 조건).
/// - `uses` 키가 있으면 싣지 않는다(n번을 지킬 수 없음) · `turnCause` 는 이 턴의 원인과 같아야 · `until` 은 지금보다 뒤여야.
pub fn limits_allow(limits: &Value, cause: &str, now_ms: i64) -> bool {
    let Some(o) = limits.as_object() else {
        // TS `(l.limits ?? {})` — 객체가 아닌 값(배열·수)은 키가 없는 것과 같다. null 도 같다.
        return true;
    };
    if o.contains_key("uses") {
        return false;
    }
    if let Some(t) = o.get("turnCause")
        && t.as_str() != Some(cause)
    {
        return false;
    }
    if let Some(u) = o.get("until") {
        match u.as_str().and_then(iso_ms) {
            Some(at) if at > now_ms => {}
            _ => return false,
        }
    }
    true
}

fn ok_no_store(v: &Value) -> Response {
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/json; charset=utf-8"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        v.to_string(),
    )
        .into_response()
}

/// 이 요청의 「지금」 — TS 가 한 요청에서 `new Date()` 하나를 여러 문장에 쓰는 것처럼 한 값을 돌려 쓴다.
struct Now {
    txt: String,
    ms: i64,
    idle_cutoff: String,
}

async fn now(pool: &PgPool) -> sqlx::Result<Now> {
    let (txt, ms, idle_cutoff): (String, f64, String) = sqlx::query_as(
        "select to_char(t at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'), \
                floor(extract(epoch from t) * 1000)::float8, \
                to_char((t - make_interval(secs => $1::float8 / 1000)) at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') \
           from (select date_trunc('milliseconds', clock_timestamp()) as t) n",
    )
    .bind(MANDATE_IDLE_MS as f64)
    .fetch_one(pool)
    .await?;
    Ok(Now {
        txt,
        ms: ms as i64,
        idle_cutoff,
    })
}

/// TS `toolAllowsFor` — 이 채널에서 받은 살아 있는 allow 규칙(정규형만).
async fn tool_allows_for(
    pool: &PgPool,
    agent: &str,
    channel: &str,
    n: &Now,
) -> sqlx::Result<Vec<String>> {
    let prefix = format!("tool:{channel}:");
    let rows: Vec<(String,)> = sqlx::query_as(frag("grant_tool_allows"))
        .bind(agent)
        .bind(&prefix)
        .bind(&n.txt)
        .bind(channel)
        .fetch_all(pool)
        .await?;
    Ok(rows
        .into_iter()
        .filter_map(|(scope,)| {
            let rule = scope.get(prefix.len()..)?.to_owned();
            canonical_rule(&rule).then_some(rule)
        })
        .collect())
}

/// TS `toolReachFor` — 모든 채널의 합.
async fn tool_reach_for(pool: &PgPool, agent: &str, n: &Now) -> sqlx::Result<Vec<String>> {
    let rows: Vec<(String,)> = sqlx::query_as(frag("grant_tool_reach"))
        .bind(agent)
        .bind(&n.txt)
        .fetch_all(pool)
        .await?;
    Ok(rows
        .into_iter()
        .filter_map(|(scope,)| {
            let (_, rule) = parse_tool_scope(&scope)?;
            canonical_rule(rule).then(|| rule.to_owned())
        })
        .collect())
}

/// 위임장 저장 줄 한 행 — cap · scope · limits(jsonb 글자) · agentIds · grantedBy.
type LineRow = (String, String, Option<String>, Option<Vec<String>>, String);

/// TS `mandateToolRulesFor` — 이 턴(원인 글)의 임대가 가리키는 위임장의 저장된 tool 줄.
async fn mandate_tool_rules_for(
    pool: &PgPool,
    agent: &str,
    operator: &str,
    channel: &str,
    cause: &str,
    n: &Now,
) -> sqlx::Result<Vec<String>> {
    let lease: Option<(Option<String>,)> = sqlx::query_as(sql().lease.as_str())
        .bind(agent)
        .bind(cause)
        .bind(operator)
        .bind(channel)
        .bind(&n.txt)
        .fetch_optional(pool)
        .await?;
    let Some((Some(mandate),)) = lease else {
        return Ok(vec![]);
    };
    let owner: Option<(String,)> = sqlx::query_as(sql().owner.as_str())
        .bind(&mandate)
        .bind(&n.idle_cutoff)
        .fetch_optional(pool)
        .await?;
    let Some((owner,)) = owner else {
        return Ok(vec![]);
    };
    let same = sqlx::query(frag("grant_mandate_agent_channel"))
        .bind(&mandate)
        .bind(agent)
        .bind(channel)
        .fetch_optional(pool)
        .await?;
    if same.is_none() {
        return Ok(vec![]);
    }
    // 저장된 줄(회수 제외)만 — 상시 줄(readOnly)은 grant 라 `toolAllowsFor` 가 이미 준다(TS 는 `l.readOnly` 로 건너뛴다).
    let lines: Vec<LineRow> = sqlx::query_as(sql().lines.as_str())
        .bind(&mandate)
        .fetch_all(pool)
        .await?;
    let mut still: HashMap<String, bool> = HashMap::new();
    let mut out = BTreeSet::new();
    for (cap, scope, limits, agent_ids, granted_by) in lines {
        if cap != "tool" {
            continue;
        }
        if let Some(ids) = &agent_ids
            && !ids.iter().any(|a| a == agent)
        {
            continue;
        }
        // C-3: 소유자가 아닌 사람이 준 줄은 그 사람이 지금도 이 채널에서 정할 수 있을 때만.
        if granted_by != owner {
            let ok = match still.get(&granted_by) {
                Some(v) => *v,
                None => {
                    let mut conn = pool.acquire().await?;
                    let v = may_decide_for_unlocked(&mut conn, agent, &granted_by, Some(channel))
                        .await?
                        .ok
                        .is_some();
                    still.insert(granted_by.clone(), v);
                    v
                }
            };
            if !ok {
                continue;
            }
        }
        let limits: Value = limits
            .as_deref()
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or(Value::Null);
        if !limits_allow(&limits, cause, n.ms) {
            continue;
        }
        if canonical_rule(&scope) {
            out.insert(scope);
        }
    }
    Ok(out.into_iter().collect())
}

/// `GET /agent/tool-allows`.
pub async fn tool_allows(
    State(pool): State<Arc<PgPool>>,
    RequireAccount(me, auth): RequireAccount,
    RawQuery(raw): RawQuery,
) -> Response {
    if !through_operator(&me, &auth) {
        return json_err(StatusCode::FORBIDDEN, "forbidden", FORBIDDEN);
    }
    let Some(q) = parse_query(raw.as_deref(), &["channelId"], &["cause"]) else {
        return json_err(StatusCode::BAD_REQUEST, "bad_request", TOOL_BAD);
    };
    let channel = q[0].as_deref().unwrap_or_default();
    let operator = auth
        .operator
        .as_ref()
        .map(|o| o.id.as_str())
        .unwrap_or_default();
    let run = async {
        let n = now(&pool).await?;
        let granted = tool_allows_for(&pool, &me.id, channel, &n).await?;
        let lines = match q[1].as_deref() {
            Some(cause) => {
                mandate_tool_rules_for(&pool, &me.id, operator, channel, cause, &n).await?
            }
            None => vec![],
        };
        let reach = tool_reach_for(&pool, &me.id, &n).await?;
        let rules = js_sorted(granted.into_iter().chain(lines.iter().cloned()));
        let reach = js_sorted(reach.into_iter().chain(lines));
        Ok::<_, sqlx::Error>(json!({ "rules": rules, "reach": reach }))
    };
    match run.await {
        Ok(v) => ok_no_store(&v),
        Err(e) => internal(e),
    }
}

/// `GET /agent/command-grants`.
pub async fn command_grants(
    State(pool): State<Arc<PgPool>>,
    RequireAccount(me, auth): RequireAccount,
    RawQuery(raw): RawQuery,
) -> Response {
    if !through_operator(&me, &auth) {
        return json_err(StatusCode::FORBIDDEN, "forbidden", FORBIDDEN);
    }
    let Some(q) = parse_query(raw.as_deref(), &["channelId", "threadRootId"], &[]) else {
        return json_err(StatusCode::BAD_REQUEST, "bad_request", GRANTS_BAD);
    };
    let run = async {
        let n = now(&pool).await?;
        let text: String = sqlx::query_scalar(sql().grants.as_str())
            .bind(&me.id)
            .bind(q[0].as_deref())
            .bind(q[1].as_deref())
            .bind(&n.txt)
            .fetch_one(&*pool)
            .await?;
        Ok::<_, sqlx::Error>(text)
    };
    let text = match run.await {
        Ok(t) => t,
        Err(e) => return internal(e),
    };
    let rows: Vec<Value> = serde_json::from_str(&text).unwrap_or_default();
    let mut grants = Vec::new();
    for r in rows {
        let command = r["command"].as_str().unwrap_or_default();
        if !canonical_command(command) {
            continue;
        }
        grants.push(format!(
            "{{\"id\":{},\"command\":{},\"singleUse\":{},\"expiresAt\":{}}}",
            r["id"], r["command"], r["singleUse"], r["expiresAt"]
        ));
    }
    let body = format!("{{\"grants\":[{}]}}", grants.join(","));
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/json; charset=utf-8"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        body,
    )
        .into_response()
}

/// 코어 라우터에 합칠 줄 — 읽기 풀만 쓴다(`decide_check.rs` 와 같은 길: 인증은 `route_layer`, CORS 는 `layer`).
pub fn routes(
    pool: PgPool,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<PgPool>>::new()
        .get("/agent/tool-allows", tool_allows)
        .get("/agent/command-grants", command_grants)
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

    const C: &str = "1f8fad5b-d9cb-469f-a165-70867728950e";
    const T: &str = "2f8fad5b-d9cb-469f-a165-70867728950e";

    #[test]
    fn query_like_zod() {
        let one = |raw: &str| parse_query(Some(raw), &["channelId"], &["cause"]);
        assert_eq!(
            one(&format!("channelId={C}")),
            Some(vec![Some(C.into()), None])
        );
        assert_eq!(
            one(&format!("channelId={C}&cause={T}&x=1")),
            Some(vec![Some(C.into()), Some(T.into())])
        );
        assert_eq!(one(""), None, "channelId 없음");
        assert_eq!(one(&format!("channelId={C}&cause=")), None, "빈 cause");
        assert_eq!(
            one(&format!("channelId={C}&channelId={C}")),
            None,
            "같은 키 둘"
        );
        assert_eq!(
            parse_query(
                Some(&format!("channelId={C}")),
                &["channelId", "threadRootId"],
                &[]
            ),
            None
        );
    }

    #[test]
    fn limits_follow_ts() {
        let now = iso_ms("2026-11-16T06:00:00.000Z").unwrap();
        assert!(limits_allow(&json!({}), "c", now));
        assert!(limits_allow(&Value::Null, "c", now));
        assert!(!limits_allow(&json!({ "uses": 1 }), "c", now));
        assert!(
            !limits_allow(&json!({ "uses": null }), "c", now),
            "키만 있어도"
        );
        assert!(limits_allow(&json!({ "turnCause": "c" }), "c", now));
        assert!(!limits_allow(&json!({ "turnCause": "d" }), "c", now));
        assert!(limits_allow(
            &json!({ "until": "2026-11-16T06:00:00.001Z" }),
            "c",
            now
        ));
        assert!(!limits_allow(
            &json!({ "until": "2026-11-16T06:00:00.000Z" }),
            "c",
            now
        ));
        assert!(!limits_allow(&json!({ "until": "x" }), "c", now));
        assert!(!limits_allow(&json!({ "until": null }), "c", now));
    }

    #[test]
    fn iso_round() {
        assert_eq!(iso_ms("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(iso_ms("1970-01-01T00:00:01Z"), Some(1000));
        assert_eq!(iso_ms("1970-01-01 00:00:01Z"), None);
    }

    #[test]
    fn js_sort_is_utf16() {
        // U+FF61(BMP, 코드 단위 0xFF61) 은 U+1F600(서로게이트 0xD83D…) 보다 UTF-16 으로는 뒤, UTF-8 로는 앞.
        let v = js_sorted([
            "\u{FF61}".to_string(),
            "\u{1F600}".to_string(),
            "a".into(),
            "a".into(),
        ]);
        assert_eq!(
            v,
            vec!["a".to_string(), "\u{1F600}".into(), "\u{FF61}".into()]
        );
    }
}
