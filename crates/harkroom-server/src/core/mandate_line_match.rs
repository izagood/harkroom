//! TS `capabilities.ts::lineLive` + merge `matches` + `lineMatches` — 위임장 줄(`mandate_line`·상시 줄)이 이 머지를 덮는가.
//!
//! merge-checks 의 위임장 달린 임대(`findLine`)와 위임 켜짐(`mandateEnforced`) 갈래가 쓸 순수 판정이다. 두 갈래 모두 merge-checks 에 물렸다(`find_line`·`consume_line`) —
//! 읽고 쓰는 열은 [`MERGE_CHECKS_MANDATE_PRIVILEGES`] 에 열 단위로 적어 둔다.

use super::merge_approval_peek::repo_scope;
use serde_json::Value;

/// `findLine`(`validMandateOwner`·`listMandateLines`·에이전트 소유자 대조)이 읽는 열. 하나라도 없으면 그 갈래는 TS 로 넘긴다.
pub const MERGE_CHECKS_MANDATE_PRIVILEGES: &[(&str, &str)] = &[
    ("mandate.id", "SELECT"),
    ("mandate.owner_account_id", "SELECT"),
    ("mandate.delegator_account_id", "SELECT"),
    ("mandate.channel_id", "SELECT"),
    ("mandate.ended_at", "SELECT"),
    ("mandate.automation_id", "SELECT"),
    ("mandate.last_activity_at", "SELECT"),
    ("automation.id", "SELECT"),
    ("automation.deleted_at", "SELECT"),
    ("automation.enabled", "SELECT"),
    ("automation.approved_at", "SELECT"),
    ("mandate_line.id", "SELECT"),
    ("mandate_line.mandate_id", "SELECT"),
    ("mandate_line.cap", "SELECT"),
    ("mandate_line.scope", "SELECT"),
    ("mandate_line.limits", "SELECT"),
    ("mandate_line.agent_ids", "SELECT"),
    ("mandate_line.granted_by", "SELECT"),
    ("mandate_line.via", "SELECT"),
    ("mandate_line.request_id", "SELECT"),
    ("mandate_line.used_count", "SELECT"),
    ("mandate_line.created_at", "SELECT"),
    ("mandate_line.revoked_at", "SELECT"),
    ("agent_config.account_id", "SELECT"),
    ("agent_config.owner_account_id", "SELECT"),
    ("account_grant.id", "SELECT"),
    ("account_grant.account_id", "SELECT"),
    ("account_grant.capability", "SELECT"),
    ("account_grant.scope", "SELECT"),
    ("account_grant.granted_by", "SELECT"),
    ("account_grant.granted_at", "SELECT"),
    ("account_grant.expires_at", "SELECT"),
];

/// 위임 켜짐(`consumeLine`) 갈래가 더 쓰는 열 — 저장된 줄의 `used_count` 를 한 문장에서 센다.
pub const MERGE_CHECKS_ENFORCE_PRIVILEGES: &[(&str, &str)] =
    &[("mandate_line.used_count", "UPDATE")];

/// 대조에 필요한 줄의 모양(TS `LineFacts`). `limits` 는 저장된 jsonb 그대로.
pub struct LineFacts<'a> {
    pub cap: &'a str,
    pub scope: &'a str,
    pub limits: &'a Value,
    pub used_count: i64,
    pub revoked: bool,
}

/// TS merge `CapAction`.
pub struct MergeAction<'a> {
    pub repo: &'a str,
    pub pr: Option<i64>,
    pub head: Option<&'a str>,
    pub gh_user: Option<&'a str>,
    pub ci_override: bool,
}

fn limit<'a>(l: &'a Value, k: &str) -> Option<&'a Value> {
    // TS 는 `!== undefined` 로 본다 — jsonb 에 null 로 적힌 값도 "있음"이다.
    l.as_object().and_then(|o| o.get(k))
}

/// TS `lineLive`. `until` 은 `Date.parse` 대신 RFC 3339 로 읽는다(서버가 `toISOString` 으로 적는다). 못 읽으면 죽은 줄.
pub fn line_live(line: &LineFacts<'_>, now_ms: i64) -> bool {
    if line.revoked {
        return false;
    }
    if let Some(u) = limit(line.limits, "until") {
        let t = u
            .as_str()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|d| d.timestamp_millis());
        match t {
            Some(t) if t > now_ms => {}
            _ => return false,
        }
    }
    if let Some(u) = limit(line.limits, "uses") {
        match u.as_f64() {
            Some(n) if (line.used_count as f64) < n => {}
            _ => return false,
        }
    }
    true
}

/// TS `REPO_ORG_SCOPE_RE` (`^repo:[a-z0-9][a-z0-9._-]{0,99}/\*$`).
fn is_org_scope(s: &str) -> bool {
    let Some(owner) = s.strip_prefix("repo:").and_then(|r| r.strip_suffix("/*")) else {
        return false;
    };
    let b = owner.as_bytes();
    (1..=100).contains(&b.len())
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter().all(|&c| {
            c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'.' | b'_' | b'-')
        })
}

/// TS merge `matches`.
fn merge_matches(line: &LineFacts<'_>, a: &MergeAction<'_>) -> bool {
    let Some(want) = repo_scope(a.repo) else {
        return false;
    };
    // `orgScopeOf(want)` — want 는 이미 REPO_SCOPE_RE 를 지났다.
    let org = want.split_once('/').map(|(o, _)| format!("{o}/*"));
    let hit =
        line.scope == want || (is_org_scope(line.scope) && org.as_deref() == Some(line.scope));
    if !hit {
        return false;
    }
    let l = line.limits;
    if let Some(p) = limit(l, "pr")
        && (p.as_f64() != a.pr.map(|n| n as f64) || a.pr.is_none())
    {
        return false;
    }
    if let Some(h) = limit(l, "head")
        && (h.as_str().is_none() || h.as_str() != a.head)
    {
        return false;
    }
    // TS `if (l.ghUser && ...)` — 빈 문자열·null 은 거짓.
    if let Some(g) = limit(l, "ghUser")
        .and_then(Value::as_str)
        .filter(|g| !g.is_empty())
        && a.gh_user.unwrap_or("").to_lowercase() != g.to_lowercase()
    {
        return false;
    }
    !a.ci_override || limit(l, "ciOverride") == Some(&Value::Bool(true))
}

/// TS `lineMatches` (cap `merge`).
pub fn merge_line_matches(line: &LineFacts<'_>, a: &MergeAction<'_>, now_ms: i64) -> bool {
    if line.cap != "merge" || !line_live(line, now_ms) {
        return false;
    }
    // TS `if (line.limits.turnCause)` — 참 같은 값이면 턴 하나짜리 줄이라 머지에 맞지 않는다.
    if limit(line.limits, "turnCause").is_some_and(super::merge_checks::js_truthy) {
        return false;
    }
    merge_matches(line, a)
}

/// TS `MANDATE_IDLE_MS`(7일).
const MANDATE_IDLE_MS: i64 = 7 * 86_400_000;

/// TS `repoGrantScope` — 정확한 저장소 또는 조직 전체(`repo:owner/*`). `raw` 는 이미 trim·소문자.
pub fn repo_grant_scope(raw: &str) -> Option<String> {
    repo_scope(raw).or_else(|| {
        let s = format!("repo:{}", raw.trim().to_lowercase());
        is_org_scope(&s).then_some(s)
    })
}

/// TS merge `validateScope`.
pub fn merge_validate_scope(scope: &str) -> Option<String> {
    let raw = scope.trim().to_lowercase();
    repo_grant_scope(raw.strip_prefix("repo:")?)
}

fn iso(ms: i64) -> Option<String> {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|d| d.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
}

/// 찾은 줄 — 그림자 감사의 `lineId`·`lineVia`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FoundLine {
    pub id: String,
    pub via: String,
}

/// 후보 한 줄(저장된 줄 또는 상시 줄).
struct Cand {
    id: String,
    cap: String,
    scope: String,
    limits: Value,
    agent_ids: Option<Vec<String>>,
    granted_by: String,
    via: String,
    used_count: i64,
    read_only: bool,
    created_at: Option<String>,
}

/// TS `consumeLine` 이 돌려준 줄 — 판정 응답·감사에 쓰는 칸만.
#[derive(Debug, Clone, PartialEq)]
pub struct ConsumedLine {
    pub id: String,
    pub via: String,
    pub granted_by: String,
    pub limits: Value,
    /// `new Date(createdAt).toISOString()` 모양.
    pub created_at: Option<String>,
}

impl ConsumedLine {
    /// TS `line.limits?.ghUser ?? null`.
    pub fn gh_user(&self) -> Value {
        match limit(&self.limits, "ghUser") {
            Some(Value::Null) | None => Value::Null,
            Some(v) => v.clone(),
        }
    }
    /// TS `line.limits?.ciOverride === true`.
    pub fn ci_override(&self) -> bool {
        limit(&self.limits, "ciOverride") == Some(&Value::Bool(true))
    }
}

/// TS `consumeLine` 의 저장된 줄 한 문장 — 회수·until·uses 를 다시 보고 `used_count` 를 하나 센다. 0줄이면 다음 후보.
const CONSUME_SQL: &str = "update mandate_line set used_count = used_count + 1 \
      where id = $1::uuid and revoked_at is null \
        and (limits->>'until' is null or (limits->>'until')::timestamptz > $2::timestamptz) \
        and (limits->>'uses' is null or used_count < (limits->>'uses')::int) \
      returning id::text, via, granted_by::text, limits::text, \
        to_char(created_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')";

const AGENT_OWNER_SQL: &str =
    "select owner_account_id::text from agent_config where account_id = $1::uuid";
const MANDATE_ROW_SQL: &str = "select owner_account_id::text, coalesce(delegator_account_id, owner_account_id)::text, channel_id::text \
       from mandate where id = $1::uuid";
/// TS `listMandateLines` 의 상시 줄 문장(merge 판정이라 `repo.merge` 만 쓴다 — `tool.allow` 줄은 cap 이 달라 어차피 맞지 않는다).
const STANDING_SQL: &str = "select g.id::text, g.account_id::text, g.capability, g.scope, g.granted_by::text, \
            to_char(g.expires_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'), \
            to_char(g.granted_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') \
       from account_grant g join agent_config c on c.account_id = g.account_id \
      where c.owner_account_id = $1::uuid and g.granted_by = $3::uuid and g.capability in ('repo.merge', 'tool.allow') \
        and (g.expires_at is null or g.expires_at > $2::timestamptz) \
      order by g.granted_at, g.id";

fn stored_sql() -> &'static str {
    static S: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    S.get_or_init(|| {
        format!(
            "select t.id::text, t.cap, t.scope, t.limits::text, t.\"agentIds\"::text[], t.\"grantedBy\"::text, t.via, t.\"usedCount\"::int8, \
             to_char(t.\"createdAt\" at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') from ({}) t",
            crate::core::channels::frag("grant_mandate_lines_stored")
        )
    })
}
fn owner_sql() -> &'static str {
    static S: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    S.get_or_init(|| {
        format!(
            "select t.owner::text from ({}) t",
            crate::core::channels::frag("grant_valid_mandate_owner")
        )
    })
}

type StoredRow = (
    String,
    String,
    String,
    Option<String>,
    Option<Vec<String>>,
    String,
    String,
    i64,
    Option<String>,
);
type StandingRow = (
    String,
    String,
    String,
    String,
    String,
    Option<String>,
    Option<String>,
);

/// TS `findLine(pool, { mandateId, agentId, cap: 'merge', action, now })` — 읽기만 한다. 위임장이 없거나 유효하지 않으면 `None`.
/// 부르는 쪽은 [`MERGE_CHECKS_MANDATE_PRIVILEGES`] 가 다 있을 때만 부른다.
pub async fn find_line(
    pool: &sqlx::PgPool,
    mandate: Option<&str>,
    agent: &str,
    action: &MergeAction<'_>,
    now_ms: i64,
) -> sqlx::Result<Option<FoundLine>> {
    Ok(candidate_lines(pool, mandate, agent, action, now_ms)
        .await?
        .into_iter()
        .next()
        .map(|l| FoundLine {
            id: l.id,
            via: l.via,
        }))
}

/// TS `consumeLine(pool, { mandateId, agentId, cap: 'merge', action, now })` — 후보를 차례로 보며 상시 줄은 그대로,
/// 저장된 줄은 [`CONSUME_SQL`] 한 문장으로 센다. 부르는 쪽은 [`MERGE_CHECKS_MANDATE_PRIVILEGES`]·[`MERGE_CHECKS_ENFORCE_PRIVILEGES`] 가 다 있을 때만 부른다.
pub async fn consume_line(
    pool: &sqlx::PgPool,
    mandate: Option<&str>,
    agent: &str,
    action: &MergeAction<'_>,
    now_ms: i64,
) -> sqlx::Result<Option<ConsumedLine>> {
    let Some(now_txt) = iso(now_ms) else {
        return Ok(None);
    };
    for l in candidate_lines(pool, mandate, agent, action, now_ms).await? {
        if l.read_only {
            return Ok(Some(ConsumedLine {
                id: l.id,
                via: l.via,
                granted_by: l.granted_by,
                limits: l.limits,
                created_at: l.created_at,
            }));
        }
        type Row = (String, String, String, Option<String>, Option<String>);
        let row: Option<Row> = sqlx::query_as(CONSUME_SQL)
            .bind(&l.id)
            .bind(&now_txt)
            .fetch_optional(pool)
            .await?;
        if let Some((id, via, granted_by, limits, created_at)) = row {
            return Ok(Some(ConsumedLine {
                id,
                via,
                granted_by,
                limits: parse_limits(limits.as_deref()),
                created_at,
            }));
        }
    }
    Ok(None)
}

fn parse_limits(s: Option<&str>) -> Value {
    s.and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or(Value::Null)
}

/// TS `candidateLines` — 맞는 후보 전부(순서 그대로, C-3 까지 거른 것).
async fn candidate_lines(
    pool: &sqlx::PgPool,
    mandate: Option<&str>,
    agent: &str,
    action: &MergeAction<'_>,
    now_ms: i64,
) -> sqlx::Result<Vec<Cand>> {
    let Some(mandate) = mandate else {
        return Ok(vec![]);
    };
    let (Some(now_txt), Some(cutoff)) = (iso(now_ms), iso(now_ms - MANDATE_IDLE_MS)) else {
        return Ok(vec![]);
    };
    let owner: Option<(String,)> = sqlx::query_as(owner_sql())
        .bind(mandate)
        .bind(&cutoff)
        .fetch_optional(pool)
        .await?;
    let Some((owner,)) = owner else {
        return Ok(vec![]);
    };
    let agent_owner: Option<(Option<String>,)> = sqlx::query_as(AGENT_OWNER_SQL)
        .bind(agent)
        .fetch_optional(pool)
        .await?;
    if agent_owner.and_then(|(o,)| o).as_deref() != Some(owner.as_str()) {
        return Ok(vec![]);
    }
    // listMandateLines
    let m: Option<(String, String, String)> = sqlx::query_as(MANDATE_ROW_SQL)
        .bind(mandate)
        .fetch_optional(pool)
        .await?;
    let Some((m_owner, delegator, channel)) = m else {
        return Ok(vec![]);
    };
    let stored: Vec<StoredRow> = sqlx::query_as(stored_sql())
        .bind(mandate)
        .fetch_all(pool)
        .await?;
    let mut cands: Vec<Cand> = stored
        .into_iter()
        .map(
            |(id, cap, scope, limits, agent_ids, granted_by, via, used_count, created_at)| Cand {
                id,
                cap,
                scope,
                limits: limits
                    .as_deref()
                    .and_then(|s| serde_json::from_str(s).ok())
                    .unwrap_or(Value::Null),
                agent_ids,
                granted_by,
                via,
                used_count,
                read_only: false,
                created_at,
            },
        )
        .collect();
    if delegator == m_owner {
        let grants: Vec<StandingRow> = sqlx::query_as(STANDING_SQL)
            .bind(&m_owner)
            .bind(&now_txt)
            .bind(&delegator)
            .fetch_all(pool)
            .await?;
        cands.extend(standing_lines(grants));
    }
    let lines: Vec<Cand> = cands
        .into_iter()
        .filter(|l| {
            l.cap != "bypass"
                && l.agent_ids
                    .as_ref()
                    .is_none_or(|ids| ids.iter().any(|a| a == agent))
        })
        .filter(|l| {
            let f = LineFacts {
                cap: &l.cap,
                scope: &l.scope,
                limits: &l.limits,
                used_count: l.used_count,
                revoked: false,
            };
            merge_line_matches(&f, action, now_ms)
        })
        .collect();
    // C-3: 소유자가 아닌 사람이 준 저장된 줄은 그 사람이 지금도 이 위임장 채널에서 정할 수 있을 때만.
    let mut still: std::collections::HashMap<String, bool> = std::collections::HashMap::new();
    let mut out = Vec::with_capacity(lines.len());
    for l in lines {
        if l.read_only || l.granted_by == owner {
            out.push(l);
            continue;
        }
        let ok = match still.get(&l.granted_by) {
            Some(v) => *v,
            None => {
                let mut conn = pool.acquire().await?;
                let v = super::decide_core::may_decide_for_unlocked(
                    &mut conn,
                    agent,
                    &l.granted_by,
                    Some(&channel),
                )
                .await?
                .ok
                .is_some();
                still.insert(l.granted_by.clone(), v);
                v
            }
        };
        if ok {
            out.push(l);
        }
    }
    Ok(out)
}

/// TS `listMandateLines` 의 상시 줄 펼치기(merge 만). 정규형이 아닌 scope 는 건너뛴다.
fn standing_lines(grants: Vec<StandingRow>) -> Vec<Cand> {
    grants
        .into_iter()
        .filter(|g| g.2 == "repo.merge")
        .filter_map(
            |(id, agent_id, _, scope, granted_by, expires, granted_at)| {
                let scope = merge_validate_scope(&scope)?;
                let limits = match expires {
                    Some(e) => serde_json::json!({ "until": e }),
                    None => serde_json::json!({}),
                };
                Some(Cand {
                    id,
                    cap: "merge".into(),
                    scope,
                    limits,
                    agent_ids: Some(vec![agent_id]),
                    granted_by,
                    via: "standing".into(),
                    used_count: 0,
                    read_only: true,
                    created_at: granted_at,
                })
            },
        )
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn line<'a>(scope: &'a str, limits: &'a Value) -> LineFacts<'a> {
        LineFacts {
            cap: "merge",
            scope,
            limits,
            used_count: 0,
            revoked: false,
        }
    }
    fn act(repo: &str) -> MergeAction<'_> {
        MergeAction {
            repo,
            pr: Some(7),
            head: Some("h"),
            gh_user: None,
            ci_override: false,
        }
    }
    const NOW: i64 = 1_800_000_000_000;

    #[test]
    fn scope_like_ts() {
        let e = json!({});
        assert!(merge_line_matches(&line("repo:o/r", &e), &act("O/R "), NOW));
        assert!(merge_line_matches(&line("repo:o/*", &e), &act("o/r"), NOW));
        assert!(!merge_line_matches(&line("repo:x/*", &e), &act("o/r"), NOW));
        assert!(!merge_line_matches(
            &line("repo:o/r2", &e),
            &act("o/r"),
            NOW
        ));
        assert!(!merge_line_matches(&line("repo:o/*", &e), &act("o/*"), NOW));
        let mut l = line("repo:o/r", &e);
        l.cap = "tool";
        assert!(!merge_line_matches(&l, &act("o/r"), NOW));
    }

    #[test]
    fn live_like_ts() {
        let e = json!({});
        let mut l = line("repo:o/r", &e);
        l.revoked = true;
        assert!(!merge_line_matches(&l, &act("o/r"), NOW));
        let u = json!({"uses": 2});
        let mut l = line("repo:o/r", &u);
        l.used_count = 1;
        assert!(merge_line_matches(&l, &act("o/r"), NOW));
        l.used_count = 2;
        assert!(!merge_line_matches(&l, &act("o/r"), NOW));
        let bad = json!({"uses": "2"});
        assert!(!merge_line_matches(
            &line("repo:o/r", &bad),
            &act("o/r"),
            NOW
        ));
        let fut = json!({"until": "2030-01-01T00:00:00.000Z"});
        let past = json!({"until": "2020-01-01T00:00:00.000Z"});
        let junk = json!({"until": "nope"});
        assert!(merge_line_matches(
            &line("repo:o/r", &fut),
            &act("o/r"),
            NOW
        ));
        assert!(!merge_line_matches(
            &line("repo:o/r", &past),
            &act("o/r"),
            NOW
        ));
        assert!(!merge_line_matches(
            &line("repo:o/r", &junk),
            &act("o/r"),
            NOW
        ));
        let tc = json!({"turnCause": "m1"});
        assert!(!merge_line_matches(
            &line("repo:o/r", &tc),
            &act("o/r"),
            NOW
        ));
        let tc0 = json!({"turnCause": ""});
        assert!(merge_line_matches(
            &line("repo:o/r", &tc0),
            &act("o/r"),
            NOW
        ));
    }

    #[test]
    fn limits_like_ts() {
        let pr = json!({"pr": 7, "head": "h"});
        assert!(merge_line_matches(&line("repo:o/r", &pr), &act("o/r"), NOW));
        let pr8 = json!({"pr": 8});
        assert!(!merge_line_matches(
            &line("repo:o/r", &pr8),
            &act("o/r"),
            NOW
        ));
        let hd = json!({"head": "z"});
        assert!(!merge_line_matches(
            &line("repo:o/r", &hd),
            &act("o/r"),
            NOW
        ));
        let gh = json!({"ghUser": "Bot"});
        assert!(!merge_line_matches(
            &line("repo:o/r", &gh),
            &act("o/r"),
            NOW
        ));
        let mut a = act("o/r");
        a.gh_user = Some("bot");
        assert!(merge_line_matches(&line("repo:o/r", &gh), &a, NOW));
        let ghn = json!({"ghUser": null});
        assert!(merge_line_matches(
            &line("repo:o/r", &ghn),
            &act("o/r"),
            NOW
        ));
        let mut a = act("o/r");
        a.ci_override = true;
        let e = json!({});
        assert!(!merge_line_matches(&line("repo:o/r", &e), &a, NOW));
        let ci = json!({"ciOverride": true});
        assert!(merge_line_matches(&line("repo:o/r", &ci), &a, NOW));
    }

    #[test]
    fn validate_scope_like_ts() {
        assert_eq!(
            merge_validate_scope(" REPO:O/R ").as_deref(),
            Some("repo:o/r")
        );
        assert_eq!(
            merge_validate_scope("repo:o/*").as_deref(),
            Some("repo:o/*")
        );
        assert_eq!(merge_validate_scope("o/r"), None);
        assert_eq!(merge_validate_scope("repo:*"), None);
        assert_eq!(merge_validate_scope("repo:o/ab*"), None);
    }

    #[test]
    fn standing_lines_like_ts() {
        let g = vec![
            (
                "g1".into(),
                "a".into(),
                "repo.merge".into(),
                "repo:O/R".into(),
                "o".into(),
                None,
                Some("2026-01-01T00:00:00.000Z".into()),
            ),
            (
                "g2".into(),
                "a".into(),
                "tool.allow".into(),
                "tool:c:x".into(),
                "o".into(),
                None,
                Some("2026-01-01T00:00:00.000Z".into()),
            ),
            (
                "g3".into(),
                "a".into(),
                "repo.merge".into(),
                "bad".into(),
                "o".into(),
                None,
                Some("2026-01-01T00:00:00.000Z".into()),
            ),
            (
                "g4".into(),
                "a".into(),
                "repo.merge".into(),
                "repo:o/*".into(),
                "o".into(),
                Some("2030-01-01T00:00:00.000Z".into()),
                None,
            ),
        ];
        let c = standing_lines(g);
        assert_eq!(c.len(), 2);
        assert_eq!(c[0].scope, "repo:o/r");
        assert_eq!(c[0].via, "standing");
        assert!(c[0].read_only);
        assert_eq!(c[0].agent_ids.as_deref(), Some(&["a".to_string()][..]));
        assert_eq!(c[1].limits["until"], "2030-01-01T00:00:00.000Z");
        // consumeLine 의 상시 줄 `createdAt` 은 grant 의 `grantedAt`.
        assert_eq!(c[0].created_at.as_deref(), Some("2026-01-01T00:00:00.000Z"));
        assert_eq!(c[1].created_at, None);
    }

    #[test]
    fn iso_like_to_iso_string() {
        assert_eq!(iso(0).as_deref(), Some("1970-01-01T00:00:00.000Z"));
        assert_eq!(
            iso(1_800_000_000_123).as_deref(),
            Some("2027-01-15T08:00:00.123Z")
        );
    }

    #[test]
    fn find_line_privileges_cover_sql() {
        for c in [
            "mandate.owner_account_id",
            "mandate.delegator_account_id",
            "mandate.channel_id",
            "agent_config.owner_account_id",
            "account_grant.expires_at",
            "account_grant.granted_at",
        ] {
            assert!(
                MERGE_CHECKS_MANDATE_PRIVILEGES.contains(&(c, "SELECT")),
                "{c}"
            );
        }
    }

    #[test]
    fn privileges_cover_line_cols() {
        for c in [
            "id",
            "mandate_id",
            "cap",
            "scope",
            "limits",
            "agent_ids",
            "granted_by",
            "via",
            "request_id",
            "used_count",
            "created_at",
            "revoked_at",
        ] {
            let k = format!("mandate_line.{c}");
            assert!(
                MERGE_CHECKS_MANDATE_PRIVILEGES.contains(&(k.as_str(), "SELECT")),
                "{k}"
            );
        }
    }
}
